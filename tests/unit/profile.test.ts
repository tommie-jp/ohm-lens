import { describe, expect, it } from 'vitest';
import { extractProfile } from '../../src/core/bands/profile.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

/** テスト用に、列ごとに単色の ROI 画像を作る。 */
function stripeImage(columns: readonly [number, number, number][], height: number): RoiImage {
  const width = columns.length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = columns[x] as [number, number, number];
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('extractProfile', () => {
  it('列ごとに 1 サンプルを返す', () => {
    // Arrange
    const image = stripeImage(
      [
        [200, 30, 30],
        [30, 140, 60],
        [40, 70, 180],
      ],
      10,
    );

    // Act
    const profile = extractProfile(image);

    // Assert
    expect(profile).toHaveLength(3);
    expect(profile.map((sample) => sample.x)).toEqual([0, 1, 2]);
  });

  it('単色の列はその色の Lab を返す', () => {
    // Arrange
    const image = stripeImage([[200, 30, 30]], 10);
    const expected = srgb255ToLab(200, 30, 30);

    // Act
    const profile = extractProfile(image);

    // Assert
    expect(profile[0]?.lab.l).toBeCloseTo(expected.l, 6);
    expect(profile[0]?.lab.a).toBeCloseTo(expected.a, 6);
    expect(profile[0]?.lab.b).toBeCloseTo(expected.b, 6);
  });

  it('外れ値のあるノイズ列でも中央値で安定する', () => {
    // Arrange: 高さ 9 の列のうち中央付近 1 行だけ白飛び（鏡面反射を模す）
    const width = 1;
    const height = 9;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const isHighlight = y === 4;
      const offset = y * 4;
      data[offset] = isHighlight ? 255 : 200;
      data[offset + 1] = isHighlight ? 255 : 30;
      data[offset + 2] = isHighlight ? 255 : 30;
      data[offset + 3] = 255;
    }

    // Act
    const profile = extractProfile({ width, height, data });

    // Assert: 中央値なので白飛びに引っ張られない
    const expected = srgb255ToLab(200, 30, 30);
    expect(profile[0]?.lab.l).toBeCloseTo(expected.l, 6);
  });

  it('中央帯のみをサンプリングする（上下端のリード線を無視する）', () => {
    // Arrange: 上下 40% は緑、中央 20% は赤
    const width = 1;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const isCenter = y >= 4 && y < 6;
      const offset = y * 4;
      data[offset] = isCenter ? 200 : 30;
      data[offset + 1] = isCenter ? 30 : 140;
      data[offset + 2] = isCenter ? 30 : 60;
      data[offset + 3] = 255;
    }

    // Act: 中央 20% だけを使う
    const profile = extractProfile({ width, height, data }, { centerFraction: 0.2 });

    // Assert
    const red = srgb255ToLab(200, 30, 30);
    expect(profile[0]?.lab.a).toBeCloseTo(red.a, 1);
  });

  it('高さ 1 の画像でも動作する', () => {
    const profile = extractProfile(stripeImage([[200, 30, 30]], 1));

    expect(profile).toHaveLength(1);
    expect(Number.isFinite(profile[0]?.lab.l ?? Number.NaN)).toBe(true);
  });

  it.each([
    [0, 10],
    [10, 0],
  ])('幅 %s 高さ %s の空画像は空配列を返す', (width, height) => {
    const data = new Uint8ClampedArray(Math.max(0, width * height * 4));

    expect(extractProfile({ width, height, data })).toEqual([]);
  });

  it('data の長さが width×height×4 と合わなければ RangeError', () => {
    expect(() => extractProfile({ width: 4, height: 4, data: new Uint8ClampedArray(8) })).toThrow(
      RangeError,
    );
  });
});
