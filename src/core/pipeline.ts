import type { Band, LabColor, ProfileSample, ResistorReading } from '../types.js';
import { extractProfile, type ProfileOptions, type RoiImage } from './bands/profile.js';
import { segmentBands, type SegmentOptions } from './bands/segment.js';
import { bodyExtent, type BodyExtent, type BodyExtentOptions } from './bands/extent.js';
import { normalizeLightness, type NormalizeOptions } from './bands/normalize.js';
import { readResistor } from './value/decode.js';
import { buildBodyAnchorAdaptation } from './color/anchor.js';
import { adaptToAnchor } from './color/whiteBalance.js';
import type { Adaptation } from './color/whiteBalance.js';

/**
 * ROI から抵抗値までの一連の処理をまとめたパイプライン。
 * DOM に依存しないので、静止画（Phase 0）でも Worker（Phase 1 以降）でも
 * そのまま使える。
 *
 * 流れ:
 * 1. プロファイル抽出
 * 2. 仮のアンカーで色順応補正 → 本体範囲を特定
 * 3. 本体範囲の画素だけでアンカーを取り直して補正しなおす
 * 4. 本体範囲の内側でバンド抽出 → デコード
 *
 * 2〜3 の二段構えなのは、ROI に机や背景が入り込むため。アンカーを
 * ROI 全体の中央値で取ると背景色に引きずられ、色順応補正が丸ごと壊れる。
 */

export interface AnalyzeOptions {
  readonly profile?: ProfileOptions;
  readonly segment?: SegmentOptions;
  readonly extent?: BodyExtentOptions;
  readonly normalize?: NormalizeOptions;
  /**
   * 本体色をアンカーにした色順応補正を行うか。
   * WB ロックできない環境（Safari）では有効にする。既定は有効。
   */
  readonly adaptWhiteBalance?: boolean;
  /**
   * 円筒形ボディの陰影勾配を明度の局所正規化で取り除くか。
   *
   * **既定は無効。** sample/ の 39 枚で計測した限りでは正解率が改善せず
   * （18% → 15%、差は 1 枚で誤差の範囲）、効果を確認できていないため。
   * 基準色を較正したあとに再評価する価値はある。
   */
  readonly normalizeShading?: boolean;
}

export interface AnalysisResult {
  /** 1D カラープロファイル（色順応補正の適用後、ROI 全体ぶん） */
  readonly profile: readonly ProfileSample[];
  /** 本体が占める範囲。特定できなければ null。 */
  readonly extent: BodyExtent | null;
  readonly bands: readonly Band[];
  readonly reading: ResistorReading | null;
  /** 補正に使った観測アンカー色。補正しなかった場合は null。 */
  readonly anchor: LabColor | null;
}

function applyAdaptation(
  profile: readonly ProfileSample[],
  adaptation: Adaptation | null,
): ProfileSample[] {
  if (adaptation === null) return [...profile];
  return profile.map((sample) => ({ x: sample.x, lab: adaptToAnchor(sample.lab, adaptation) }));
}

/** ROI 画像を解析して抵抗値を読み取る。 */
export function analyzeRoi(image: RoiImage, options: AnalyzeOptions = {}): AnalysisResult {
  const shouldAdapt = options.adaptWhiteBalance ?? true;
  const extracted = extractProfile(image, options.profile ?? {});

  // 円筒形ボディの陰影勾配を先に落とす。残したままランを切ると、
  // 本体の途中に余計な切れ目が入って本数が合わなくなる。
  const rawProfile =
    options.normalizeShading === true
      ? normalizeLightness(extracted, options.normalize ?? {})
      : extracted;

  // 1 回目: ROI 全体のアンカーで粗く補正し、本体範囲を掴む
  const coarse = shouldAdapt ? buildBodyAnchorAdaptation(rawProfile) : null;
  const coarseProfile = applyAdaptation(rawProfile, coarse?.adaptation ?? null);
  const coarseExtent = bodyExtent(coarseProfile, options.extent ?? {});

  // 2 回目: 本体範囲の画素だけでアンカーを取り直す
  const bodySamples =
    coarseExtent === null ? rawProfile : rawProfile.slice(coarseExtent.start, coarseExtent.end);
  const refined = shouldAdapt ? buildBodyAnchorAdaptation(bodySamples) : null;
  const profile = applyAdaptation(rawProfile, refined?.adaptation ?? null);

  const extent = bodyExtent(profile, options.extent ?? {}) ?? coarseExtent;
  const analysed = extent === null ? profile : profile.slice(extent.start, extent.end);

  const bands = segmentBands(analysed, options.segment ?? {});
  const roiLength = extent === null ? image.width : extent.end - extent.start;
  const reading = bands.length === 0 ? null : readResistor(bands, roiLength);

  return { profile, extent, bands, reading, anchor: refined?.anchor ?? coarse?.anchor ?? null };
}
