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

/** ROI の切り出し条件。 */
export const ROI_OPTIONS: RectifyOptions = { padding: ROI_PADDING, targetHeight: 40 };

/** 検出枠をカラーコードの並びで広げ直すときの条件。 */
export function refineOptions(palette: Palette = DEFAULT_PALETTE): RefineOptions {
  return {
    rectify: ROI_OPTIONS,
    segment: { palette, bodyLightnessWeight: BODY_LIGHTNESS_WEIGHT },
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
    segment: { palette, bodyLightnessWeight: BODY_LIGHTNESS_WEIGHT },
    bodyRange: bodyColumns(box, ROI_OPTIONS, BODY_MARGIN),
  };
}
