import type { BandColor, LabColor, ReadDirection, ResistorReading } from '../../types.js';
import { rankBandColors } from '../bands/classify.js';
import { deltaE76 } from '../color/colorSpace.js';
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

/**
 * 確信度の内訳。**調査用**で、値の決定には使わない。
 *
 * 確信度が低い理由が「色が基準色から遠い（absolute）」のか
 * 「次点の解釈と僅差（margin）」のか「金属色を数字に読み替えた
 * （plausibility）」のかを切り分けられないと、式を直しようがない。
 */
export interface ConfidenceBreakdown {
  /** 採用した解釈のバンド 1 本あたり平均 ΔE */
  readonly meanDeltaE: number;
  /** 色としての絶対的な近さ 0..1 */
  readonly absolute: number;
  /** 次点の解釈との差 0..1 */
  readonly margin: number;
  /** 金属色を数字として読み替えたことによる減点 0..1 */
  readonly plausibility: number;
  /** バンド色の行方向のばらつき（ΔE2000 の最大）。測れなければ null */
  readonly verticalSpread: number | null;
  /** 次点との素のコスト差。次点が無ければ null */
  readonly runnerUpGap: number | null;
  /** 次点の解釈が指す抵抗値。次点が無ければ null */
  readonly runnerUpOhms: number | null;
  /** 次点が採用と**同じ値**を指しているか。同値なら僅差でも迷っていない */
  readonly runnerUpSameValue: boolean;
}

/** 同時デコードの結果。値に加えて「どう解釈したか」を持つ。 */
export interface JointReading extends ResistorReading {
  /** 採用したランと役割（runIndex の昇順） */
  readonly usedRuns: readonly UsedRun[];
  /** ノイズとして捨てたランの添字 */
  readonly droppedRuns: readonly number[];
  /** 確信度の内訳（調査用） */
  readonly breakdown: ConfidenceBreakdown;
}

/** 解析済みのラン。分類前の色（Lab）を持つ。 */
export interface JointRun {
  readonly lab: LabColor;
  readonly start: number;
  readonly end: number;
  /** 位置からの推測で挿入したラン。詳細は `bands/runs.ts` の `ColorRun` を見る。 */
  readonly metallicOnly?: boolean;
}

