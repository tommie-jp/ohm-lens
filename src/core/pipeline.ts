import type { Band, LabColor, ProfileSample, ResistorReading } from '../types.js';
import {
  extractProfile,
  extractProfiles,
  type RoiImage,
  type ScanProfileOptions,
} from './bands/profile.js';
import { maxScanSpread } from './bands/scanSpread.js';
import { bandRunStages, toBands, type SegmentOptions } from './bands/segment.js';
import { recoverRuns, type RecoverOptions } from './bands/recover.js';
import { DEFAULT_PALETTE } from './color/palette.js';
import type { ColorRun } from './bands/runs.js';
import { bodyExtent, type BodyExtent, type BodyExtentOptions } from './bands/extent.js';
import { normalizeLightness, type NormalizeOptions } from './bands/normalize.js';
import { readResistor } from './value/decode.js';
import { jointReadResistor, type JointReading } from './value/jointDecode.js';
import { buildBodyAnchorAdaptation } from './color/anchor.js';
import { adaptToAnchor } from './color/whiteBalance.js';
import type { Adaptation } from './color/whiteBalance.js';

/**
 * ROI から抵抗値までの一連の処理をまとめたパイプライン。
 * DOM に依存しないので、静止画（Phase 0）でも Worker（Phase 1 以降）でも
 * そのまま使える。
 *
 * 流れ:
 * 1. プロファイル抽出（中央帯 1 本 ＋ 本体を等分した走査線）
 * 2. 仮のアンカーで色順応補正 → 本体範囲を特定
 * 3. 本体範囲の画素だけでアンカーを取り直して補正しなおす
 * 4. 本体範囲の内側でバンド抽出 → デコード
 *
 * 走査線（本体の高さを等分した複数本）は**値の決定には使わない**。列単位で
 * 畳む案・走査線ごとに色順応する案・切れ目を多数決する案・バンド色を融合する
 * 案はいずれも実測で棄却した（`docs/14-走査線の多重化を測った結果.md`）。
 * 残ったのは「バンド色が行方向にどれだけばらついているか」という確信度の材料
 * だけで、これは色の近さや次点とのマージンから独立した新しい情報。
 *
 * 2〜3 の二段構えなのは、ROI に机や背景が入り込むため。アンカーを
 * ROI 全体の中央値で取ると背景色に引きずられ、色順応補正が丸ごと壊れる。
 */

export interface AnalyzeOptions {
  readonly profile?: ScanProfileOptions;
  readonly segment?: SegmentOptions;
  readonly extent?: BodyExtentOptions;
  readonly normalize?: NormalizeOptions;
  /** 位置を絞った拾い直し（`bands/recover.ts`）の条件。 */
  readonly recover?: RecoverOptions;
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
  /**
   * 本体が ROI のどの列を占めるかの事前情報（`bodyColumns` の結果）。
   *
   * 与えると、プロファイルからの推定（`bodyExtent`）ではなくこれを使う。
   * 39 枚の実測では推定が 25 枚で外れており（広すぎ 10・狭すぎ 15）、
   * 広すぎれば背景がバンドになり、狭すぎれば端のバンドが消えていた。
   * 検出側が本体の位置を持っているので、そちらを信じるほうが確実。
   */
  readonly bodyRange?: BodyExtent;
}

export interface AnalysisResult {
  /** 1D カラープロファイル（色順応補正の適用後、ROI 全体ぶん） */
  readonly profile: readonly ProfileSample[];
  /**
   * 走査線ごとのプロファイル（補正後、上から下の順）。
   * バンド色の行方向のばらつきを測るのに使う（`bands/scanSpread.ts`）。
   */
  readonly scans: readonly (readonly ProfileSample[])[];
  /** 本体が占める範囲。特定できなければ null。 */
  readonly extent: BodyExtent | null;
  readonly bands: readonly Band[];
  /** 本体を除いたバンド候補のラン（分類前の Lab つき）。値からの学習に使う。 */
  readonly runs: readonly ColorRun[];
  /**
   * 本体の代表色（`identifyBody`）。特定できなければ null。
   *
   * デコード側の金属容疑の判定に使う。**`runs` と同じ分割から取ること** —
   * 別に計算すると、ランと本体色が違うものを指して判定がずれる。
   */
  readonly bodyLab: LabColor | null;
  /**
   * 同時デコードの結果。解が出なければ null（`reading` は従来法に落ちる）。
   *
   * **`reading` と別に持つのは、役割つきの解釈を捨てないため。** どのランを
   * 採用し、どれを除外したか（`usedRuns` / `droppedRuns`）は表示に要る。
   * 呼び出し側が同じランでデコードし直すと、条件を 1 つ取り違えただけで
   * 「画面の解釈」と「値の解釈」が食い違う。
   */
  readonly joint: JointReading | null;
  readonly reading: ResistorReading | null;
  /**
   * バンド色の行方向のばらつき（ΔE2000 の最大）。測れなければ null。
   * 確信度の減点に使う（`value/jointDecode.ts`）。
   */
  readonly verticalSpread: number | null;
  /** 補正に使った観測アンカー色。補正しなかった場合は null。 */
  readonly anchor: LabColor | null;
  /**
   * 適用した色順応補正。補正しなかった場合は null。
   *
   * 焼き込み画像に「解析が見ている色」の ROI を出すために公開する。
   * **プロファイルと同じ補正を掛けること** — 別の補正で描くと、
   * グラフと画像が違うものを表していることになる。
   */
  readonly adaptation: Adaptation | null;
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

