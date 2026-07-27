import { isBrowserDecodable, sniffImageFormat, type ImageFormat } from '../core/imageFormat.js';

/**
 * どの画像形式でも canvas に載せられるようにするデコーダ。
 *
 * ブラウザが自前で読める形式（JPEG / PNG / WebP / GIF / AVIF / BMP）は
 * `createImageBitmap` に任せる。HEIC は Chrome も Firefox も非対応なので、
 * そのときだけ WASM デコーダを**動的 import** する。iPhone の写真は既定で
 * HEIC なので対応しないと実用にならないが、1MB 超あるので常時読み込みは避ける。
 */

/** 形式判定に読む先頭バイト数。ISO-BMFF のブランドまで届けばよい。 */
const HEADER_BYTES = 32;

export interface DecodedImage {
  readonly canvas: HTMLCanvasElement;
  readonly format: ImageFormat;
  /** HEIC のように変換を挟んだ場合 true */
  readonly converted: boolean;
}

async function readHeader(file: Blob): Promise<Uint8Array> {
  const slice = file.slice(0, HEADER_BYTES);
  return new Uint8Array(await slice.arrayBuffer());
}

/** HEIC を PNG に変換する。デコーダはこのときだけ読み込む。 */
async function convertHeic(file: Blob): Promise<Blob> {
  const { heicTo } = await import('heic-to');
  return heicTo({ blob: file, type: 'image/png' });
}

function toCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2D コンテキストを取得できませんでした');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/**
 * 画像ファイルを canvas にデコードする。
 *
 * @throws {Error} 対応していない形式、またはデコードに失敗した場合
 */
export async function decodeImageFile(file: Blob): Promise<DecodedImage> {
  const format = sniffImageFormat(await readHeader(file));

  if (format === 'heic') {
    let converted: Blob;
    try {
      converted = await convertHeic(file);
    } catch (error) {
      throw new Error('HEIC を変換できませんでした', { cause: error });
    }
    return { canvas: toCanvas(await createImageBitmap(converted)), format, converted: true };
  }

  if (!isBrowserDecodable(format)) {
    const label = format === 'unknown' ? '判別できない形式' : format.toUpperCase();
    throw new Error(
      `${label} はブラウザで表示できません。JPEG / PNG / WebP / GIF / AVIF / HEIC に変換してください。`,
    );
  }

  return { canvas: toCanvas(await createImageBitmap(file)), format, converted: false };
}
