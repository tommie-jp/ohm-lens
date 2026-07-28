import { context2d } from './canvas.js';
import { createSampleImage } from './sampleImage.js';

/**
 * 合成サンプル画像を描いた canvas を返す。
 *
 * 画素の組み立ては sampleImage.ts（DOM 非依存）。ここは転写するだけ。
 */
export function createSampleCanvas(): HTMLCanvasElement {
  const image = createSampleImage();

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;

  // ImageData を直接組むと、Uint8ClampedArray の裏付け（ArrayBuffer か
  // SharedArrayBuffer か）の違いで型が合わない。context 側に作らせて詰める。
  const context = context2d(canvas);
  const imageData = context.createImageData(image.width, image.height);
  imageData.data.set(image.data);
  context.putImageData(imageData, 0, 0);

  return canvas;
}
