import { describe, expect, it } from 'vitest';
import { estimateBackground, locateResistor } from '../../src/core/locate.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [240, 240, 240];
const BEIGE: Rgb = [210, 180, 140];

/**
 * 背景の中に、指定した中心・角度・長さ・太さの「棒」を描いた画像を作る。
 * 抵抗器の本体を模したもの。
 */
function drawBar(options: {
  width: number;
  height: number;
  background?: Rgb;
  bar?: Rgb;
  centerX?: number;
  centerY?: number;
  length: number;
  thickness: number;
  angleDeg: number;
  leads?: boolean;
}): RoiImage {
  const {
    width,
    height,
    background = WHITE,
    bar = BEIGE,
    centerX = width / 2,
    centerY = height / 2,
    length,
    thickness,
    angleDeg,
    leads = false,
  } = options;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = background[0];
    data[i * 4 + 1] = background[1];
    data[i * 4 + 2] = background[2];
    data[i * 4 + 3] = 255;
  }

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const paint = (halfLength: number, halfThickness: number, rgb: Rgb): void => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        // 棒のローカル座標へ回す
        const along = dx * cos + dy * sin;
        const across = -dx * sin + dy * cos;
        if (Math.abs(along) <= halfLength && Math.abs(across) <= halfThickness) {
          const offset = (y * width + x) * 4;
          data[offset] = rgb[0];
          data[offset + 1] = rgb[1];
          data[offset + 2] = rgb[2];
        }
      }
    }
  };

  if (leads) paint(length, 1.5, [150, 150, 150]);
  paint(length / 2, thickness / 2, bar);

  return { width, height, data };
}

describe('estimateBackground', () => {
  it('外周から背景色を推定する', () => {
    // Arrange
    const image = drawBar({ width: 80, height: 60, length: 40, thickness: 12, angleDeg: 0 });

    // Act
    const background = estimateBackground(image);

    // Assert: 白背景の L* は高い
    expect(background.l).toBeGreaterThan(90);
  });

  it('被写体が中央にあっても背景に引っ張られない', () => {
    // Arrange: 中央を大きく占める暗い棒
    const image = drawBar({
      width: 80,
      height: 60,
      background: WHITE,
      bar: [20, 20, 20],
      length: 60,
      thickness: 30,
      angleDeg: 0,
    });

    // Act / Assert
    expect(estimateBackground(image).l).toBeGreaterThan(90);
  });
});

describe('locateResistor', () => {
  it.each([0, 15, 30, -25, 45, -45])('角度 %s 度の棒の向きを検出する', (angleDeg) => {
    // Arrange
    const image = drawBar({ width: 200, height: 200, length: 120, thickness: 30, angleDeg });

    // Act
    const box = locateResistor(image);

    // Assert: 軸の向きは 180 度周期なので差を畳んで比較する
    expect(box).not.toBeNull();
    const diff = Math.abs(((box!.angleDeg - angleDeg + 90 + 360) % 180) - 90);
    expect(diff).toBeLessThan(4);
  });

  it('中心位置を検出する', () => {
    // Arrange
    const image = drawBar({
      width: 200,
      height: 200,
      centerX: 70,
      centerY: 120,
      length: 100,
      thickness: 24,
      angleDeg: 0,
    });

    // Act
    const box = locateResistor(image);

    // Assert
    expect(box?.centerX).toBeCloseTo(70, -1);
    expect(box?.centerY).toBeCloseTo(120, -1);
  });

  it('長さと太さを検出する', () => {
    // Arrange
    const image = drawBar({ width: 200, height: 200, length: 100, thickness: 24, angleDeg: 0 });

    // Act
    const box = locateResistor(image);

    // Assert: 量子化と閾値の分だけ幅を持たせる
    expect(box!.length).toBeGreaterThan(85);
    expect(box!.length).toBeLessThan(115);
    expect(box!.thickness).toBeGreaterThan(18);
    expect(box!.thickness).toBeLessThan(32);
  });

  it('細いリード線が伸びていても本体の太さだけを返す', () => {
    // Arrange: 本体の 2 倍の長さまでリード線が伸びている
    const image = drawBar({
      width: 260,
      height: 200,
      length: 100,
      thickness: 24,
      angleDeg: 0,
      leads: true,
    });

    // Act
    const box = locateResistor(image);

    // Assert: リード線(太さ3)に引っ張られず本体の太さになる
    expect(box!.thickness).toBeGreaterThan(15);
    expect(box!.length).toBeLessThan(160);
  });

  it('背景しかない画像では null', () => {
    // Arrange
    const width = 40;
    const height = 30;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 240;
      data[i * 4 + 1] = 240;
      data[i * 4 + 2] = 240;
      data[i * 4 + 3] = 255;
    }

    // Act / Assert
    expect(locateResistor({ width, height, data })).toBeNull();
  });

  it('空画像では null', () => {
    expect(locateResistor({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toBeNull();
  });

  it('ノイズのような孤立点は無視して最大の塊を選ぶ', () => {
    // Arrange: 棒 + 離れた小さな点
    const image = drawBar({ width: 200, height: 200, length: 100, thickness: 24, angleDeg: 0 });
    for (let y = 10; y < 14; y += 1) {
      for (let x = 10; x < 14; x += 1) {
        const offset = (y * 200 + x) * 4;
        image.data[offset] = 10;
        image.data[offset + 1] = 10;
        image.data[offset + 2] = 10;
      }
    }

    // Act
    const box = locateResistor(image);

    // Assert: 孤立点(中心 12,12)ではなく棒(中心 100,100)を選ぶ
    expect(box?.centerX).toBeCloseTo(100, -1);
    expect(box?.centerY).toBeCloseTo(100, -1);
  });
});
