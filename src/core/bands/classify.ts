import type { BandColor, LabColor } from '../../types.js';
import { deltaE2000Prepared, prepareLab } from '../color/colorSpace.js';
import { BAND_ENTRIES, BODY_ENTRIES } from '../color/colors.js';
import { clamp01, normalizedMargin } from '../math.js';

/**
 * この ΔE を超えると、どの基準色にも似ていないとみなして確信度を 0 にする。
 * CIEDE2000 で 40 は「まったく別の色」と言える水準。
 */
const MAX_ACCEPTABLE_DELTA_E = 40;

/** 本体色とみなす ΔE の既定閾値。 */
export const DEFAULT_BODY_DELTA_E = 12;

export interface ColorCandidate {
  readonly color: BandColor;
  readonly deltaE: number;
}

export interface ClassificationResult {
  readonly color: BandColor;
  readonly deltaE: number;
  /**
   * 分類の確信度 0..1。
   * 最近傍との絶対的な近さと、次点との差（マージン）の両方を反映する。
   */
  readonly confidence: number;
}

/**
 * Lab 色を最も近いバンド色に分類する。
 *
 * 環境光の色被りは呼び出し前に whiteBalance の色順応補正で除去しておくこと。
 * ここでは補正済みの Lab が渡ってくる前提で基準色との ΔE2000 を取る。
 *
 * バンドの列数だけ呼ばれるホットパスなので、配列やソートを作らず
 * 上位 2 件をスカラで走査する。上位候補の一覧が要る場合は
 * {@link rankBandColors} を使う。
 */
export function classifyBandColor(lab: LabColor): ClassificationResult {
  const prepared = prepareLab(lab);

  let bestColor: BandColor = (BAND_ENTRIES[0] as (typeof BAND_ENTRIES)[number]).key;
  let bestDelta = Number.POSITIVE_INFINITY;
  let secondDelta = Number.POSITIVE_INFINITY;

  for (const entry of BAND_ENTRIES) {
    const delta = deltaE2000Prepared(prepared, entry.prepared);
    if (delta < bestDelta) {
      secondDelta = bestDelta;
      bestDelta = delta;
      bestColor = entry.key;
    } else if (delta < secondDelta) {
      secondDelta = delta;
    }
  }

  return {
    color: bestColor,
    deltaE: bestDelta,
    confidence: confidenceFor(bestDelta, secondDelta),
  };
}

/**
 * 上位候補を ΔE の小さい順に返す。
 *
 * 紛らわしい色（茶/赤、金/黄）では最有力候補だけでなく上位候補と確信度を
 * 併記できるようにするためのもの。ホットパスでは使わない。
 */
export function rankBandColors(lab: LabColor, limit = 3): ColorCandidate[] {
  const prepared = prepareLab(lab);

  return BAND_ENTRIES.map((entry) => ({
    color: entry.key,
    deltaE: deltaE2000Prepared(prepared, entry.prepared),
  }))
    .sort((a, b) => a.deltaE - b.deltaE)
    .slice(0, limit);
}

/**
 * 抵抗器の本体色（背景）かどうか。
 * バンド抽出では本体色を除去してから連続ランをラベリングする。
 */
export function isBodyColor(lab: LabColor, thresholdDeltaE = DEFAULT_BODY_DELTA_E): boolean {
  const prepared = prepareLab(lab);

  for (const entry of BODY_ENTRIES) {
    if (deltaE2000Prepared(prepared, entry.prepared) < thresholdDeltaE) return true;
  }
  return false;
}

/**
 * 次点との差（紛らわしさ）と、最近傍色そのものへの近さの両方を反映する。
 * どちらか一方でも悪ければ確信度は下がる。
 */
function confidenceFor(bestDelta: number, secondDelta: number): number {
  const margin = normalizedMargin(bestDelta, secondDelta);
  const absoluteFit = Math.max(0, 1 - bestDelta / MAX_ACCEPTABLE_DELTA_E);
  return clamp01(margin * absoluteFit);
}
