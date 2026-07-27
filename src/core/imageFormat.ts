/**
 * 画像形式の判定。
 *
 * 拡張子は当てにならない（iPhone から取り込むと .jpg のまま中身が HEIC、
 * といったことが普通に起きる）ので、先頭のマジックバイトで判定する。
 */

export type ImageFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'heic'
  | 'bmp'
  | 'tiff'
  | 'unknown';

/** ファイル選択ダイアログに出す accept 属性。 */
export const SUPPORTED_ACCEPT =
  'image/*,.jpg,.jpeg,.png,.webp,.gif,.avif,.heic,.heif,.bmp,.tif,.tiff';

/** ISO-BMFF（`ftyp` ボックス）のブランドのうち HEIC 系のもの。 */
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis',
  'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1',
]);

/** 同じく AVIF 系のブランド。 */
const AVIF_BRANDS = new Set(['avif', 'avis']);

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i] as number);
  return text;
}

/**
 * 先頭バイト列から画像形式を判定する。判別できなければ `unknown`。
 *
 * @param bytes ファイル先頭の数十バイトがあれば足りる
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';

  const leading = asciiAt(bytes, 0, 6);
  if (leading === 'GIF87a' || leading === 'GIF89a') return 'gif';
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'webp';

  // ISO-BMFF: 先頭 4 バイトがボックス長、続く 4 バイトが 'ftyp'、その次がブランド
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4);
    if (AVIF_BRANDS.has(brand)) return 'avif';
    if (HEIC_BRANDS.has(brand)) return 'heic';
  }

  if (matches(bytes, 0, [0x42, 0x4d])) return 'bmp';
  if (matches(bytes, 0, [0x49, 0x49, 0x2a, 0x00])) return 'tiff';
  if (matches(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';

  return 'unknown';
}

/**
 * ブラウザが `createImageBitmap` で直接デコードできる形式か。
 *
 * HEIC は主要ブラウザ（Chrome / Firefox）が対応しておらず、別途デコーダが要る。
 * TIFF も同様に非対応。
 */
export function isBrowserDecodable(format: ImageFormat): boolean {
  return format === 'jpeg' || format === 'png' || format === 'webp' || format === 'gif' ||
    format === 'avif' || format === 'bmp';
}
