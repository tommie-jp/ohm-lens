import sharp from 'sharp';
import { analyzeRoi } from '../core/pipeline.js';
import { locateResistor } from '../core/locate.js';
import { rectify } from '../core/rectify.js';
import { refineBoxExtent } from '../core/refine.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../core/settings.js';
import { formatConfidence, formatOhms, isReportable } from '../core/format.js';
import { jointReadResistor } from '../core/value/jointDecode.js';
import { DEFAULT_PALETTE, type Palette } from '../core/color/palette.js';
import type { RoiImage } from '../core/bands/profile.js';
import {
  buildAnnotationSvg,
  labelOverflow,
  panelHeightFor,
  panelWidthFor,
  type AnnotateInput,
} from './render.js';

/**
 * 1 枚の写真を検出・解析し、結果を焼き込んだ画像を返す。
 *
 * GUI（`debug/`）とバッチ（`scripts/`）で同じ経路を使うための共通実装。
 * 検出に失敗しても例外にせず、「検出失敗」を焼き込んだ画像を返す。
 * デバッグツールなので、失敗が消えてしまわないことが大事。
 */


/** 解析前に縮小する長辺の画素数。実機の解析と条件を揃える。 */
const DECODE_MAX_SIZE = 800;

export interface AnnotateOptions {
  readonly palette?: Palette;
  readonly japanese?: boolean;
  /** 期待値（ファイル名や MANIFEST から分かる場合） */
  readonly expectedOhms?: number;
}

export interface AnnotateResult {
  /** 焼き込み済みの JPEG */
  readonly jpeg: Buffer;
  /** 進捗表示・集計用の 1 行 */
  readonly caption: string;
  readonly located: boolean;
  readonly ohms: number | null;
  readonly correct: boolean;
  /**
   * 確信度が閾値を超えていて、値として出してよいか。
   * 低いものは実機では「?」になる（誤った値を自信ありげに出さない方針）。
   */
  readonly confident: boolean;
}

/** 画像を RGBA の生ピクセルとして読む（EXIF の向きを反映、長辺を抑える）。 */
export async function loadRoiImage(path: string): Promise<RoiImage> {
  const { data, info } = await sharp(path)
    .rotate()
    .resize({
      width: DECODE_MAX_SIZE,
      height: DECODE_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/** 検出結果を焼き込んだ画像を作る。 */
export async function annotateImage(
  path: string,
  label: string,
  options: AnnotateOptions = {},
): Promise<AnnotateResult> {
  const palette = options.palette ?? DEFAULT_PALETTE;
  const image = await loadRoiImage(path);
  const located = locateResistor(image);

  const expected =
    options.expectedOhms === undefined ? '期待 不明' : `期待 ${formatOhms(options.expectedOhms)}`;

  if (located === null) {
    const input: AnnotateInput = {
      width: canvasWidth(image, 0),
      height: image.height,
      box: null,
      bands: [],
      rectify: ROI_OPTIONS,
      caption: `${label} | ${expected} | 検出失敗`,
      colorSpace: { palette, observed: [] },
      ...(options.japanese === undefined ? {} : { japanese: options.japanese }),
    };
    return {
      jpeg: await composite(image, input),
      caption: `${label} | ${expected} | 検出失敗`,
      located: false,
      ohms: null,
      correct: false,
      confident: false,
    };
  }

  // カラーコードの並びを手がかりに、枠を長軸方向へ広げ直す
  const box = refineBoxExtent(located, image, refineOptions(palette));
  const roi = rectify(image, box, ROI_OPTIONS);
  const result = analyzeRoi(roi, analyzeOptions(box, palette));
  // 役割つきの解釈が要るので、同じランで joint デコードを取り直す
  const joint = jointReadResistor(
    result.runs.map((run) => ({ lab: run.lab, start: run.start, end: run.end })),
    { palette },
  );

  const ohms = result.reading?.ohms ?? null;
  const confident = isReportable(result.reading ?? null);
  const correct =
    options.expectedOhms !== undefined &&
    ohms !== null &&
    Math.abs(ohms - options.expectedOhms) / options.expectedOhms < 1e-6;

  const bandSummary = (joint?.usedRuns ?? [])
    .map((used) => `${used.color}${used.roleText}`)
    .join(' ');
  const caption =
    `${label} | ${expected} → ` +
    `${ohms === null ? '読取不可' : `${formatOhms(ohms)}${confident ? '' : '(保留)'}`} ` +
    `[確信度 ${formatConfidence(result.reading?.confidence ?? 0)}] | ` +
    `${box.angleDeg.toFixed(0)}° L${Math.round(box.length)} T${Math.round(box.thickness)} ` +
    `(比 ${(box.length / box.thickness).toFixed(2)}) | ${bandSummary}`;

  const colorSpace = { palette, observed: result.runs.map((run) => run.lab) };
  const base: AnnotateInput = {
    width: canvasWidth(image, colorSpace.observed.length),
    height: image.height,
    box,
    bands: result.bands,
    rectify: ROI_OPTIONS,
    caption,
    // 実測色は分類前のランの Lab（基準色にどう引き寄せられたかを見るため）
    colorSpace,
    ...(joint === null ? {} : { usedRuns: joint.usedRuns, droppedRuns: joint.droppedRuns }),
    ...(options.japanese === undefined ? {} : { japanese: options.japanese }),
  };
  // 注釈が写真からはみ出す量を測ってから、その分キャンバスを広げる
  const overflow = labelOverflow(base);
  const input: AnnotateInput = { ...base, labelOverflow: overflow };

  return {
    jpeg: await composite(image, input),
    caption,
    located: true,
    ohms,
    correct,
    confident,
  };
}

/**
 * 元画像に SVG を焼き込む。注釈と色空間パネルのぶんキャンバスを広げてから重ねる。
 *
 * 写真の上に重ねると抵抗器が隠れるので下と右に場所を作る。注釈が写真の外へ
 * はみ出す量も足しておかないと、色空間パネルの上に文字が重なる。
 */
async function composite(image: RoiImage, input: AnnotateInput): Promise<Buffer> {
  const base = sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  });

  const overflow = input.labelOverflow ?? { right: 0, bottom: 0 };
  const bottom = overflow.bottom + panelHeightFor(input, input.width);
  const right = Math.max(input.width - image.width, overflow.right);
  if (bottom === 0 && right <= 0) {
    return base
      .composite([{ input: Buffer.from(buildAnnotationSvg(input)), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();
  }

  return base
    .extend({ bottom, right: Math.max(0, right), background: '#ffffff' })
    .composite([{ input: Buffer.from(buildAnnotationSvg(input)), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** 色空間パネルが収まるキャンバス幅。小さい写真では写真より広くなる。 */
function canvasWidth(image: RoiImage, bandCount: number): number {
  return Math.max(image.width, panelWidthFor(bandCount));
}
