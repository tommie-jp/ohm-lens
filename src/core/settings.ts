import type { OrientedBox } from './locate.js';
import type { AnalyzeOptions } from './pipeline.js';
import type { RectifyOptions } from './rectify.js';
import type { RefineOptions } from './refine.js';
import { bodyColumns } from './roiMapping.js';
import { DEFAULT_PALETTE, type Palette } from './color/palette.js';

/**
 * 検出結果を解析にかけるときの条件。
 *
 * GUI・バッチ・較正が同じ値を使うようにここへ集約する。以前は 3 か所に
 * 散らばっていて、GUI だけ古い設定のまま取り残されていた。実測はバッチで
 * 取るので、GUI が違う条件で動いていると測った意味がなくなる。
 * どの値も `sample/` の 39 枚での実測で決めている。
 */

/**
 * ROI の余白。検出した本体範囲の外側をどれだけ含めるか。
 *
 * 検出ボックスは本体にぴったり張り付くので、そのまま切ると端のバンドが
 * 半分欠ける（バンドは丸まった肩に載っている）。0.22〜0.32 が頭打ちで
 * 一致 14〜16 枚、その外側は急に落ちる。平坦な区間の真ん中を採る。
 */
const ROI_PADDING = 0.28;

/**
 * 本体の外側をどれだけバンド探索に含めるか（本体長に対する割合）。
 *
 * 0（検出した本体そのもの）が最良。外へ広げるほど落ちる
 * （0 → 19 枚、0.03 → 17 枚、0.06 → 9 枚）。ROI の余白 0.28 で既に
 * 肩まで入っているため、これ以上外を見ると背景がバンドになる。
 */
const BODY_MARGIN = 0;

/**
 * 本体クラスタでの明度の重み。
 *
 * 円筒の陰影で本体の L\* は中央値 15・最大 28 ばらつく。素の CIE76 だと
 * 陰の部分が別クラスタになりバンドとして数えられる。
 * 1 → 17 枚、0.7 → 19 枚、0.6 → 19 枚、0.2 → 8 枚。
 */
const BODY_LIGHTNESS_WEIGHT = 0.6;

/**
 * 本体色をアンカーにした色順応補正。
 * 切ると 39 枚での一致が 30 → 13 枚まで落ちる。相対色分類の要。
 */
const ADAPT_WHITE_BALANCE = true;

/**
 * ランの切れ目とみなす ΔE（CIE76）。
 *
 * **誤答を出さないことを優先して選んでいる。** 本番条件での掃引（75 通り）では
 * 正解の最大は 28 だが、そこには必ず誤答が 1 件残る。edgeΔE 20 は
 * clusterΔE 10〜30 の全域で**誤答 0**になる平坦域で、正解 27・誤答 0。
 * 正解 1 枚と誤答 1 枚を交換している。
 * 「誤った値を自信ありげに出さない」方針（設計メモ §2 [5]）を、正解数より優先する。
 */
const EDGE_DELTA_E = 20;

/**
 * 本体クラスタで同じ色とみなす ΔE。
 *
 * edgeΔE 20 のもとでは 14 と 24 が同点（正解 27）。24 を採るのは、
 * edgeΔE 16 側にも誤答 0 が続いていて平坦域が広いため
 * （14 は edgeΔE 16 で誤答 1 に転ぶ）。
 */
const CLUSTER_DELTA_E = 24;

/** これ未満の幅のランはノイズとして捨てる。掃引では 2 が全域で最良。 */
const MIN_BAND_WIDTH = 2;

/** ROI の切り出し条件。 */
export const ROI_OPTIONS: RectifyOptions = { padding: ROI_PADDING, targetHeight: 40 };

/**
 * ラン分割のしきい値。**GUI・バッチ・較正がこれを共有すること。**
 *
 * 較正（`tests/fixtures/calibrate.test.ts`）はこれらを別に持っていて、
 * 掃引で値を変えても追従しなかった。較正が意図的に変えてよいのは
 * 本体範囲の余白と `keepEdgeRuns` だけで、分割のしきい値は同じにする。
 */
export const SEGMENT_THRESHOLDS = {
  edgeDeltaE: EDGE_DELTA_E,
  clusterDeltaE: CLUSTER_DELTA_E,
  minBandWidth: MIN_BAND_WIDTH,
  bodyLightnessWeight: BODY_LIGHTNESS_WEIGHT,
} as const;

/** 検出枠をカラーコードの並びで広げ直すときの条件。 */
export function refineOptions(palette: Palette = DEFAULT_PALETTE): RefineOptions {
  return {
    rectify: ROI_OPTIONS,
    segment: { palette, ...SEGMENT_THRESHOLDS },
  };
}

/**
 * ROI の解析条件。検出結果から本体の位置を渡すのが要点。
 *
 * `bodyExtent` によるプロファイルからの推定は 39 枚中 25 枚で外れていた
 * （広すぎ 10・狭すぎ 15）。広すぎれば背景がバンドになり、狭すぎれば端の
 * バンドが消える。検出側が本体の位置を持っているので、そちらを信じる。
 */
export function analyzeOptions(
  box: OrientedBox,
  palette: Palette = DEFAULT_PALETTE,
): AnalyzeOptions {
  return {
    segment: { palette, ...SEGMENT_THRESHOLDS },
    bodyRange: bodyColumns(box, ROI_OPTIONS, BODY_MARGIN),
    adaptWhiteBalance: ADAPT_WHITE_BALANCE,
  };
}
