import type { BandColor, LabColor } from '../../types.js';
import { deltaE2000 } from '../color/colorSpace.js';
import { DEFAULT_PALETTE, type Palette } from '../color/palette.js';

/**
 * 抽出したランを、既知のバンド列に対応付ける。
 *
 * 較正では「正解の抵抗値」から期待されるバンド列が分かる。ところが実写真から
 * 取れるランには、鏡面反射・端のぼけ・背景の残りといった余分なものが混ざり、
 * 本数がぴったり一致することは少ない。本数一致を要求すると較正のサンプルが
 * ほとんど集まらないので、**余分なランを飛ばしながら**順序を保って対応付ける。
 *
 * 動的計画法で「全バンドを使い切る対応付け」のうち総コスト最小のものを選ぶ。
 * コストは基準色との ΔE で、幅の広いランほど割り引く（細いランは
 * ぼけや反射である可能性が高いため）。
 */

export interface AlignRun {
  readonly lab: LabColor;
  /** ランの幅。広いほど信用する。 */
  readonly width: number;
}

export interface AlignOptions {
  /** 飛ばしてよいランの最大数。既定は制限なし。 */
  readonly maxSkips?: number;
  /**
   * 飛ばしてよい**バンド**の最大数。既定は 0（従来どおり全バンドを使い切る）。
   *
   * 金・銀の許容差バンドは本体色に溶けてランとして出てこないことがある。
   * バンドを 1 本も飛ばせないと、存在しないバンドを必ずどれかのランに
   * 割り当ててしまい、余った背景のランが金として学習される
   * （実測では白い机が「金 = L\*125 のほぼ白」として 17 件）。
   *
   * **較正ではまだ有効にしていない。** 1 本飛ばせるようにすると白い机の
   * 誤学習は止まる（金 17 件 L\*125 → 3 件 L\*56）が、残った 3 件も本体
   * ベージュ寄り（b\*22、基準は b\*59）で、**今度は本体色として誤学習**する。
   * しかもそのずれ 38 は `learning.ts` の誤学習ガード（60）を通ってしまい、
   * パレットに入って誤答が 0 → 1 件に増える。ずれ 76 で弾かれていたのは
   * 偶然の安全弁だった。金を正しく学ぶにはまず `sample/labels.json` の
   * 人手ラベルが要る（有効化はその後）。
   */
  readonly maxBandSkips?: number;
  readonly palette?: Palette;
}

export interface Assignment {
  readonly runIndex: number;
  readonly color: BandColor;
}

export interface AlignResult {
  readonly assignments: readonly Assignment[];
  /** 総コスト（バンド 1 本あたりの平均 ΔE 相当）。小さいほど確からしい。 */
  readonly cost: number;
}

/** 幅がこの値を超えたら、それ以上は割引しない。 */
const WIDTH_SATURATION = 8;

/** 細いランに与える割増（コストを最大この倍率まで増やす）。 */
const NARROW_PENALTY = 2;

/**
 * バンドを 1 本飛ばすコスト（ΔE 相当）。
 *
 * **無料にすると「全バンドを飛ばす」が総コスト 0 の最適解になって退化する。**
 * 色がまるで違う対応付け（ΔE 40 前後）よりは安く、そこそこ合う対応付け
 * （ΔE 20 前後）よりは高い水準にして、「合う色が無いときだけ飛ばす」ようにする。
 */
const BAND_SKIP_COST = 30;

function matchCost(run: AlignRun, color: BandColor, palette: Palette): number {
  const delta = deltaE2000(run.lab, palette.colors[color]);
  const widthFactor = Math.min(1, Math.max(0, run.width) / WIDTH_SATURATION);
  // 幅が 0 に近いほどコストを NARROW_PENALTY 倍まで持ち上げる
  return delta * (NARROW_PENALTY - (NARROW_PENALTY - 1) * widthFactor);
}

/**
 * ランをバンド列に対応付ける。対応付けられなければ null。
 *
 * @param runs 抽出したラン（位置順に並んでいること）
 * @param bands 期待されるバンド色の列
 */
