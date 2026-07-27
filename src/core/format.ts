import type { ResistorReading } from '../types.js';

/**
 * 抵抗値の表示用フォーマットと、値を出してよいかの判定。
 * オーバーレイ描画（Phase 1 以降）とデバッグページで共有する。
 */

/**
 * この確信度を下回る読み取りは値を表示せず「?」にする。
 *
 * 誤った値を自信ありげに出すくらいなら読めないと言う、という方針
 * （設計メモ §2 [5]）。Phase 1 のオーバーレイと Phase 2 の時間方向投票も
 * この閾値を共有すること。
 *
 * `sample/` の 39 枚での実測。
 *
 * | 閾値 | 0 | 0.25 | 0.30 | 0.35 | **0.40** | 0.50 |
 * | ------ | --- | ------ | ------ | ------ | ---------- | ------ |
 * | 正解 | 30 | 30 | 30 | 28 | **28** | 27 |
 * | 誤答 | 8 | 5 | 2 | 2 | **1** | 1 |
 * | 保留 | 1 | 4 | 7 | 9 | **10** | 11 |
 *
 * 0.30 なら正解を 1 枚も落とさないが、誤答が 2 件残る。方針は「自信ありげに
 * 間違えない」なので、誤答が 1 件まで減る 0.40 を採る。0.50 は正解を 1 枚
 * 余分に捨てるだけで誤答は減らない。
 */
export const MIN_REPORTABLE_CONFIDENCE = 0.4;

const UNITS: readonly { readonly threshold: number; readonly suffix: string }[] = [
  { threshold: 1e9, suffix: 'G' },
  { threshold: 1e6, suffix: 'M' },
  { threshold: 1e3, suffix: 'k' },
  { threshold: 1, suffix: '' },
];

/** 有効数字 3 桁で末尾の 0 を落とす。 */
function trimNumber(value: number): string {
  return Number.parseFloat(value.toPrecision(3)).toString();
}

/** 抵抗値を 4.7kΩ のような表記にする。 */
export function formatOhms(ohms: number): string {
  if (!Number.isFinite(ohms)) return '?';

  const unit = UNITS.find((candidate) => Math.abs(ohms) >= candidate.threshold);
  if (unit === undefined) return `${trimNumber(ohms * 1000)}mΩ`;

  return `${trimNumber(ohms / unit.threshold)}${unit.suffix}Ω`;
}

/** 確信度が十分で、値として表示してよい読み取りかどうか。 */
export function isReportable(
  reading: ResistorReading | null,
  minConfidence = MIN_REPORTABLE_CONFIDENCE,
): reading is ResistorReading {
  return reading !== null && reading.confidence >= minConfidence;
}

/**
 * 読み取り結果を「4.7kΩ ±5%」のように整形する。
 * 読めなかった場合と、確信度が閾値未満の場合は "?" を返す。
 */
export function formatReading(
  reading: ResistorReading | null,
  minConfidence = MIN_REPORTABLE_CONFIDENCE,
): string {
  if (!isReportable(reading, minConfidence)) return '?';

  const tolerance = reading.tolerance === null ? '' : ` ±${reading.tolerance}%`;
  return `${formatOhms(reading.ohms)}${tolerance}`;
}