export interface JointOptions {
  readonly palette?: Palette;
  /**
   * バンド色の行方向のばらつき（`runScanSpreads` の最大値）。
   *
   * 与えると、大きいときに確信度を下げる（{@link VERTICAL_SPREAD_CONFIDENCE}）。
   * 値の決定には使わない。
   */
  readonly verticalSpread?: number | null;
  /**
   * 抵抗器の本体色（`identifyBody` の代表色）。
   *
   * 与えると、本体に近いラン（ΔE76 ≤ {@link METALLIC_BODY_DELTA_E}）を
   * **金属容疑**として扱う:
   *
   * - 色候補を金・銀に限る（カラーコード表の制約で数字にならない）
   * - 捨てるコストを 0 にする（本数合わせで解釈を歪めない）
   *
   * 金・銀は本体と色相が同じで明度だけ違うため（`docs/11`）、色では数字
   * バンドと区別できない。学習パレットの金属色はアンカー依存の二峰性で
   * 棄却済み（`core/learning.ts`）。色ではなく位置づけで縛る。
   */
  readonly bodyLab?: LabColor | null;
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

/**
 * 本体との ΔE76 がこれ以下のランを金属容疑とみなす。
 *
 * 人手で確定した境界での実測: 金は本体と 4.1〜10.8、肩の照り返しは 10.6〜11.2。
 * いっぽう本体に最も近い**数字**バンドは灰の 14.7 で、色つきの数字は 26 以上。
 * 11 と 14.7 の間に境界を置く。
 */
const METALLIC_BODY_DELTA_E = 12;

/** スナップ偏差がこの値で適合スコアが尽きる（decode.ts と同じ水準）。 */
const SNAP_DEVIATION_LIMIT = 0.02;

/** 確信度の絶対項: 平均 ΔE がこの値で 0 になる。 */
const CONFIDENCE_DELTA_CEILING = 40;

/** 次点とのコスト差がこれだけ開いていれば「迷いなし」とみなす。 */
const CONFIDENCE_MARGIN_SCALE = 4;

/**
 * 許容差バンドの手前の間隔による方向の加点。
 *
 * IEC 60062 では許容差バンドを他より離して印刷する。実測でも
 * `15-339ohm` は間隔が 3 / 3 / 4 / **14** と、許容差の手前だけ 3.5 倍開く。
 *
 * ただし**単独では当てにならない**。`docs/07` では「許容差バンドの間隔で
 * 方向を決める」を試して 14 枚中 4 枚しか合わず 4 枚は逆だった。実測でも
 * 突出した間隔を持つ 4 枚のうち正しいのは 1 枚だけで、残りは検出の乱れ
 * （欠損・過分割）による見かけの間隔だった。
 *
 * そこで**方向を決める根拠にはせず、コストの一項として弱く足す**。
 * 色・E 系列・流通範囲の根拠が拮抗したときだけ効く。
 */
const SPACING_COST_SCALE = 1.5;

/**
 * バンドの並びの幾何が壊れているときの確信度の倍率。
 *
 * IEC 60062 は数字・倍率バンドを**等間隔**に印刷し、許容差バンドだけを
 * 離す。並びがこの形から外れているなら、ランの取りこぼしか過分割が
 * 起きている疑いが濃い。色がどれだけ基準色に近くても、見ているものが
 * バンドでなければ意味がない。
 *
 * `spacingCost` が「どちら向きに読むか」の根拠に間隔を使うのに対し、
 * こちらは**読みの当否そのもの**を疑う。コストではなく確信度に掛けるのは、
 * 解釈を選び直しても直らない（取りこぼしたバンドは戻ってこない）ため。
 *
 * 39 枚の実測で、正解と誤読が重ならない値を選んだ:
 *
 * | 指標 | 正解の最大 | 採用値 | 引っかかる誤読 |
 * | ------ | ------------ | -------- | ---------------- |
 * | 芯の間隔の変動係数 | 0.33 | 0.40 | `01-1ohm`（0.50） |
 * | 許容差の間隔 ÷ 芯の間隔 | 2.44 | 4 | `15-339ohm`（8.00） |
 *
 * この 2 枚は**保留のなかで最も確信度が高い誤読**（0.36 / 0.35）で、
 * 正解なのに保留になっている `05`（0.34）と `23`（0.33）を上回っていた。
 * 減点すると確信度の順序が正しくなる（正解 → 誤読の順に並ぶ）。
 */
const GEOMETRY_CONFIDENCE = 0.7;

/** 数字・倍率バンドの間隔の変動係数の上限。 */
const CORE_GAP_CV_LIMIT = 0.4;

/**
 * バンド色が行方向にばらついているときの確信度の倍率。
 *
 * バンドは本体の全高にわたる縦縞なので、**どの走査線も同じ色を見ているはず**。
 * 見ていないなら、鏡面反射で潰れているか、OBB の残留回転で行ごとに列位置が
 * ずれているか、そもそもバンドではないものを見ている。色の近さ（ΔE）とも
 * 次点とのマージンとも独立した情報で、`isGeometryNatural` と同じく
 * **読みの当否そのものを疑う**ものなのでコストではなく確信度に掛ける。
 *
 * 実測（`scripts/dbgScanSpread.ts`）では、ばらつきの最大値が誤答で中央 15.2
 * （最小 6.3）、正解で中央 5.5。**分布は重なる**ので単独では分離できないが、
 * 確信度の倍率としてなら差し引きが合う。しきい値 6・倍率 0.74 で
 * **誤答 5 → 2、正解は 32 のまま**（保留 11 → 14）。
 *
 * 平坦域（正解 32）は**しきい値 5〜6**で、その内側を採った。しきい値 4 以下は
 * 正解が落ち（31）、7 以上は誤答が 3 に増える。倍率は 0.70 で正解が 31 に落ち、
 * 0.74 以上は平坦。**しきい値の平坦域が 2 段ぶんしかない**ので、検体を足したら
 * 取り直すこと。詳細は `docs/14-走査線の多重化を測った結果.md`。
 */
const VERTICAL_SPREAD_CONFIDENCE = 0.74;

/** バンド色の行方向のばらつきがこれを超えたら減点する（ΔE2000）。 */
const VERTICAL_SPREAD_LIMIT = 6;

/** 許容差バンドの手前の間隔が、数字・倍率の間隔の何倍までなら自然か。 */
const TOLERANCE_GAP_RATIO_LIMIT = 4;

/** 許容差の手前の間隔が他の中央値のこの倍率を超えたら「離れている」とみなす。 */
const SPACING_DECISIVE_RATIO = 2;

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

/**
 * 色列を読み取り方向へ並べ替える。期待値の表で使う。
 *
 * `boundaries.json` の色列は画像上の並び（左から右）なので、そのままでは
 * 読み取り方向が分からない。`46-82kohm` は画像上 gold-orange-red-grey で、
 * この向きでは gold が数字バンドに来て**デコードできない**（IEC 60062 では
 * 金は倍率と許容差だけ）。逆向きなら grey-red-orange-gold = 82kΩ ±5% になる。
 *
 * そこで**デコードが成立する向き**を選ぶ。両方成立する／どちらも成立しない
 * ときは入力の向きを使う（判断できないときに黙って倒れる）。
 *
 * 色が 1 つでも確定していない、または本数が足りなければ null。
 */
function orientedFor(
  colors: readonly (BandColor | null)[],
): { readonly oriented: readonly BandColor[]; readonly useReversed: boolean } | null {
  const known = colors.filter((color): color is BandColor => color !== null);
  if (known.length !== colors.length || colors.length < MIN_BANDS) return null;

  const reversed = [...known].reverse();
  const useReversed = decodeBandSequence(known) === null && decodeBandSequence(reversed) !== null;

  return { oriented: useReversed ? reversed : known, useReversed };
}

/**
 * 色列を**読み取り方向を選んで**役割の文字列に直す。期待値の表で使う。
 *
 * 返す配列は**入力と同じ並び**（画像上の並び）なので、表の列とそのまま対応する。
 * 向きの決め方は {@link orientedFor} を参照。
 */
export function roleTextsFor(colors: readonly (BandColor | null)[]): string[] {
  const chosen = orientedFor(colors);
  if (chosen === null) return colors.map(() => '?');

  const roles = rolesFor(chosen.oriented);
  return colors.map((_, index) => {
    const at = chosen.useReversed ? colors.length - 1 - index : index;
    return (roles[at] as { roleText: string }).roleText;
  });
}

/**
 * 色列が表す抵抗値 [Ω]。デコードできなければ null。
 *
 * 期待値の表の見出しに「その色列なら何Ωか」を添えるために使う。
 * **向きの選び方は {@link roleTextsFor } と同じ**（同じ `orientedFor` を通す）。
 * 別々に決めると、表の意味の行と見出しの値が食い違う。
 *
 * 返すのは **E系列へスナップする前**の値。スナップは読み取りの揺れを丸めるため
 * の推測であって、人手で確定した色列には要らない。`15-339ohm` の
 * 橙-橙-白-黒（339Ω）がスナップで 340Ω になると、正解のはずのラベルが
 * 期待値と食い違って見える。
 */
export function decodedOhmsFor(colors: readonly (BandColor | null)[]): number | null {
  const chosen = orientedFor(colors);
  if (chosen === null) return null;

  return decodeBandSequence(chosen.oriented)?.rawOhms ?? null;
}

/** 上付きの数字（指数表記に使う）。 */
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
};

