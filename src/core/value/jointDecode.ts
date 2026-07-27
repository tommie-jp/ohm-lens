import type { BandColor, LabColor, ReadDirection, ResistorReading } from '../../types.js';
import { rankBandColors } from '../bands/classify.js';
import { DEFAULT_PALETTE, type Palette } from '../color/palette.js';
import { clamp01 } from '../math.js';
import {
  digitOf,
  MAX_BANDS,
  MIN_BANDS,
  multiplierOf,
  tempCoefficientOf,
  toleranceOf,
} from './codeTable.js';
import { decadesOutsideCommonRange, seriesRank } from './eseries.js';
import { decodeBandSequence, type DecodedValue } from './decode.js';

/**
 * バンド列の同時デコード（joint decoding）。
 *
 * 人間が色帯を読むときは「茶か赤か迷うが、この並びで E24 に載るのは赤」と
 * **値の妥当性から色を逆算**する。独立に argmax 分類してからデコードすると
 * この情報が使えず、1 本の誤分類で全体が壊れる。
 *
 * ここでは各ランに色候補を複数残し、
 * - 基準色との ΔE2000（色としてのもっともらしさ）
 * - カラーコード表の制約（gold は数字バンドに置けない、など）
 * - E 系列への適合（スナップ偏差）
 * - 余分なランの除去コスト（幅が広いほど落としにくい）
 * を合算したコストが最小になる解釈を、両方向・全候補から選ぶ。
 */

/** バンドがカラーコード上で担う役割。 */
export type BandRole = 'digit' | 'multiplier' | 'tolerance' | 'tempco';

/** 採用したラン 1 本ぶんの解釈。デバッグ表示に使う。 */
export interface UsedRun {
  /** 入力したランの添字（画像上の並び順） */
  readonly runIndex: number;
  readonly color: BandColor;
  readonly role: BandRole;
  /** 役割の内容を表示用に整えた文字列（例: '2' '×10' '±5%' '50ppm'） */
  readonly roleText: string;
}

/** 同時デコードの結果。値に加えて「どう解釈したか」を持つ。 */
export interface JointReading extends ResistorReading {
  /** 採用したランと役割（runIndex の昇順） */
  readonly usedRuns: readonly UsedRun[];
  /** ノイズとして捨てたランの添字 */
  readonly droppedRuns: readonly number[];
}

/** 解析済みのラン。分類前の色（Lab）を持つ。 */
export interface JointRun {
  readonly lab: LabColor;
  readonly start: number;
  readonly end: number;
}

export interface JointOptions {
  readonly palette?: Palette;
}

/** ランごとに残す色候補の数。 */
const CANDIDATES_PER_RUN = 3;

/** 最有力候補からこの ΔE 差を超える候補は捨てる（探索を減らす）。 */
const CANDIDATE_DELTA_MARGIN = 18;

/** 探索対象にするランの上限。超えたら幅の広い順に絞る。 */
const MAX_RUNS_CONSIDERED = 8;

/** 落としてよいランの最大本数。 */
const MAX_DROPPED_RUNS = 2;

/** ラン除去のコスト。落とした幅の合計 ÷ 全体幅に掛かる（ΔE 相当の単位）。 */
const DROP_COST_SCALE = 30;

/** E 系列スナップ偏差のコスト係数。deviation / SNAP_LIMIT に掛かる。 */
const SNAP_COST_SCALE = 12;

/**
 * 系列の一般性による加点。E6 ⊂ E12 ⊂ E24 で、市場に出回る数がまるで違う。
 *
 * 色が紛らわしくて 2 通りに読める（1MΩ と 1.1MΩ、220Ω と 1.2kΩ）とき、
 * どちらも E24 に載るのでスナップ偏差では差がつかない。実物は E6・E12 の
 * 値が圧倒的に多いので、そちらを優先する。
 */
const SERIES_RANK_COST: Record<'E6' | 'E12' | 'E24', number> = { E6: 0, E12: 1, E24: 2 };

/** 系列に載らない値の加点（E24 よりさらに不自然）。 */
const OFF_SERIES_COST = 3;

/** 系列の一般性のコスト係数。 */
const SERIES_RANK_SCALE = 1.5;

/**
 * 流通範囲から外れた値の 1 桁あたりの加点。
 *
 * 誤読の多くは「白を倍率と読んで ×10^9」のように、桁が跳ねた形で出る
 * （実測では 390GΩ・82GΩ・33GΩ・100MΩ）。軸形抵抗器の実物は 1Ω〜10MΩ に
 * 収まるので、そこから離れるほど不自然とみなす。
 */
const OUT_OF_RANGE_SCALE = 1.2;

/** 流通範囲の加点の上限（離れすぎても頭打ちにする）。 */
const MAX_OUT_OF_RANGE_COST = 6;

/**
 * 金・銀は数字バンドにはならない（IEC 60062 では倍率と許容差だけ）。
 *
 * 最も近い色が金・銀のランを数字として読むには別の色へ読み替えることになる。
 * その読み替え自体は許す（本体ベージュを金と取り違えることがあるため）が、
 * **確信度は下げる**。物理的にありえない解釈に乗っているぶん、当たっている
 * 保証がない。読み替えが 1 本増えるごとに確信度を半分にする。
 */
