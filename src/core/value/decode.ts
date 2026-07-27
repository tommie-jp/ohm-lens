import type { Band, BandColor, ESeries, ReadDirection, ResistorReading } from '../../types.js';
import {
  digitOf,
  MAX_BANDS,
  MIN_BANDS,
  multiplierOf,
  tempCoefficientOf,
  toleranceOf,
} from './codeTable.js';
import { snapForTolerance } from './eseries.js';
import { determineDirection, sortBands } from './direction.js';
import { clamp01 } from '../math.js';

/** バンド列のデコード結果（方向は既に確定している前提）。 */
export interface DecodedValue {
  readonly ohms: number;
  readonly rawOhms: number;
  readonly tolerance: number | null;
  readonly tempCoefficient: number | null;
  readonly series: ESeries;
  /** E系列スナップの相対偏差。大きいほど誤読の疑いが強い。 */
  readonly snapDeviation: number;
}

/** この偏差を超えると E系列適合スコアが 0 になる。 */
const SNAP_DEVIATION_LIMIT = 0.02;

/** 方向を決められないときに確信度へ掛ける係数。 */
const CONFIDENCE_TIE_PENALTY = 0.6;

/**
 * バンド構成。3/4 バンドは数字 2 桁、5/6 バンドは数字 3 桁。
 * 3 バンドは許容差バンドを持たない（±20% 品）。
 */
function digitCountFor(bandCount: number): number {
  return bandCount <= 4 ? 2 : 3;
}

/** 省略可能なバンド（許容差・温度係数）の読み取り結果。 */
interface OptionalBand {
  readonly value: number | null;
  /** 色は在るのにその位置で使えない色だった場合は false（誤読とみなす） */
  readonly isValid: boolean;
}

function readOptionalBand(
  color: BandColor | undefined,
  lookup: (color: BandColor) => number | null,
): OptionalBand {
  if (color === undefined) return { value: null, isValid: true };

  const value = lookup(color);
  return { value, isValid: value !== null };
}

/**
 * 並び順が確定したバンド列を抵抗値にデコードする。
 * 位置ごとに使えない色が来た場合は誤読とみなし null を返す。
 *
 * @param colors 先頭が第1数字バンドとなる順に並んだ色列
 */
export function decodeBandSequence(colors: readonly BandColor[]): DecodedValue | null {
  if (colors.length < MIN_BANDS || colors.length > MAX_BANDS) return null;

  const digitCount = digitCountFor(colors.length);

  let significand = 0;
  for (let i = 0; i < digitCount; i += 1) {
    const digit = digitOf(colors[i] as BandColor);
    if (digit === null) return null;
    significand = significand * 10 + digit;
  }

  const multiplier = multiplierOf(colors[digitCount] as BandColor);

  const tolerance = readOptionalBand(colors[digitCount + 1], toleranceOf);
  if (!tolerance.isValid) return null;

  const tempCoefficient = readOptionalBand(colors[digitCount + 2], tempCoefficientOf);
  if (!tempCoefficient.isValid) return null;

  const rawOhms = significand * multiplier;
  if (rawOhms <= 0) {
    // 全桁が black（0Ω ジャンパ）は色帯解析の対象外として棄却する
    return null;
  }

  const snapped = snapForTolerance(rawOhms, tolerance.value);

  return {
    ohms: snapped.ohms,
    rawOhms,
    tolerance: tolerance.value,
    tempCoefficient: tempCoefficient.value,
    series: snapped.series,
    snapDeviation: snapped.deviation,
  };
}

/** E系列への適合度 0..1。偏差が大きいほど 0 に近づく。 */
function seriesFitScore(deviation: number): number {
  return Math.max(0, 1 - deviation / SNAP_DEVIATION_LIMIT);
}

function colorsInDirection(sorted: readonly Band[], direction: ReadDirection): BandColor[] {
  const colors = sorted.map((band) => band.color);
  return direction === 'ltr' ? colors : colors.reverse();
}

interface Candidate {
  readonly direction: ReadDirection;
  readonly decoded: DecodedValue;
  readonly score: number;
}

/**
 * バンド列から抵抗値を読み取る。
 *
 * 方向判定（許容差バンド・余白比率）を prior とし、両方向でデコードして
 * E系列適合と組み合わせて最終的な方向を決める。片方向しかデコードできない
 * 場合はそちらを採用する。
 *
 * @param bands 分類済みバンド列（順不同でよい）
 * @param roiLength ROI の長軸方向の長さ
 */
export function readResistor(bands: readonly Band[], roiLength: number): ResistorReading | null {
  const sorted = sortBands(bands);
  const prior = determineDirection(sorted, roiLength);

  const candidates: Candidate[] = [];
  for (const direction of ['ltr', 'rtl'] as const) {
    const decoded = decodeBandSequence(colorsInDirection(sorted, direction));
    if (decoded === null) continue;

    const directionScore = direction === prior.direction ? prior.confidence : 1 - prior.confidence;
    candidates.push({
      direction,
      decoded,
      score: directionScore * seriesFitScore(decoded.snapDeviation),
    });
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best === undefined) return null;

  const minBandConfidence = sorted.reduce((min, band) => Math.min(min, band.confidence), 1);

  // 両方向が同点なら方向を決められていないので確信度を割り引く
  const isTied = ranked[1]?.score === best.score;
  const ambiguityPenalty = isTied ? CONFIDENCE_TIE_PENALTY : 1;

  return {
    ohms: best.decoded.ohms,
    rawOhms: best.decoded.rawOhms,
    tolerance: best.decoded.tolerance,
    tempCoefficient: best.decoded.tempCoefficient,
    series: best.decoded.series,
    direction: best.direction,
    confidence: clamp01(best.score * minBandConfidence * ambiguityPenalty),
  };
}
