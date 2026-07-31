import { describe, expect, it } from 'vitest';
import { extractProfile, extractProfiles, SCAN_COUNT } from '../../src/core/bands/profile.js';
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

/** 行ごとに単色の ROI 画像を作る（走査線がどの行を見ているかを確かめる）。 */
function rowImage(rows: readonly [number, number, number][], width: number): RoiImage {
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const [r, g, b] = rows[y] as [number, number, number];
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

const RED: [number, number, number] = [200, 30, 30];
const GREEN: [number, number, number] = [30, 140, 60];

describe('extractProfiles', () => {
  it('既定で 7 本の走査線を返す', () => {
    // Arrange
    const image = stripeImage([RED, GREEN], 40);

    // Act
    const profiles = extractProfiles(image);

    // Assert
    expect(SCAN_COUNT).toBe(7);
    expect(profiles).toHaveLength(SCAN_COUNT);
    expect(profiles.every((profile) => profile.length === 2)).toBe(true);
  });

  it('走査線は本体行範囲の内側だけを見る（範囲外の行を混ぜない）', () => {
    // Arrange: 本体は y=8..32 だけが赤、その外は緑（背景・リード線を模す）
    const rows = Array.from({ length: 40 }, (_, y): [number, number, number] =>
      y >= 8 && y < 32 ? RED : GREEN,
    );
    const image = rowImage(rows, 1);
    const red = srgb255ToLab(...RED);

    // Act
    const profiles = extractProfiles(image, { bodyRows: { start: 8, end: 32 } });

    // Assert: どの走査線も緑を含まない
    for (const profile of profiles) {
      expect(profile[0]?.lab.a).toBeCloseTo(red.a, 1);
      expect(profile[0]?.lab.b).toBeCloseTo(red.b, 1);
    }
  });

  it('走査線は重なりなく本体を敷き詰め、上から下へ並ぶ', () => {
    // Arrange: 行番号がそのまま輝度になる画像（走査線の位置を輝度で読む）
    const rows = Array.from({ length: 64 }, (_, y): [number, number, number] => [y * 4, y * 4, y * 4]);
    const image = rowImage(rows, 1);

    // Act
    const profiles = extractProfiles(image, { bodyRows: { start: 0, end: 64 } });

    // Assert: 走査線ごとの明度が単調増加する（上から下の順）
    const lightness = profiles.map((profile) => profile[0]?.lab.l ?? Number.NaN);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i] as number).toBeGreaterThan(lightness[i - 1] as number);
    }
  });

  it('本体行範囲を省略したら中央帯を分割する（従来の走査範囲を保つ）', () => {
    // Arrange: 中央 50% だけ赤、外側は緑
    const rows = Array.from({ length: 40 }, (_, y): [number, number, number] =>
      y >= 10 && y < 30 ? RED : GREEN,
    );
    const image = rowImage(rows, 1);
    const red = srgb255ToLab(...RED);

    // Act
    const profiles = extractProfiles(image);

    // Assert
    for (const profile of profiles) {
      expect(profile[0]?.lab.a).toBeCloseTo(red.a, 1);
    }
  });

  it('本体が走査線の本数より薄くても、各走査線が最低 1 行を見る', () => {
    // Arrange: 本体が 3 行しかない
    const image = stripeImage([RED], 3);

    // Act
    const profiles = extractProfiles(image, { bodyRows: { start: 0, end: 3 } });

    // Assert
    expect(profiles).toHaveLength(SCAN_COUNT);
    for (const profile of profiles) {
      expect(Number.isFinite(profile[0]?.lab.l ?? Number.NaN)).toBe(true);
    }
  });

  it('空画像は空配列を返す', () => {
    expect(extractProfiles({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toEqual([]);
  });
});
