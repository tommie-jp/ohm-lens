import { readResistorImage } from '../../annotate/read.js';
import { analyzeRoi, type AnalysisResult } from '../../core/pipeline.js';
import { rectify } from '../../core/rectify.js';
import { analyzeOptions, ROI_OPTIONS } from '../../core/settings.js';
import { createPalette, type Palette } from '../../core/color/palette.js';
import type { OrientedBox } from '../../core/locate.js';
import type { RoiImage } from '../../core/bands/profile.js';
import {
  toRoiImage,
  toTransferImage,
  type AnalysisRequest,
  type AnalysisResponse,
  type AnalysisSummary,
  type TransferImage,
} from './protocol.js';

/**
 * 解析パイプラインの本体。Worker のメッセージハンドラが呼ぶ。
 *
 * **DOM に触らない。** Worker で動かすためと、node 環境のテストから
 * そのまま呼べるようにするため。canvas への転写やオーバーレイ描画は
 * 呼び出し側（`main.ts`）の仕事。
 *
 * 解析条件は `core/settings.ts` 経由で組む。GUI だけ別の条件で動いていると、
 * バッチ（`scripts/detect.ts`）や較正で測った数字が実機と対応しなくなる
 * （`annotate/read.ts` の冒頭コメントを参照）。
 */

/** 解析できたときの中身。応答の組み立ては {@link runAnalysis} に集約する。 */
interface Outcome {
  readonly box: OrientedBox | null;
  readonly roi: TransferImage;
  readonly analysis: AnalysisSummary;
}

/** UI が読む項目だけ取り出す。`scans` は転送が重いので載せない。 */
function summarize(result: AnalysisResult): AnalysisSummary {
  return {
    profile: result.profile,
    bands: result.bands,
    runs: result.runs,
    reading: result.reading,
    anchor: result.anchor,
  };
}

/** 1 フレームを解析する。 */
export function runAnalysis(request: AnalysisRequest): AnalysisResponse {
  const started = performance.now();
  const palette =
    request.paletteColors === null ? undefined : createPalette(request.paletteColors);
  const outcome = analyse(request, toRoiImage(request.image), palette);

  return {
    frameId: request.frameId,
    box: outcome?.box ?? null,
    roi: outcome?.roi ?? null,
    analysis: outcome?.analysis ?? null,
    durationMs: performance.now() - started,
  };
}

/** 3 経路の違いは「本体枠をどこから得るか」だけ。解析できなければ null。 */
function analyse(
  request: AnalysisRequest,
  image: RoiImage,
  palette: Palette | undefined,
): Outcome | null {
  const { mode } = request;

  // 検出 → 枠の広げ直し → 切り出し → 解析。バッチ・フィクスチャと同じ経路
  if (mode.kind === 'auto') {
    const result = readResistorImage(image, palette === undefined ? {} : { palette });
    if (result.roi === null || result.analysis === null) return null;
    return {
      box: result.box,
      roi: toTransferImage(result.roi),
      analysis: summarize(result.analysis),
    };
  }

  // ガイド枠は検出済みの枠として扱う。切り出しから先は auto と同じ条件
  if (mode.kind === 'box') {
    const roi = rectify(image, mode.box, ROI_OPTIONS);
    return {
      box: mode.box,
      roi: toTransferImage(roi),
      analysis: summarize(analyzeRoi(roi, analyzeOptions(mode.box, palette))),
    };
  }

  // 手動指定。枠が無いので本体範囲はプロファイルから推定させる。
  // **この経路だけ `settings.ts` の分割しきい値を通っていない**（Worker 化の
  // 前からの食い違いで、挙動を変えないためそのまま移した）。手動 ROI で
  // 掃引した結果はバッチと直接比べられない点に注意。
  const analysis = analyzeRoi(image, {
    adaptWhiteBalance: mode.adaptWhiteBalance,
    ...(palette === undefined ? {} : { segment: { palette } }),
  });
  return { box: null, roi: request.image, analysis: summarize(analysis) };
}
