import type { Band, ProfileSample } from '../types.js';
import { labToRgb } from '../core/color/colorSpace.js';
import { clamp01 } from '../core/math.js';
import { context2d } from './canvas.js';

/**
 * 1D カラープロファイルの可視化。
 * 上段は補正後の色そのもの、下段は L*、その下に抽出されたバンド範囲を描く。
 */

const COLOR_STRIP_HEIGHT = 32;
const LIGHTNESS_PLOT_HEIGHT = 48;
const BAND_MARKER_HEIGHT = 10;
const MAX_LIGHTNESS = 100;

const CANVAS_HEIGHT = COLOR_STRIP_HEIGHT + LIGHTNESS_PLOT_HEIGHT + BAND_MARKER_HEIGHT;

export function drawProfile(
  canvas: HTMLCanvasElement,
  profile: readonly ProfileSample[],
  bands: readonly Band[],
): void {
  canvas.width = Math.max(1, profile.length);
  canvas.height = CANVAS_HEIGHT;

  const context = context2d(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (profile.length === 0) return;

  drawColorStrip(context, profile);
  drawLightnessPlot(context, profile);
  drawBandMarkers(context, bands);
}

/**
 * 色帯は 1px ずつ fillRect すると列数ぶんの状態変更が走るので、
 * ImageData を組み立てて一度に転送する。
 */
function drawColorStrip(
  context: CanvasRenderingContext2D,
  profile: readonly ProfileSample[],
): void {
  const strip = context.createImageData(profile.length, COLOR_STRIP_HEIGHT);

  profile.forEach((sample, x) => {
    const { r, g, b } = labToRgb(sample.lab);
    for (let y = 0; y < COLOR_STRIP_HEIGHT; y += 1) {
      const offset = (y * profile.length + x) * 4;
      strip.data[offset] = Math.round(r * 255);
      strip.data[offset + 1] = Math.round(g * 255);
      strip.data[offset + 2] = Math.round(b * 255);
      strip.data[offset + 3] = 255;
    }
  });

  context.putImageData(strip, 0, 0);
}

function drawLightnessPlot(
  context: CanvasRenderingContext2D,
  profile: readonly ProfileSample[],
): void {
  const top = COLOR_STRIP_HEIGHT;

  context.fillStyle = 'rgb(0 0 0 / 0.06)';
  context.fillRect(0, top, context.canvas.width, LIGHTNESS_PLOT_HEIGHT);

  context.strokeStyle = '#e05050';
  context.lineWidth = 1;
  context.beginPath();
  profile.forEach((sample, index) => {
    const ratio = clamp01(sample.lab.l / MAX_LIGHTNESS);
    const y = top + LIGHTNESS_PLOT_HEIGHT - ratio * LIGHTNESS_PLOT_HEIGHT;
    if (index === 0) context.moveTo(index, y);
    else context.lineTo(index, y);
  });
  context.stroke();
}

function drawBandMarkers(context: CanvasRenderingContext2D, bands: readonly Band[]): void {
  const top = COLOR_STRIP_HEIGHT + LIGHTNESS_PLOT_HEIGHT;

  for (const band of bands) {
    // 確信度が低いバンドほど薄く描く
    context.fillStyle = `rgb(0 176 255 / ${0.25 + 0.75 * clamp01(band.confidence)})`;
    context.fillRect(band.start, top, band.end - band.start, BAND_MARKER_HEIGHT);
  }
}
