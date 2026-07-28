import { BAND_SRGB, BODY_SRGB, type Srgb255 } from '../core/color/colors.js';
import type { RoiImage } from '../core/bands/profile.js';

/**
 * 画像が手元に無くても動作確認できるよう、抵抗器を模した画像を組み立てる。
 * 4.7kΩ ±5%（yellow-violet-red-gold）のベージュ本体。
 *
 * DOM に触らないのは、検出できることをテストから確かめられるようにするため。
 * 描画（canvas への転写）は sample.ts が行う。
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
const SCENE_HEIGHT = 120;
const DESK_COLOR: Srgb255 = [240, 240, 240];
const LEAD_COLOR: Srgb255 = [154, 154, 154];
const LEAD_HALF_WIDTH = 1;

/**
 * 抵抗器の周りに空ける余白の倍率。
 *
 * 抵抗器で画面を埋めてはいけない。検出は「前景が 35% を超えるのは机の質感を
 * 拾っている状態」とみなして閾値を上げ直す（locate.ts の buildMask）。
 * 余白なしだと本体が画面の 55% を占めるため、この保護が働いて本体そのものが
 * 背景側に落ち、彩度の高いバンド 4 本だけが前景として残る。結果、縦長の
 * バンドが抵抗器と誤認されて 90°・65px の箱になり、バンドを 1 本も
 * 読めなくなる。実写と同じく画面の 1 割強に収める。
 */
const FRAME_SCALE = 2;

/** 期待される読み取り結果。テストと UI の説明文で参照する。 */
export const SAMPLE_EXPECTED = { ohms: 4700, tolerancePercent: 5 } as const;

/** 合成サンプル画像を組み立てて返す。 */
export function createSampleImage(): RoiImage {
  const columns: Srgb255[] = [];
  for (const [rgb, count] of LAYOUT) {
    for (let i = 0; i < count; i += 1) columns.push(rgb);
  }

  const width = columns.length * FRAME_SCALE;
  const height = SCENE_HEIGHT * FRAME_SCALE;
  const data = new Uint8ClampedArray(width * height * 4);

  const put = (x: number, y: number, rgb: Srgb255): void => {
    const offset = (y * width + x) * 4;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  };

  // 背景（白い机を想定）
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) put(x, y, DESK_COLOR);
  }

  // リード線。抵抗器は画面の中央に置く
  const leadY = Math.round(height / 2);
  for (let y = leadY - LEAD_HALF_WIDTH; y <= leadY + LEAD_HALF_WIDTH; y += 1) {
    for (let x = 0; x < width; x += 1) put(x, y, LEAD_COLOR);
  }

  // 本体とバンド
  const bodyHeight = Math.round(SCENE_HEIGHT * BODY_HEIGHT_RATIO);
  const bodyTop = Math.round((height - bodyHeight) / 2);
  const bodyLeft = Math.round((width - columns.length) / 2);
  columns.forEach((rgb, index) => {
    for (let y = bodyTop; y < bodyTop + bodyHeight; y += 1) put(bodyLeft + index, y, rgb);
  });

  return { data, width, height };
}