const METALLIC_COLORS: ReadonlySet<BandColor> = new Set<BandColor>(['gold', 'silver']);

/** 金属色を数字として読み替えた本数 1 本あたりの確信度の倍率。 */
const METALLIC_DIGIT_CONFIDENCE = 0.5;

/** スナップ偏差がこの値で適合スコアが尽きる（decode.ts と同じ水準）。 */
const SNAP_DEVIATION_LIMIT = 0.02;

/** 確信度の絶対項: 平均 ΔE がこの値で 0 になる。 */
const CONFIDENCE_DELTA_CEILING = 40;

interface Candidate {
  readonly color: BandColor;
  readonly deltaE: number;
}

interface Interpretation {
  readonly decoded: DecodedValue;
  readonly direction: ReadDirection;
  readonly cost: number;
  readonly meanDeltaE: number;
  /** 金属色に最も近いランを数字として読み替えた本数 */
  readonly metallicDigits: number;
  /** 採用したランの添字（画像上の並び順） */
  readonly keptIndices: readonly number[];
  /** 読み取り方向に並べ替えた色列 */
  readonly orientedColors: readonly BandColor[];
}

/**
 * 色列の各位置がカラーコード上で担う役割を求める。
 *
 * 3/4 バンドは数字 2 桁、5/6 バンドは数字 3 桁。表示用の文字列は
 * `codeTable` から引くだけで、対応表をここに重複させない。
 */
function rolesFor(colors: readonly BandColor[]): { role: BandRole; roleText: string }[] {
  const digitCount = colors.length <= 4 ? 2 : 3;

  return colors.map((color, position) => {
    if (position < digitCount) {
      return { role: 'digit' as const, roleText: String(digitOf(color) ?? '?') };
    }
    if (position === digitCount) {
      return { role: 'multiplier' as const, roleText: formatMultiplier(multiplierOf(color)) };
    }
    if (position === digitCount + 1) {
      return { role: 'tolerance' as const, roleText: `±${toleranceOf(color) ?? '?'}%` };
    }
    return { role: 'tempco' as const, roleText: `${tempCoefficientOf(color) ?? '?'}ppm` };
  });
}

/** 倍率を ×10 / ×0.01 のように読める形にする。 */
function formatMultiplier(multiplier: number): string {
  return `×${multiplier >= 1 ? multiplier.toLocaleString('en-US') : String(multiplier)}`;
}

/** ランごとの色候補（近い順、遠すぎるものは除外）。 */
function candidatesFor(run: JointRun, palette: Palette): Candidate[] {
  const ranked = rankBandColors(run.lab, CANDIDATES_PER_RUN, palette);
  const best = ranked[0]?.deltaE ?? Number.POSITIVE_INFINITY;
  return ranked.filter((candidate) => candidate.deltaE <= best + CANDIDATE_DELTA_MARGIN);
}

/** 幅の広い順に上位を残す（元の並び順は保つ）。 */
function capRuns(runs: readonly JointRun[]): JointRun[] {
  if (runs.length <= MAX_RUNS_CONSIDERED) return [...runs];

  const widths = runs
    .map((run, index) => ({ index, width: run.end - run.start }))
    .sort((a, b) => b.width - a.width)
    .slice(0, MAX_RUNS_CONSIDERED)
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
  return widths.map((index) => runs[index] as JointRun);
}

/** 保持するランの組み合わせ（ビットマスク）を列挙する。 */
function keepMasks(count: number): number[] {
  const masks: number[] = [];
  for (let mask = 0; mask < 1 << count; mask += 1) {
    let kept = 0;
    for (let bit = 0; bit < count; bit += 1) if ((mask & (1 << bit)) !== 0) kept += 1;
    const dropped = count - kept;
    if (kept >= MIN_BANDS && kept <= MAX_BANDS && dropped <= MAX_DROPPED_RUNS) masks.push(mask);
  }
  return masks;
}

/**
 * ランの列から抵抗値を読み取る。読み取れなければ null。
 *
 * @param runs 本体を除いたバンド候補のラン（位置順）
 */
