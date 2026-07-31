import type { ScanProfileOptions } from './bands/profile.js';
import type { OrientedBox } from './locate.js';
import type { AnalyzeOptions } from './pipeline.js';
import type { RectifyOptions } from './rectify.js';
import type { RefineOptions } from './refine.js';
import { bodyColumns, bodyRows } from './roiMapping.js';
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

/**
 * 明度だけで切れ目とみなすマージン（`splitRuns` の `lightnessMargin`）。
 *
 * **無効のまま。有効にすると誤答が増える。** 金・銀は本体と色相が同じで明度
 * だけ違うので `EDGE_DELTA_E = 20` の切れ目にかからず、ランとして切られない
 * まま本体に溶けている。人手で確定した境界（`sample/boundaries.json` の 21 枚・
 * バンド 89 本）で測ると、失われた 15 本のうち 14 本が分割の段階で消えていた。
 *
 * この基準を足すと**分割の段階は実際に直る**（正解 81 本のうち切れた本数が
 * 63 → 76）。ところが最終的な値は良くならない。二度測って二度とも悪化した:
 *
 * 1. 切ったランが本体クラスタに吸収され直す（凹み除外の絞り 0.85 では
 *    金の距離 4〜11 を弾けない）。絞りを 0 にすると影のランが暴発する
 *    （余分 9 → 21〜29）
 * 2. 金属容疑の安全弁（`jointDecode` の `bodyLab`）を入れた後の再掃引でも、
 *    バンド一致は最大 +1 に対し正解 32 → 30〜31 か誤答増
 *
 * ラン数の回復は分割ではなく**位置を絞った拾い直し**（`RECOVER_DELTA_E`）で
 * 行う。経緯は `docs/13-バンド境界の検出指標.md` §11〜§12。
 */
const LIGHTNESS_MARGIN = Number.POSITIVE_INFINITY;

/**
 * 位置を絞った拾い直し（`bands/recover.ts`）の、本体色との差のしきい値。
 *
 * 既定の 9 から**大きく下げる**。金は本体との CIE76 が 4〜11 しかなく、
 * 9 では半分が拾えない。かつては「下げると誤答が増える」ため 9 で止めていた
 * （ΔE 5 で正解 26 — `docs/11` §3.5）が、それは拾った弱いランが数字として
 * デコードに入っていたから。**金属容疑の安全弁**（`jointDecode` の `bodyLab`、
 * 本体に近いランは倍率・許容差の金・銀にしかならず、捨てるのはタダ）を
 * 入れた後は、下げても値が 1 つも動かない。43 枚 / 正解 155 本での掃引:
 *
 * | しきい値 | バンド一致 | 余分 | 正解/誤答 |
 * | ------ | ------ | ------ | ------ |
 * | 9（旧） | 130 | 11 | 32/1 |
 * | 4 | 143 | 11 | 32/1 |
 * | **3** | **145** | **9** | 32/1 |
 * | 2.5 | 144 | 10 | 32/1 |
 * | 2 | 141 | 13 | 32/1 |
 *
 * 安全弁なしだと ΔE3 で正解 30・誤答 2 に落ちる。**この値は安全弁とセット。**
 * 3 が頂点で、2 以下は窓内の雑音を拾って崩れ始める。
 * （表の 誤答 1 は `isReadableSize` の門を通さない測り方によるもので、
 * 門を通す `doDetect.sh` では全設定で誤答 0）
 */
const RECOVER_DELTA_E = 3;

/**
 * 走査線を並べる範囲を本体からどれだけ内側に絞るか（本体の太さに対する割合）。
 *
 * **0（本体そのもの）が最良。** 円筒の肩を通る走査線を避けるつもりで内側へ
 * 絞ると落ちる（0 → 正解 32、-0.10 → 31、-0.15 → 31・誤答 6、-0.20 → 30・
 * 誤答 7、-0.25 → 24）。絞ると 1 走査線あたりの行数が減り、推定が痩せるため。
 * 肩は主犯ではない。
 */
const SCAN_ROW_MARGIN = 0;

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
  lightnessMargin: LIGHTNESS_MARGIN,
  bodyLightnessWeight: BODY_LIGHTNESS_WEIGHT,
} as const;

/**
 * 走査線の条件。本体の行範囲を検出結果から渡す。
 *
 * **較正（`tests/fixtures/calibrate.test.ts`）もこれを使うこと。** サンプリングが
 * 本番とずれると、学習したパレットが本番の観測値と対応しなくなる
 * （「変換と palette は密結合」— `docs/09-色空間と色差指標の検討.md`）。
 * 較正が意図的に変えてよいのは本体範囲の余白と `keepEdgeRuns` だけ。
 */
export function scanProfileOptions(
  box: OrientedBox,
  rectifyOptions: RectifyOptions = ROI_OPTIONS,
): ScanProfileOptions {
  return { bodyRows: bodyRows(box, rectifyOptions, SCAN_ROW_MARGIN) };
}

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
 *
 * 短軸側（`profile.bodyRows`）も同じ理由で検出結果から渡す。ROI 全体を
 * 等分すると走査線の両端が本体の外（背景・リード線）に落ちる。
 */
export function analyzeOptions(
  box: OrientedBox,
  palette: Palette = DEFAULT_PALETTE,
): AnalyzeOptions {
  return {
    segment: { palette, ...SEGMENT_THRESHOLDS },
    bodyRange: bodyColumns(box, ROI_OPTIONS, BODY_MARGIN),
    profile: scanProfileOptions(box),
    adaptWhiteBalance: ADAPT_WHITE_BALANCE,
    recover: { deltaE: RECOVER_DELTA_E },
  };
}
