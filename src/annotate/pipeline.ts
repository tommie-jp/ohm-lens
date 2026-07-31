import sharp from 'sharp';
import type { AnalysisResult } from '../core/pipeline.js';
import type { OrientedBox } from '../core/locate.js';
import { ROI_OPTIONS, scanProfileOptions } from '../core/settings.js';
import { scanRowRanges } from '../core/bands/profile.js';
import { labToRgb, srgb255ToLab } from '../core/color/colorSpace.js';
import { adaptToAnchor, type Adaptation } from '../core/color/whiteBalance.js';
import { DEFAULT_PALETTE, type Palette } from '../core/color/palette.js';
import type { RoiImage } from '../core/bands/profile.js';
import type { BandInterval } from '../core/bands/boundaries.js';
import { captionFor, readResistorImage } from './read.js';
import {
  captionHeightFor,
  buildAnnotationSvg,
  labelOverflow,
  panelHeightFor,
  blockHeightFor,
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

/**
 * 水平化・色補正した ROI を PNG の data URI にする。
 *
 * **プロファイルと同じ補正を掛ける**（`analysis.adaptation`）。別の補正で
 * 描くと、グラフと画像が違うものを表していることになる。ROI は数千画素
 * しかないので base64 で埋め込んでも SVG は小さい。
 */
async function correctedRoiHref(roi: RoiImage, adaptation: Adaptation | null): Promise<string> {
  const data = new Uint8ClampedArray(roi.data.length);
  for (let index = 0; index < roi.width * roi.height; index += 1) {
    const at = index * 4;
    const lab = srgb255ToLab(
      roi.data[at] as number,
      roi.data[at + 1] as number,
      roi.data[at + 2] as number,
    );
    const { r, g, b } = labToRgb(adaptation === null ? lab : adaptToAnchor(lab, adaptation));
    data[at] = r * 255;
    data[at + 1] = g * 255;
    data[at + 2] = b * 255;
    data[at + 3] = 255;
  }

  const png = await sharp(Buffer.from(data), {
    raw: { width: roi.width, height: roi.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

export interface AnnotateOptions {
  readonly palette?: Palette;
  readonly japanese?: boolean;
  /** 期待値（ファイル名や MANIFEST から分かる場合） */
  readonly expectedOhms?: number;
  /**
   * 人手で確定した境界の区間 [%]。Lab グラフに重ねて、検出のラン境界と
   * 見比べられるようにする。解析には使わない。
   */
  readonly labels?: readonly BandInterval[];
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
  /**
   * 抽出したバンド候補のラン数。検出できなければ 0。
   * 人手で確定した本数と比べて、分割が合っているかを測るのに使う。
   */
  readonly runCount: number;
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
  const read = readResistorImage(image, {
    palette,
    ...(options.expectedOhms === undefined ? {} : { expectedOhms: options.expectedOhms }),
  });
  const caption = captionFor(read, label, options.expectedOhms);

  if (!read.located) {
    const input: AnnotateInput = {
      width: canvasWidth(image, 0),
      height: image.height,
      box: null,
      bands: [],
      rectify: ROI_OPTIONS,
      caption,
      colorSpace: { palette, observed: [] },
      ...(options.japanese === undefined ? {} : { japanese: options.japanese }),
    };
    return {
      jpeg: await composite(image, input),
      caption,
      located: false,
      ohms: null,
      correct: false,
      confident: false,
      runCount: 0,
    };
  }

  const box = read.box as OrientedBox;
  const result = read.analysis as AnalysisResult;
  const joint = read.joint;

  const colorSpace = { palette, observed: result.runs.map((run) => run.lab) };
  const roi = read.roi as RoiImage;
  const strip = {
    href: await correctedRoiHref(roi, result.adaptation),
    roiHeight: roi.height,
    roiWidth: roi.width,
    // 描く位置と解析が読む位置を必ず一致させる（scanRowRanges を共有）
    scanRows: scanRowRanges(roi.height, scanProfileOptions(box)),
    runs: result.runs.map((run) => ({ start: run.start, end: run.end })),
    dropped: new Set(joint?.droppedRuns ?? []),
    roiPadding: ROI_OPTIONS.padding ?? 0,
  };
  const base: AnnotateInput = {
    width: canvasWidth(image, colorSpace.observed.length),
    height: image.height,
    box,
    bands: result.bands,
    rectify: ROI_OPTIONS,
    caption,
    // 表の見出しに添える読み取り値。表の色名・意味と同じ読みから出す
    readingOhms: read.ohms,
    readingConfident: read.confident,
    // 実測色は分類前のランの Lab（基準色にどう引き寄せられたかを見るため）
    colorSpace,
    // 中心線プロファイル。ラン分割が食べている値そのものを描く
    profile: {
      samples: result.profile,
      extent: result.extent,
      runs: result.runs.map((run) => ({ start: run.start, end: run.end })),
    },
    strip,
    ...(joint === null ? {} : { usedRuns: joint.usedRuns, droppedRuns: joint.droppedRuns }),
    ...(options.japanese === undefined ? {} : { japanese: options.japanese }),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
  };
  // 注釈が写真からはみ出す量を測ってから、その分キャンバスを広げる
  const overflow = labelOverflow(base);
  const input: AnnotateInput = { ...base, labelOverflow: overflow };

  return {
    jpeg: await composite(image, input),
    caption,
    located: true,
    ohms: read.ohms,
    correct: read.correct,
    confident: read.confident,
    runCount: result.runs.length,
  };
}

/**
 * 元画像に SVG を焼き込む。キャプション帯・注釈・色空間パネルのぶん
 * キャンバスを広げてから重ねる。
 *
 * 写真の上に重ねると抵抗器が隠れるので、上に帯を作り、下と右に注釈の場所を
 * 作る。注釈が写真の外へはみ出す量も足しておかないと、色空間パネルの上に
 * 文字が重なる。
 */
async function composite(image: RoiImage, input: AnnotateInput): Promise<Buffer> {
  const base = sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  });

  const overflow = input.labelOverflow ?? { right: 0, bottom: 0 };
  // 下に伸ばす分 = 注釈のはみ出し + 一覧表とグラフの帯 + 色空間パネル
  const bottom = overflow.bottom + blockHeightFor(input) + panelHeightFor(input, input.width);
  const right = Math.max(input.width - image.width, overflow.right);

  return base
    .extend({
      top: captionHeightFor(input.caption, input.width),
      bottom,
      right: Math.max(0, right),
      background: '#ffffff',
    })
    .composite([{ input: Buffer.from(buildAnnotationSvg(input)), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** 色空間パネルが収まるキャンバス幅。小さい写真では写真より広くなる。 */
function canvasWidth(image: RoiImage, bandCount: number): number {
  return Math.max(image.width, panelWidthFor(bandCount));
}
