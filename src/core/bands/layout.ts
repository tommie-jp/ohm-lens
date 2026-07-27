import type { ColorRun } from './runs.js';

/**
 * バンドの並びが「抵抗器のカラーコードらしいか」を採点する。
 *
 * カラーコードは**本数が決まっていて（3〜6 本、温度係数つきで 7 本まで）
 * ほぼ等間隔・ほぼ等幅**に並ぶ。この規格を手がかりにすれば、検出枠が
 * 抵抗器の一部しか捉えていないことを「バンドの並びが不自然」として
 * 気づける。色を読む前の段階で使える、色に依存しない指標。
 */

/** IEC 60062 のカラーコードとして成立する本数の範囲。 */
export const MIN_BAND_COUNT = 3;
export const MAX_BAND_COUNT = 7;

/** ばらつきをどれだけ厳しく見るか（変動係数に掛ける）。 */
const SPACING_PENALTY = 1.6;
const WIDTH_PENALTY = 0.8;

/** 変動係数（標準偏差 ÷ 平均）。平均が 0 なら 0。 */
function variation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * バンドの並びを 0..1 で採点する。規格外の本数なら null。
 *
 * 1 に近いほど「等間隔・等幅」。バンドが 3 本のときは間隔が 2 つしか
 * 取れないので、間隔のばらつきは弱い手がかりにしかならない点に注意。
 */
export function bandLayoutScore(runs: readonly ColorRun[]): number | null {
  if (runs.length < MIN_BAND_COUNT || runs.length > MAX_BAND_COUNT) return null;

  const centers = runs.map((run) => (run.start + run.end) / 2);
  const widths = runs.map((run) => run.end - run.start);
  const gaps = centers.slice(1).map((center, index) => center - (centers[index] as number));

  const penalty = SPACING_PENALTY * variation(gaps) + WIDTH_PENALTY * variation(widths);
  return Math.max(0, 1 - penalty);
}