export function jointReadResistor(
  runs: readonly JointRun[],
  options: JointOptions = {},
): JointReading | null {
  if (runs.length < MIN_BANDS) return null;

  const palette = options.palette ?? DEFAULT_PALETTE;
  const capped = capRuns(runs);
  const candidates = capped.map((run) => candidatesFor(run, palette));
  const totalWidth = capped.reduce((sum, run) => sum + (run.end - run.start), 0);

  const decodeCache = new Map<string, DecodedValue | null>();
  const decode = (colors: readonly BandColor[]): DecodedValue | null => {
    const key = colors.join(',');
    let value = decodeCache.get(key);
    if (value === undefined) {
      value = decodeBandSequence(colors);
      decodeCache.set(key, value);
    }
    return value;
  };

  let best: Interpretation | null = null;
  let second: Interpretation | null = null;

  const consider = (interpretation: Interpretation): void => {
    if (best === null || interpretation.cost < best.cost) {
      // 同じ値の別解釈は「次点」として数えない（方向違いの同値など）
      if (best !== null && best.decoded.ohms !== interpretation.decoded.ohms) second = best;
      best = interpretation;
      return;
    }
    if (
      best.decoded.ohms !== interpretation.decoded.ohms &&
      (second === null || interpretation.cost < second.cost)
    ) {
      second = interpretation;
    }
  };

  for (const mask of keepMasks(capped.length)) {
    const keptIndices: number[] = [];
    let droppedWidth = 0;
    for (let bit = 0; bit < capped.length; bit += 1) {
      const run = capped[bit] as JointRun;
      if ((mask & (1 << bit)) !== 0) keptIndices.push(bit);
      else droppedWidth += run.end - run.start;
    }

    const dropCost = DROP_COST_SCALE * (droppedWidth / Math.max(1, totalWidth));

    // 色候補の全組み合わせを再帰で列挙（枝刈り付き）
    const colors: BandColor[] = new Array<BandColor>(keptIndices.length);
    const assign = (position: number, deltaSum: number): void => {
      const bound = best === null ? Number.POSITIVE_INFINITY : (best as Interpretation).cost;
      if (deltaSum / keptIndices.length + dropCost >= bound) return;

      if (position === keptIndices.length) {
        const meanDeltaE = deltaSum / keptIndices.length;
        for (const direction of ['ltr', 'rtl'] as const) {
          const oriented = direction === 'ltr' ? colors : [...colors].reverse();
          const decoded = decode(oriented);
          if (decoded === null) continue;
          const snapCost =
            SNAP_COST_SCALE * Math.min(2, decoded.snapDeviation / SNAP_DEVIATION_LIMIT);
          const rank = seriesRank(decoded.ohms);
          const rankCost =
            SERIES_RANK_SCALE * (rank === null ? OFF_SERIES_COST : SERIES_RANK_COST[rank]);
          const rangeCost = Math.min(
            MAX_OUT_OF_RANGE_COST,
            OUT_OF_RANGE_SCALE * decadesOutsideCommonRange(decoded.ohms),
          );
          // 金属色に最も近いランを数字として読み替えた本数（確信度を下げる）
          const digitCount = oriented.length <= 4 ? 2 : 3;
          let metallicDigits = 0;
          for (let position = 0; position < digitCount; position += 1) {
            const runIndex =
              direction === 'ltr' ? position : keptIndices.length - 1 - position;
            const nearest = (candidates[keptIndices[runIndex] as number] as Candidate[])[0];
            if (nearest !== undefined && METALLIC_COLORS.has(nearest.color)) metallicDigits += 1;
          }
          consider({
            decoded,
            direction,
            cost: meanDeltaE + dropCost + snapCost + rankCost + rangeCost,
            meanDeltaE,
            metallicDigits,
            keptIndices: [...keptIndices],
            orientedColors: [...oriented],
          });
        }
        return;
      }

      for (const candidate of candidates[keptIndices[position] as number] as Candidate[]) {
        colors[position] = candidate.color;
        assign(position + 1, deltaSum + candidate.deltaE);
      }
    };
    assign(0, 0);
  }

  if (best === null) return null;
  const chosen = best as Interpretation;
  const runnerUp = second as Interpretation | null;

  // 確信度: 色としての絶対的な近さ × 次点との差
  const absolute = Math.max(0, 1 - chosen.meanDeltaE / CONFIDENCE_DELTA_CEILING);
  const margin =
    runnerUp === null
      ? 0.8
      : clamp01((runnerUp.cost - chosen.cost) / Math.max(1, runnerUp.cost + chosen.cost));
  const plausibility = METALLIC_DIGIT_CONFIDENCE ** chosen.metallicDigits;
  const confidence = clamp01(absolute * (0.4 + 0.6 * margin) * plausibility);

  // 採用した解釈を「画像上の並び順」に戻す。rtl のときは役割が末尾から付く。
  const roles = rolesFor(chosen.orientedColors);
  const usedRuns: UsedRun[] = chosen.keptIndices.map((runIndex, position) => {
    const oriented = chosen.direction === 'ltr' ? position : chosen.keptIndices.length - 1 - position;
    return {
      runIndex,
      color: chosen.orientedColors[oriented] as BandColor,
      role: (roles[oriented] as { role: BandRole }).role,
      roleText: (roles[oriented] as { roleText: string }).roleText,
    };
  });

  const kept = new Set(chosen.keptIndices);
  const droppedRuns = capped
    .map((_, index) => index)
    .filter((index) => !kept.has(index));

  return {
    ohms: chosen.decoded.ohms,
    rawOhms: chosen.decoded.rawOhms,
    tolerance: chosen.decoded.tolerance,
    tempCoefficient: chosen.decoded.tempCoefficient,
    series: chosen.decoded.series,
    direction: chosen.direction,
    confidence,
    usedRuns,
    droppedRuns,
  };
}