/**
 * 倍率を ×10⁸ / ×10⁻² のような指数表記にする。
 *
 * カラーコードの倍率は必ず 10 のべき乗なので、指数で書けば桁数によらず
 * 幅が一定になる。`×100,000,000` のような桁の羅列は表の列幅（58px）に
 * 収まらず、隣の列と重なっていた。
 *
 * ×1 と ×10 はそのまま書く（×10⁰ / ×10¹ より読みやすい）。
 */
function formatMultiplier(multiplier: number): string {
  if (multiplier === 1) return '×1';
  if (multiplier === 10) return '×10';

  const exponent = Math.round(Math.log10(multiplier));
  // 10 のべき乗でない値は来ない想定だが、来たら桁でそのまま出す
  if (!Number.isFinite(exponent) || 10 ** exponent !== multiplier) {
    return `×${multiplier >= 1 ? multiplier.toLocaleString('en-US') : String(multiplier)}`;
  }

  const digits = [...String(exponent)].map((char) => SUPERSCRIPT[char] ?? char).join('');
  return `×10${digits}`;
}

/**
 * 許容差バンドが「離れて印刷されている」かどうかによる方向の加点。
 *
 * 読み取り方向の末尾（＝許容差バンド）の手前の間隔が、他の間隔の中央値より
 * はっきり広ければ 0（加点なし）、逆側がはっきり広ければ罰を与える。
 * どちらとも言えなければ 0。**判断できないときに黙って倒れる**ようにする。
 */
