import type { ProfileSample } from '../../types.js';
import { srgb255ToLab } from '../color/colorSpace.js';
import { clamp01, medianInPlace } from '../math.js';

/**
 * ROI（水平化済みの抵抗器画像）の生ピクセル。
 * DOM に依存しないよう ImageData そのものではなく最小の構造で受け取る。
 *
 * **不変条件: 長軸は X 方向**。回転した抵抗器は呼び出し側で水平化してから
 * 渡すこと（Phase 3 では OBB の角度で回転補正してから切り出す）。
 */
export interface RoiImage {
  readonly width: number;
  readonly height: number;
  /** RGBA が 4 バイトずつ並んだ配列（ImageData.data と同じ並び） */
  readonly data: Uint8ClampedArray;
}

export interface ProfileOptions {
  /**
   * 長軸に沿ってサンプリングする中央帯の割合 0..1。
   * リード線や輪郭のぼけを避けるため既定では中央 50% のみを使う。
   */
  readonly centerFraction?: number;
}

const DEFAULT_CENTER_FRACTION = 0.5;
const CHANNELS = 4;

/**
 * ROI を長軸方向の 1D カラープロファイルに変換する。
 *
 * 各列について中央帯の複数行をサンプリングし、チャンネルごとの**中央値**を取る。
 * 平均ではなく中央値なのは、光沢ボディの鏡面反射による白飛びが 1〜2 行混じっても
 * 結果が引っ張られないようにするため。
 *
 * @throws {RangeError} data の長さが width×height×4 と一致しない場合
 */
export function extractProfile(image: RoiImage, options: ProfileOptions = {}): ProfileSample[] {
  const { width, height, data } = image;

  if (data.length !== width * height * CHANNELS) {
    throw new RangeError(
      `data length ${data.length} does not match width×height×4 (${width * height * CHANNELS})`,
    );
  }
  if (width <= 0 || height <= 0) return [];

  const centerFraction = clampFraction(options.centerFraction ?? DEFAULT_CENTER_FRACTION);
  const { start: yStart, end: yEnd } = centerRange(height, centerFraction);
  const rowCount = yEnd - yStart;

  // 列ごとに使い回すスクラッチバッファ。medianInPlace が破壊的にソートするが、
  // 次の列で全要素を上書きするので問題ない。
  const reds = new Uint8ClampedArray(rowCount);
  const greens = new Uint8ClampedArray(rowCount);
  const blues = new Uint8ClampedArray(rowCount);

  const samples: ProfileSample[] = [];
  for (let x = 0; x < width; x += 1) {
    for (let i = 0; i < rowCount; i += 1) {
      const offset = ((yStart + i) * width + x) * CHANNELS;
      reds[i] = data[offset] as number;
      greens[i] = data[offset + 1] as number;
      blues[i] = data[offset + 2] as number;
    }
    samples.push({
      x,
      lab: srgb255ToLab(medianInPlace(reds), medianInPlace(greens), medianInPlace(blues)),
    });
  }

  return samples;
}

/** 中央帯の行範囲。少なくとも 1 行は必ず含む。 */
function centerRange(height: number, fraction: number): { start: number; end: number } {
  const bandHeight = Math.max(1, Math.round(height * fraction));
  const start = Math.floor((height - bandHeight) / 2);
  return { start, end: Math.min(height, start + bandHeight) };
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : DEFAULT_CENTER_FRACTION;
}
