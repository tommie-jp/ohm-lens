import { putPixels } from './canvas.js';
import { createSampleImage } from './sampleImage.js';

/**
 * 合成サンプル画像を描いた canvas を返す。
 *
 * 画素の組み立ては sampleImage.ts（DOM 非依存）。ここは転写するだけ。
 */
export function createSampleCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  putPixels(canvas, createSampleImage());
  return canvas;
}
