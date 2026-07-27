import type { Band, LabColor, ProfileSample, ResistorReading } from '../types.js';
import { extractProfile, type ProfileOptions, type RoiImage } from './bands/profile.js';
import { segmentBands, type SegmentOptions } from './bands/segment.js';
import { readResistor } from './value/decode.js';
import { buildBodyAnchorAdaptation } from './color/anchor.js';
import { adaptToAnchor } from './color/whiteBalance.js';

/**
 * ROI から抵抗値までの一連の処理をまとめたパイプライン。
 * DOM に依存しないので、静止画（Phase 0）でも Worker（Phase 1 以降）でも
 * そのまま使える。
 */

export interface AnalyzeOptions {
  readonly profile?: ProfileOptions;
  readonly segment?: SegmentOptions;
  /**
   * 本体色をアンカーにした色順応補正を行うか。
   * WB ロックできない環境（Safari）では有効にする。既定は有効。
   */
  readonly adaptWhiteBalance?: boolean;
}

export interface AnalysisResult {
  /** 1D カラープロファイル（色順応補正の適用後） */
  readonly profile: readonly ProfileSample[];
  readonly bands: readonly Band[];
  readonly reading: ResistorReading | null;
  /** 補正に使った観測アンカー色。補正しなかった場合は null。 */
  readonly anchor: LabColor | null;
}

/** ROI 画像を解析して抵抗値を読み取る。 */
export function analyzeRoi(image: RoiImage, options: AnalyzeOptions = {}): AnalysisResult {
  const shouldAdapt = options.adaptWhiteBalance ?? true;
  const rawProfile = extractProfile(image, options.profile ?? {});

  const { adaptation, anchor } = shouldAdapt
    ? buildBodyAnchorAdaptation(rawProfile)
    : { adaptation: null, anchor: null };

  const profile =
    adaptation === null
      ? rawProfile
      : rawProfile.map((sample) => ({ x: sample.x, lab: adaptToAnchor(sample.lab, adaptation) }));

  const bands = segmentBands(profile, options.segment ?? {});
  const reading = bands.length === 0 ? null : readResistor(bands, image.width);

  return { profile, bands, reading, anchor };
}
