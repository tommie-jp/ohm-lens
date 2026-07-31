import type { RoiImage } from '../core/bands/profile.js';

/** canvas 操作の共通ヘルパー。デバッグページ専用（core/ は DOM 非依存を保つ）。 */

export interface Context2dOptions {
  /** getImageData を繰り返す canvas では true にする */
  readonly willReadFrequently?: boolean;
}

/**
 * 2D コンテキストを取得する。取得できない環境は想定していないので例外にする。
 *
 * @throws {Error} 2D コンテキストを取得できない場合
 */
export function context2d(
  canvas: HTMLCanvasElement,
  options: Context2dOptions = {},
): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', {
    willReadFrequently: options.willReadFrequently ?? false,
  });
  if (context === null) throw new Error('2D コンテキストを取得できませんでした');
  return context;
}

/**
 * 画素をそのまま canvas に転写する（canvas の大きさも画像に合わせる）。
 *
 * ImageData を直接組まないのは、`Uint8ClampedArray` の裏付け（`ArrayBuffer` か
 * `SharedArrayBuffer` か）の違いで型が合わないため。context 側に作らせて詰める。
 * 大きさの代入をガードしているのは、同じ値でも代入するとバッキングストアが
 * 毎回作り直されるから（`drawScaled` と同じ作法）。
 */
export function putPixels(canvas: HTMLCanvasElement, image: RoiImage): void {
  if (canvas.width !== image.width) canvas.width = image.width;
  if (canvas.height !== image.height) canvas.height = image.height;

  const context = context2d(canvas);
  const imageData = context.createImageData(image.width, image.height);
  imageData.data.set(image.data);
  context.putImageData(imageData, 0, 0);
}