function spacingCost(
  runs: readonly JointRun[],
  keptIndices: readonly number[],
  direction: ReadDirection,
  bandCount: number,
): number {
  // 許容差バンドを持たない読み（3 バンド）には効かせない
  if (bandCount < 4 || keptIndices.length < 4) return 0;

  const gaps: number[] = [];
  for (let i = 1; i < keptIndices.length; i += 1) {
    const previous = runs[keptIndices[i - 1] as number] as JointRun;
    const current = runs[keptIndices[i] as number] as JointRun;
    gaps.push(Math.max(0, current.start - previous.end));
  }
  if (gaps.length < 3) return 0;

  // 読み取り方向で末尾に来る側の間隔
  const tolGap = (direction === 'ltr' ? gaps[gaps.length - 1] : gaps[0]) as number;
  const others = (direction === 'ltr' ? gaps.slice(0, -1) : gaps.slice(1))
    .slice()
    .sort((a, b) => a - b);
  const median = others[others.length >> 1] as number;
  if (median <= 0) return 0;

  const ratio = tolGap / median;
  if (ratio >= SPACING_DECISIVE_RATIO) return 0;

  // 反対側が決定的に広いなら、この向きは不利
  const oppositeGap = (direction === 'ltr' ? gaps[0] : gaps[gaps.length - 1]) as number;
  if (oppositeGap / median >= SPACING_DECISIVE_RATIO) return SPACING_COST_SCALE;
  return 0;
}

/**
 * バンドの並びの幾何が、抵抗器として自然かどうか。
 *
 * 自然でなければ確信度を下げる（{@link GEOMETRY_CONFIDENCE}）。
 * 許容差バンドを持たない 3 バンドの読みには効かせない — 「離すべき間隔」が
 * 無いので、間隔の不揃いを異常と決めつけられないため。
 */
function isGeometryNatural(
  runs: readonly JointRun[],
  keptIndices: readonly number[],
  direction: ReadDirection,
  bandCount: number,
): boolean {
  if (bandCount < 4 || keptIndices.length < 4) return true;

  const gaps: number[] = [];
  for (let i = 1; i < keptIndices.length; i += 1) {
    const previous = runs[keptIndices[i - 1] as number] as JointRun;
    const current = runs[keptIndices[i] as number] as JointRun;
    gaps.push(Math.max(0, current.start - previous.end));
  }
  if (gaps.length < 3) return true;

  // 許容差バンドは読み取り方向の末尾に来る。その手前の間隔だけを分ける
  const toleranceGap = (direction === 'ltr' ? gaps[gaps.length - 1] : gaps[0]) as number;
  const core = direction === 'ltr' ? gaps.slice(0, -1) : gaps.slice(1);

  const mean = core.reduce((sum, gap) => sum + gap, 0) / core.length;
  if (mean <= 0) return true;

  const variance = core.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / core.length;
  if (Math.sqrt(variance) / mean > CORE_GAP_CV_LIMIT) return false;

  const sorted = [...core].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] as number;
  if (median <= 0) return true;

  return toleranceGap / median <= TOLERANCE_GAP_RATIO_LIMIT;
}

/** ランごとの色候補（近い順、遠すぎるものは除外）。 */
function candidatesFor(run: JointRun, palette: Palette): Candidate[] {
  const ranked = rankBandColors(run.lab, CANDIDATES_PER_RUN, palette);
  const best = ranked[0]?.deltaE ?? Number.POSITIVE_INFINITY;
  return ranked.filter((candidate) => candidate.deltaE <= best + CANDIDATE_DELTA_MARGIN);
}

/**
 * 金属容疑のランの色候補。金・銀だけに限る。
 *
 * カラーコード表の制約（金・銀は数字にならない）と組み合わさって、
 * このランは倍率・許容差にしかなれなくなる。数字が要る位置に来たら
 * 解釈自体が成立しないので、タダで捨てる側に倒れる。
 */
