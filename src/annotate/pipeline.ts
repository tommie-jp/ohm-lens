import sharp from 'sharp';
import { analyzeRoi } from '../core/pipeline.js';
import { locateResistor } from '../core/locate.js';
import { rectify } from '../core/rectify.js';
import { refineBoxExtent } from '../core/refine.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../core/settings.js';
import { formatOhms } from '../core/format.js';
import { jointReadResistor } from '../core/value/jointDecode.js';
import { DEFAULT_PALETTE, type Palette } from '../core/color/palette.js';
import type { RoiImage } from '../core/bands/profile.js';
import { buildAnnotationSvg, panelHeightFor } from './render.js';

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
    const input = {
      width: image.width,
      height: image.height,
      box: null,
      bands: [],
      rectify: ROI_OPTIONS,
      caption: `${label} | ${expected} | 検出失敗`,
      colorSpace: { palette, observed: [] },
      ...(options.japanese === undefined ? {} : { japanese: options.japanese }),
    };
    return {
      jpeg: await composite(image, buildAnnotationSvg(input), panelHeightFor(input)),
      caption: `${label} | ${expected} | 検出失敗`,
      located: false,
      ohms: null,
      correct: false,
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
  const correct =
    options.expectedOhms !== undefined &&
    ohms !== null &&
    Math.abs(ohms - options.expectedOhms) / options.expectedOhms < 1e-6;

  const bandSummary = (joint?.usedRuns ?? [])
    .map((used) => `${used.color}${used.roleText}`)
    .join(' ');
  const caption =
    `${label} | ${expected} → ${ohms === null ? '読取不可' : formatOhms(ohms)} | ` +
    `${box.angleDeg.toFixed(0)}° L${Math.round(box.length)} T${Math.round(box.thickness)} ` +
    `(比 ${(box.length / box.thickness).toFixed(2)}) | ${bandSummary}`;

  const input = {
    width: image.width,
    height: image.height,
    box,
    bands: result.bands,
    rectify: ROI_OPTIONS,
    caption,
    // 実測色は分類前のランの Lab（基準色にどう引き寄せられたかを見るため）
    colorSpace: { palette, observed: result.runs.map((run) => run.lab) },
    ...(joint === null ? {} : { usedRuns: joint.usedRuns, droppedRuns: joint.droppedRuns }),
    ...(options.japanese === undefined ? {} : { japanese: options.japanese }),
  };

  return {
    jpeg: await composite(image, buildAnnotationSvg(input), panelHeightFor(input)),
    caption,
    located: true,
    ohms,
    correct,
  };
}

/**
 * 元画像に SVG を焼き込む。色空間パネルのぶんだけ下に伸ばしてから重ねる。
 * 写真の上に重ねると抵抗器が隠れるので、キャンバスを広げて場所を作る。
 */
async function composite(image: RoiImage, svg: string, panelHeight: number): Promise<Buffer> {
  const base = sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
  const extended =
    panelHeight === 0
      ? base
      : base.extend({ bottom: panelHeight, background: '#ffffff' });

  return extended
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}
