import type { RoiImage } from './bands/profile.js';
import type { OrientedBox } from './locate.js';
import { clamp } from './math.js';

/**
 * 回転バウンディングボックスに沿って画像を切り出し、長軸を水平に揃える。
 *
 * OpenCV.js の warpAffine 相当だが、必要なのはこの 1 機能だけなので
 * 依存を足さずに実装する（設計メモ §2 [2]/[3]）。Phase 1 以降、
 * ブラウザ側では OffscreenCanvas の 2D コンテキストでも同じことができる。
 */

export interface RectifyOptions {
  /** 本体の外側をどれだけ含めるか（長さ・太さに対する割合） */
  readonly padding?: number;
  /** 出力の高さ [px]。指定するとアスペクト比を保って拡縮する。 */
  readonly targetHeight?: number;
}

const CHANNELS = 4;
const DEFAULT_PADDING = 0;

/**
 * 双一次補間で 1 画素を取り出す。画像の外側は端の画素で埋める
 * （エッジクランプ）。回転で角が画像外にはみ出しても破綻させないため。
 */
function sampleBilinear(image: RoiImage, x: number, y: number, out: Uint8ClampedArray, at: number): void {
  const { width, height, data } = image;

  const clampedX = clamp(x, 0, width - 1);
  const clampedY = clamp(y, 0, height - 1);

  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const offset00 = (y0 * width + x0) * CHANNELS;
  const offset10 = (y0 * width + x1) * CHANNELS;
  const offset01 = (y1 * width + x0) * CHANNELS;
  const offset11 = (y1 * width + x1) * CHANNELS;

  for (let channel = 0; channel < 3; channel += 1) {
    const top =
      (data[offset00 + channel] as number) * (1 - fx) + (data[offset10 + channel] as number) * fx;
    const bottom =
      (data[offset01 + channel] as number) * (1 - fx) + (data[offset11 + channel] as number) * fx;
    out[at + channel] = top * (1 - fy) + bottom * fy;
  }
  out[at + 3] = 255;
}

/**
 * ボックスに沿って切り出し、水平化した画像を返す。
 *
 * 出力画像の X 軸がボックスの長軸に対応する（`extractProfile` の
 * 「長軸は X 方向」という不変条件を満たす）。
 */
export function rectify(image: RoiImage, box: OrientedBox, options: RectifyOptions = {}): RoiImage {
  const padding = options.padding ?? DEFAULT_PADDING;
  const sourceLength = Math.max(1, box.length * (1 + padding * 2));
  const sourceThickness = Math.max(1, box.thickness * (1 + padding * 2));

  const outputHeight =
    options.targetHeight === undefined
      ? Math.max(1, Math.round(sourceThickness))
      : Math.max(1, Math.round(options.targetHeight));
  const scale = outputHeight / sourceThickness;
  const outputWidth = Math.max(1, Math.round(sourceLength * scale));

  const rad = (box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const data = new Uint8ClampedArray(outputWidth * outputHeight * CHANNELS);

  for (let outY = 0; outY < outputHeight; outY += 1) {
    // 出力の中心を原点とした座標に直してから、元画像へ回して戻す
    const across = (outY + 0.5) / scale - sourceThickness / 2;
    for (let outX = 0; outX < outputWidth; outX += 1) {
      const along = (outX + 0.5) / scale - sourceLength / 2;
      const sourceX = box.centerX + along * cos - across * sin;
      const sourceY = box.centerY + along * sin + across * cos;
      sampleBilinear(image, sourceX, sourceY, data, (outY * outputWidth + outX) * CHANNELS);
    }
  }

  return { width: outputWidth, height: outputHeight, data };
}
