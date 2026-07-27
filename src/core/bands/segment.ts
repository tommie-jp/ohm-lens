import type { Band, BandColor, ProfileSample } from '../../types.js';
import { classifyBandColor, isBodyColor } from './classify.js';

export interface SegmentOptions {
  /** 本体色とみなす ΔE の閾値 */
  readonly bodyDeltaE?: number;
  /** これ未満の幅のランはノイズとして捨てる */
  readonly minBandWidth?: number;
}

const DEFAULT_MIN_BAND_WIDTH = 2;

interface Run {
  readonly color: BandColor;
  readonly start: number;
  end: number;
  confidenceSum: number;
}

/**
 * 1D カラープロファイルからバンドを抽出する。
 *
 * 1. 各サンプルを本体色（背景）とバンド色に振り分ける
 * 2. 本体色を除去したうえで、同じ色が連続するランをラベリングする
 * 3. 幅が閾値未満のランはノイズとして捨てる
 *
 * バンドの確信度は構成サンプルの分類確信度の平均。
 */
export function segmentBands(
  profile: readonly ProfileSample[],
  options: SegmentOptions = {},
): Band[] {
  const minBandWidth = options.minBandWidth ?? DEFAULT_MIN_BAND_WIDTH;

  const runs: Run[] = [];
  let current: Run | null = null;

  for (const sample of profile) {
    if (isBodyColor(sample.lab, options.bodyDeltaE)) {
      current = null;
      continue;
    }

    const classification = classifyBandColor(sample.lab);

    if (current !== null && current.color === classification.color && current.end === sample.x) {
      current.end = sample.x + 1;
      current.confidenceSum += classification.confidence;
      continue;
    }

    current = {
      color: classification.color,
      start: sample.x,
      end: sample.x + 1,
      confidenceSum: classification.confidence,
    };
    runs.push(current);
  }

  return runs
    .filter((run) => run.end - run.start >= minBandWidth)
    .map((run) => ({
      color: run.color,
      start: run.start,
      end: run.end,
      confidence: run.confidenceSum / (run.end - run.start),
    }));
}
