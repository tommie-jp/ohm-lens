import type { ESeries } from '../../types.js';

/** E24 系列（許容差 ±5% 以上の抵抗器で使われる） */
export const E24_VALUES: readonly number[] = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6,
  6.2, 6.8, 7.5, 8.2, 9.1,
];

/** E96 系列（許容差 ±2% 以下の精密抵抗器で使われる） */
export const E96_VALUES: readonly number[] = [
  1.0, 1.02, 1.05, 1.07, 1.1, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.37, 1.4, 1.43, 1.47,
  1.5, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.0, 2.05, 2.1, 2.15, 2.21,
  2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67, 2.74, 2.8, 2.87, 2.94, 3.01, 3.09, 3.16, 3.24,
  3.32, 3.4, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53, 4.64, 4.75,
  4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.9, 6.04, 6.19, 6.34, 6.49, 6.65, 6.81, 6.98,
  7.15, 7.32, 7.5, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

/**
 * 許容差 [%] がこの値以下なら精密抵抗器とみなし E96 を使う。
 * 設計メモの方針: 金 ±5% → E24、茶 ±1% → E96。
 */
const PRECISION_TOLERANCE_THRESHOLD = 2;

/**
 * スナップ候補。系列の値に加え、隣接ディケードの端の値も含む。
 * 例: E24 で 9.9 は 9.1 より次ディケードの 10 (=1.0×10) が近い。
 * 対数距離で比較するので log も一緒に持っておく（呼び出しごとに再計算しない）。
 */
interface SnapCandidates {
  readonly values: Float64Array;
  readonly logs: Float64Array;
}

function buildCandidates(values: readonly number[]): SnapCandidates {
  const withNeighbours = [
    (values.at(-1) as number) / 10,
    ...values,
    (values[0] as number) * 10,
  ];
  return {
    values: Float64Array.from(withNeighbours),
    logs: Float64Array.from(withNeighbours, Math.log),
  };
}

const CANDIDATE_TABLE: Record<ESeries, SnapCandidates> = {
  E24: buildCandidates(E24_VALUES),
  E96: buildCandidates(E96_VALUES),
};

/** スナップ結果。deviation はスナップ前後の相対偏差（誤読検出に使う）。 */
export interface SnapResult {
  readonly ohms: number;
  readonly deviation: number;
}

/**
 * 許容差バンドから E 系列を決める。
 * E24+E96 の和集合にスナップすると格子が細かすぎて誤読棄却の効果が薄れるため、
 * 系列を先に絞ってからスナップする。
 *
 * @param tolerancePercent 許容差 [%]。許容差バンドが無い場合は null。
 */
export function seriesForTolerance(tolerancePercent: number | null): ESeries {
  if (tolerancePercent === null) return 'E24';
  return tolerancePercent <= PRECISION_TOLERANCE_THRESHOLD ? 'E96' : 'E24';
}

/**
 * 抵抗値を指定した E 系列の最近傍値にスナップする。
 * E 系列は対数的に等間隔なので、距離も対数空間で測る。
 *
 * @throws {TypeError} ohms が正の有限値でない場合
 */
export function snapToSeries(ohms: number, series: ESeries): SnapResult {
  if (!Number.isFinite(ohms) || ohms <= 0) {
    throw new TypeError(`ohms must be a positive finite number, got: ${ohms}`);
  }

  const { values, logs } = CANDIDATE_TABLE[series];
  const decade = Math.floor(Math.log10(ohms));
  const mantissa = ohms / 10 ** decade;
  const logMantissa = Math.log(mantissa);

  let best = values[0] as number;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const distance = Math.abs(logMantissa - (logs[i] as number));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = values[i] as number;
    }
  }

  const snapped = best * 10 ** decade;
  return { ohms: snapped, deviation: Math.abs(snapped - ohms) / ohms };
}

/**
 * E6 / E12 の値。E24 の部分集合で、市場に出回る数がまるで違う。
 * E6 は 20% 品、E12 は 10% 品の系列で、5% 品も実際には E12 の値が多い。
 */
const E6_VALUES: readonly number[] = [1.0, 1.5, 2.2, 3.3, 4.7, 6.8];
const E12_VALUES: readonly number[] = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];

/** 仮数が系列の値と一致するとみなす相対誤差。 */
const RANK_TOLERANCE = 0.005;

function includesMantissa(values: readonly number[], mantissa: number): boolean {
  return values.some((value) => Math.abs(value - mantissa) / value < RANK_TOLERANCE);
}

/**
 * その抵抗値がどの系列まで遡れるか（最も一般的な系列）を返す。
 *
 * E6 ⊂ E12 ⊂ E24 なので、E6 に載る値は E12 にも E24 にも載る。
 * 「E6 に載る」ほど市場に多い＝読み取り候補として尤もらしい。
 * どの系列にも載らなければ null。
 */
export function seriesRank(ohms: number): 'E6' | 'E12' | 'E24' | null {
  if (!Number.isFinite(ohms) || ohms <= 0) return null;
  const mantissa = ohms / 10 ** Math.floor(Math.log10(ohms));

  if (includesMantissa(E6_VALUES, mantissa)) return 'E6';
  if (includesMantissa(E12_VALUES, mantissa)) return 'E12';
  if (includesMantissa(E24_VALUES, mantissa)) return 'E24';
  return null;
}

/**
 * 軸形抵抗器として普通に流通する範囲 [Ω]。
 *
 * 1Ω 未満は電流検出用のシャント、100MΩ 超は絶縁計測用の特殊品で、
 * どちらもカラーコードで読む場面にはまず出てこない。読み取り候補が
 * この外に出たら、色をどこか読み違えている可能性が高い。
 */
const COMMON_MIN_OHMS = 1;
const COMMON_MAX_OHMS = 10_000_000;

/**
 * 普通に流通する範囲から何桁はみ出しているか。範囲内なら 0。
 * 桁で測るのは、抵抗値の誤読が倍率バンド 1 本＝1 桁ずつずれるため。
 */
export function decadesOutsideCommonRange(ohms: number): number {
  if (!Number.isFinite(ohms) || ohms <= 0) return 0;
  if (ohms > COMMON_MAX_OHMS) return Math.log10(ohms / COMMON_MAX_OHMS);
  if (ohms < COMMON_MIN_OHMS) return Math.log10(COMMON_MIN_OHMS / ohms);
  return 0;
}

/** どの系列でスナップしたかを含む結果。 */
export interface ToleranceSnapResult extends SnapResult {
  readonly series: ESeries;
}

/**
 * 許容差から系列を決めてスナップする。
 *
 * 精密品（E96）では **E96 ∪ E24** を候補にする。E96 に 4.70 は無いが
 * 4.7kΩ ±1% の抵抗器は実在するため、E96 だけで判定すると 4.75kΩ に
 * 誤スナップしてしまう。5% 品は E24 のみで判定し、格子を粗く保つことで
 * 誤読の棄却能力を維持する。
 */
export function snapForTolerance(
  ohms: number,
  tolerancePercent: number | null,
): ToleranceSnapResult {
  const primary = seriesForTolerance(tolerancePercent);
  const primaryResult = { ...snapToSeries(ohms, primary), series: primary };
  if (primary === 'E24') return primaryResult;

  const fallback = { ...snapToSeries(ohms, 'E24'), series: 'E24' as const };
  return fallback.deviation < primaryResult.deviation ? fallback : primaryResult;
}