function metallicCandidatesFor(run: JointRun, palette: Palette): Candidate[] {
  return rankBandColors(run.lab, palette.entries.length, palette).filter((candidate) =>
    METALLIC_COLORS.has(candidate.color),
  );
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

/**
 * 保持するランの組み合わせ（ビットマスク）を列挙する。
 *
 * 金属容疑のラン（`freeDrop`）は落としても本数制限に数えない。
 * 金・銀か肩の照り返しなので、無いものとして扱っても解釈は歪まない。
 */
function keepMasks(count: number, freeDrop: readonly boolean[]): number[] {
  const masks: number[] = [];
  for (let mask = 0; mask < 1 << count; mask += 1) {
    let kept = 0;
    let dropped = 0;
    for (let bit = 0; bit < count; bit += 1) {
      if ((mask & (1 << bit)) !== 0) kept += 1;
      else if (freeDrop[bit] !== true) dropped += 1;
    }
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
  const bodyLab = options.bodyLab ?? null;
  // 本体に近いランは金属容疑（金・銀か肩の照り返し）。数字にしない・タダで捨てる。
  // 位置からの推測で挿入したランは、色が何であれ無条件に同じ扱いにする
  const bodyLike = capped.map(
    (run) =>
      run.metallicOnly === true ||
      (bodyLab !== null && deltaE76(run.lab, bodyLab) <= METALLIC_BODY_DELTA_E),
  );
  const candidates = capped.map((run, index) =>
    bodyLike[index] === true ? metallicCandidatesFor(run, palette) : candidatesFor(run, palette),
  );
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

  for (const mask of keepMasks(capped.length, bodyLike)) {
    const keptIndices: number[] = [];
    let droppedWidth = 0;
    for (let bit = 0; bit < capped.length; bit += 1) {
      const run = capped[bit] as JointRun;
      if ((mask & (1 << bit)) !== 0) keptIndices.push(bit);
      // 金属容疑はタダで捨てられる（幅をコストに入れない）
      else if (bodyLike[bit] !== true) droppedWidth += run.end - run.start;
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
          const spacing = spacingCost(capped, keptIndices, direction, oriented.length);
          consider({
            decoded,
            direction,
            cost: meanDeltaE + dropCost + snapCost + rankCost + rangeCost + spacing,
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
  // 次点との差は「コストの合計に対する割合」ではなく**固定の尺度**で測る。
  // 割合にすると、系列や流通範囲の事前分布を足したぶんだけ分母が膨らみ、
  // 同じ差でも確信度が下がってしまう（事前分布を入れた副作用で実際に起きた）。
  const margin =
    runnerUp === null ? 0.8 : clamp01((runnerUp.cost - chosen.cost) / CONFIDENCE_MARGIN_SCALE);
  // 色がどれだけ近くても、並びがバンドの形をしていなければ当てにならない
  const geometry = isGeometryNatural(
    capRuns(runs),
    chosen.keptIndices,
    chosen.direction,
    chosen.orientedColors.length,
  )
    ? 1
    : GEOMETRY_CONFIDENCE;
  // 行方向にばらついているなら、色がどれだけ近くても見ているものを疑う
  const verticalSpread = options.verticalSpread ?? null;
  const vertical =
    verticalSpread !== null && verticalSpread > VERTICAL_SPREAD_LIMIT
      ? VERTICAL_SPREAD_CONFIDENCE
      : 1;
  const plausibility =
    METALLIC_DIGIT_CONFIDENCE ** chosen.metallicDigits * geometry * vertical;
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
    breakdown: {
      meanDeltaE: chosen.meanDeltaE,
      absolute,
      margin,
      plausibility,
      verticalSpread,
      runnerUpGap: runnerUp === null ? null : runnerUp.cost - chosen.cost,
      runnerUpOhms: runnerUp === null ? null : runnerUp.decoded.ohms,
      runnerUpSameValue:
        runnerUp !== null &&
        Math.abs(runnerUp.decoded.ohms - chosen.decoded.ohms) / chosen.decoded.ohms < 1e-6,
    },
    usedRuns,
    droppedRuns,
  };
}