  // 段差の位置・本体の特定・ランの切り出しは**中央帯をまとめた 1 本**で行う。
  // 走査線を列単位で畳む案は 48 枚で棄却した。外れ値が無いとき
  // 「中央値の中央値」は素の中央値より情報を捨てるためで、走査線を
  // 3/5/7/9/13 本のどれにしても正解 33 → 30〜32 に落ちた。
  const extracted = extractProfile(image, options.profile ?? {});
  const rawScans = extractProfiles(image, options.profile ?? {});

  // 円筒形ボディの陰影勾配を先に落とす。残したままランを切ると、
  // 本体の途中に余計な切れ目が入って本数が合わなくなる。
  const rawProfile =
    options.normalizeShading === true
      ? normalizeLightness(extracted, options.normalize ?? {})
      : extracted;

  // 検出側から本体の位置をもらえるなら、推定はせずそれを使う
  const prior =
    options.bodyRange === undefined
      ? null
      : {
          start: Math.max(0, Math.round(options.bodyRange.start)),
          end: Math.min(rawProfile.length, Math.round(options.bodyRange.end)),
        };

  // 1 回目: ROI 全体のアンカーで粗く補正し、本体範囲を掴む
  const coarse = shouldAdapt ? buildBodyAnchorAdaptation(rawProfile) : null;
  const coarseProfile = applyAdaptation(rawProfile, coarse?.adaptation ?? null);
  const coarseExtent = prior ?? bodyExtent(coarseProfile, options.extent ?? {});

  // 2 回目: 本体範囲の画素だけでアンカーを取り直す。
  //
  // **補正は走査線ごとではなく、全走査線に同じものを掛ける。** 走査線ごとに
  // 取り直す案は 48 枚で棄却した。円筒の肩を通る走査線は「暗い」だけでなく
  // 階調が潰れていて、L を基準へ引き伸ばすと誤差ごと増幅される
  // （正解 32 → 30、明度を共有して a,b だけ走査線ごとにしても 31）。
  const bodySamples =
    coarseExtent === null ? rawProfile : rawProfile.slice(coarseExtent.start, coarseExtent.end);
  const refined = shouldAdapt ? buildBodyAnchorAdaptation(bodySamples) : null;
  const adaptation = refined?.adaptation ?? null;
  const scans = rawScans.map((scan) => applyAdaptation(scan, adaptation));
  const profile = applyAdaptation(rawProfile, adaptation);

  const extent = prior ?? bodyExtent(profile, options.extent ?? {}) ?? coarseExtent;
  const analysed = extent === null ? profile : profile.slice(extent.start, extent.end);

  const segmentOptions = options.segment ?? {};
  // 3 本しか出なかったときは許容差バンドを、2 本しか出なかったときは
  // その先を刻みで、位置を絞って拾い直す。
  // bands は runs から作る（別々に分割すると本数がずれる）
  const stages = bandRunStages(analysed, segmentOptions);
  const recoverOptions = options.recover ?? {};
  const runs = recoverRuns(analysed, stages.trimmed, recoverOptions);
  const bands = toBands(runs, segmentOptions.palette ?? DEFAULT_PALETTE);
  const roiLength = extent === null ? image.width : extent.end - extent.start;

  // バンド色の行方向のばらつき。値の決定には使わず、確信度の減点に使う
  const verticalSpread = maxScanSpread(runs, scans);

  // 同時デコード（色候補 × カラーコード表 × E系列で全体最適）を優先し、
  // 解が出なければ従来の「独立分類 → デコード」に落とす
  const joint = jointReadResistor(runs, {
    ...(segmentOptions.palette === undefined ? {} : { palette: segmentOptions.palette }),
    verticalSpread,
    bodyLab: stages.bodyLab,
  });
  const reading = joint ?? (bands.length === 0 ? null : readResistor(bands, roiLength));

  return {
    profile,
    scans,
    extent,
    bands,
    runs,
    bodyLab: stages.bodyLab,
    joint,
    reading,
    verticalSpread,
    anchor: refined?.anchor ?? coarse?.anchor ?? null,
    adaptation,
  };
}