export function alignRunsToBands(
  runs: readonly AlignRun[],
  bands: readonly BandColor[],
  options: AlignOptions = {},
): AlignResult | null {
  if (runs.length === 0 || bands.length === 0) return null;

  const maxBandSkips = Math.min(options.maxBandSkips ?? 0, bands.length);
  if (runs.length < bands.length - maxBandSkips) return null;

  const maxSkips = options.maxSkips ?? runs.length;
  if (runs.length - bands.length > maxSkips) return null;

  const palette = options.palette ?? DEFAULT_PALETTE;

  // best[i][j][s] = 先頭 i 本のランで先頭 j 本のバンドを処理し、
  // うち s 本のバンドを飛ばしたときの最小コスト。
  // s を状態に持つのは、飛ばした本数の上限を経路ごとに守るため。
  const infinity = Number.POSITIVE_INFINITY;
  const width = maxBandSkips + 1;
  const size = (runs.length + 1) * (bands.length + 1) * width;
  const best = new Float64Array(size).fill(infinity);
  /** 0 = 未到達 / 1 = ランを飛ばした / 2 = 対応付けた / 3 = バンドを飛ばした */
  const cameFrom = new Uint8Array(size);
  const at = (i: number, j: number, s: number): number =>
    (i * (bands.length + 1) + j) * width + s;

  for (let i = 0; i <= runs.length; i += 1) best[at(i, 0, 0)] = 0;

  for (let i = 0; i <= runs.length; i += 1) {
    for (let j = 1; j <= bands.length; j += 1) {
      for (let s = 0; s <= maxBandSkips; s += 1) {
        let bestCost = infinity;
        let from = 0;

        // バンド j-1 を飛ばす（ランは消費しない）
        if (s > 0) {
          const previous = best[at(i, j - 1, s - 1)] as number;
          if (previous !== infinity) {
            bestCost = previous + BAND_SKIP_COST;
            from = 3;
          }
        }

        if (i > 0) {
          // ラン i-1 を余分とみなして飛ばす
          const skipped = best[at(i - 1, j, s)] as number;
          if (skipped < bestCost) {
            bestCost = skipped;
            from = 1;
          }

          // ラン i-1 をバンド j-1 に対応付ける
          const matched = best[at(i - 1, j - 1, s)] as number;
          if (matched !== infinity) {
            const cost =
              matched + matchCost(runs[i - 1] as AlignRun, bands[j - 1] as BandColor, palette);
            if (cost <= bestCost) {
              bestCost = cost;
              from = 2;
            }
          }
        }

        best[at(i, j, s)] = bestCost;
        cameFrom[at(i, j, s)] = from;
      }
    }
  }

  // 飛ばした本数ごとの最良を比べ、最小のものを採る
  let total = infinity;
  let skipsUsed = 0;
  for (let s = 0; s <= maxBandSkips; s += 1) {
    const candidate = best[at(runs.length, bands.length, s)] as number;
    if (candidate < total) {
      total = candidate;
      skipsUsed = s;
    }
  }
  if (!Number.isFinite(total)) return null;

  // 経路を復元する
  const assignments: Assignment[] = [];
  let i = runs.length;
  let j = bands.length;
  let s = skipsUsed;
  while (j > 0) {
    const step = cameFrom[at(i, j, s)] as number;
    if (step === 2) {
      assignments.push({ runIndex: i - 1, color: bands[j - 1] as BandColor });
      i -= 1;
      j -= 1;
    } else if (step === 3) {
      // 飛ばしたバンドは割り当てに含めない（存在しない色を学習しないため）
      j -= 1;
      s -= 1;
    } else if (step === 1) {
      i -= 1;
    } else {
      return null;
    }
  }
  assignments.reverse();

  // 期待バンド数で割る（対応付けた本数ではなく）。長さの違う候補列どうしを
  // 同じ尺度で比べられるようにするため。飛ばしたバンドのコストも分子に残る
  return { assignments, cost: total / bands.length };
}
