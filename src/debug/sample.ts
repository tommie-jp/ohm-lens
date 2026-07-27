import { BAND_SRGB, BODY_SRGB, type Srgb255 } from '../core/color/colors.js';
import { context2d } from './canvas.js';

/**
 * 画像が手元に無くても動作確認できるよう、抵抗器を模した合成画像を生成する。
 * 4.7kΩ ±5%（yellow-violet-red-gold）のベージュ本体。
 *
 * 色は基準色テーブルから引く。Step 0-7 で基準色を較正したとき、
 * サンプルだけ古い色のまま取り残されないようにするため。
 */

const BODY = BODY_SRGB.beige;

const LAYOUT: readonly (readonly [Srgb255, number])[] = [
  [BODY, 40],
  [BAND_SRGB.yellow, 14],
  [BODY, 12],
  [BAND_SRGB.violet, 14],
  [BODY, 12],
  [BAND_SRGB.red, 14],
  [BODY, 26],
  [BAND_SRGB.gold, 14],
  [BODY, 40],
];

const BODY_HEIGHT_RATIO = 0.55;
const CANVAS_HEIGHT = 120;
const DESK_COLOR = '#f0f0f0';
const LEAD_COLOR = '#9a9a9a';
const LEAD_WIDTH = 3;

/** 合成サンプル画像を描いた canvas を返す。 */
export function createSampleCanvas(): HTMLCanvasElement {
  const columns: Srgb255[] = [];
  for (const [rgb, count] of LAYOUT) {
    for (let i = 0; i < count; i += 1) columns.push(rgb);
  }

  const canvas = document.createElement('canvas');
  canvas.width = columns.length;
  canvas.height = CANVAS_HEIGHT;

  const context = context2d(canvas);

  // 背景（白い机を想定）
  context.fillStyle = DESK_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // リード線
  const leadY = Math.round(canvas.height / 2);
  context.strokeStyle = LEAD_COLOR;
  context.lineWidth = LEAD_WIDTH;
  context.beginPath();
  context.moveTo(0, leadY);
  context.lineTo(canvas.width, leadY);
  context.stroke();

  // 本体とバンド
  const bodyHeight = Math.round(canvas.height * BODY_HEIGHT_RATIO);
  const bodyTop = Math.round((canvas.height - bodyHeight) / 2);
  columns.forEach((rgb, x) => {
    context.fillStyle = `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
    context.fillRect(x, bodyTop, 1, bodyHeight);
  });

  return canvas;
}
