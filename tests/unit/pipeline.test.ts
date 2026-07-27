import { describe, expect, it } from 'vitest';
import { analyzeRoi } from '../../src/core/pipeline.js';
import { estimateBodyAnchor } from '../../src/core/color/anchor.js';
import { deltaE2000, srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BODY_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import { extractProfile, type RoiImage } from '../../src/core/bands/profile.js';

type Rgb = [number, number, number];

const BEIGE: Rgb = [210, 180, 140];
const YELLOW: Rgb = [235, 210, 50];
const VIOLET: Rgb = [120, 70, 160];
const RED: Rgb = [200, 30, 30];
const GOLD: Rgb = [200, 160, 50];

/** 「4.7kΩ ±5%」の抵抗器を模した ROI を作る。 */
function buildResistorRoi(cast: Rgb = [255, 255, 255]): RoiImage {
  const layout: [Rgb, number][] = [
    [BEIGE, 12],
    [YELLOW, 6],
    [BEIGE, 5],
    [VIOLET, 6],
    [BEIGE, 5],
    [RED, 6],
    [BEIGE, 10],
    [GOLD, 6],
    [BEIGE, 14],
  ];

  const columns: Rgb[] = [];
  for (const [rgb, count] of layout) {
    for (let i = 0; i < count; i += 1) {
      columns.push([
        (rgb[0] * cast[0]) / 255,
        (rgb[1] * cast[1]) / 255,
        (rgb[2] * cast[2]) / 255,
      ]);
    }
  }

  const width = columns.length;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = columns[x] as Rgb;
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('estimateBodyAnchor', () => {
  it('本体色が支配的なプロファイルから本体色を推定する', () => {
    // Arrange
    const profile = extractProfile(buildResistorRoi());

    // Act
    const anchor = estimateBodyAnchor(profile);

    // Assert
    expect(anchor).not.toBeNull();
    expect(deltaE2000(anchor as never, BODY_REFERENCE_COLORS.beige)).toBeLessThan(5);
  });

  it('空のプロファイルでは null', () => {
    expect(estimateBodyAnchor([])).toBeNull();
  });
});

describe('analyzeRoi', () => {
  it('合成 ROI から 4.7kΩ ±5% を読み取る', () => {
    // Arrange
    const roi = buildResistorRoi();

    // Act
    const result = analyzeRoi(roi);

    // Assert
    expect(result.bands.map((band) => band.color)).toEqual(['yellow', 'violet', 'red', 'gold']);
    expect(result.reading?.ohms).toBeCloseTo(4700, 6);
    expect(result.reading?.tolerance).toBe(5);
    expect(result.reading?.direction).toBe('ltr');
  });

  it('中間結果（プロファイルとバンド）も返す', () => {
    const result = analyzeRoi(buildResistorRoi());

    expect(result.profile.length).toBeGreaterThan(0);
    expect(result.bands).toHaveLength(4);
  });

  it('色被りした画像でも色順応補正を有効にすれば読み取れる', () => {
    // Arrange: 青被り（赤と緑を落とす）
    const roi = buildResistorRoi([200, 220, 255]);

    // Act
    const result = analyzeRoi(roi, { adaptWhiteBalance: true });

    // Assert
    expect(result.reading?.ohms).toBeCloseTo(4700, 6);
  });

  it('色順応補正の有無を選べる', () => {
    // Arrange
    const roi = buildResistorRoi();

    // Act
    const adapted = analyzeRoi(roi, { adaptWhiteBalance: true });
    const raw = analyzeRoi(roi, { adaptWhiteBalance: false });

    // Assert: 色被りが無い画像ではどちらでも同じ結果
    expect(adapted.reading?.ohms).toBeCloseTo(raw.reading?.ohms ?? 0, 6);
  });

  it('バンドが見つからなければ reading は null', () => {
    // Arrange: 本体色だけの ROI
    const width = 20;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 210;
      data[i * 4 + 1] = 180;
      data[i * 4 + 2] = 140;
      data[i * 4 + 3] = 255;
    }

    // Act
    const result = analyzeRoi({ width, height, data });

    // Assert
    expect(result.bands).toEqual([]);
    expect(result.reading).toBeNull();
  });

  it('空画像でも例外を投げず null を返す', () => {
    const result = analyzeRoi({ width: 0, height: 0, data: new Uint8ClampedArray(0) });

    expect(result.reading).toBeNull();
    expect(result.profile).toEqual([]);
  });

  it('補正に使ったアンカーを結果に含める', () => {
    const result = analyzeRoi(buildResistorRoi(), { adaptWhiteBalance: true });

    expect(result.anchor).not.toBeNull();
    expect(Number.isFinite(result.anchor?.l ?? Number.NaN)).toBe(true);
  });

  it('本体色に近い色でも純粋な白は本体と誤認しない', () => {
    // Arrange: 白バンドが本体色として除去されないことの確認
    const white = srgb255ToLab(245, 245, 245);

    // Act / Assert
    expect(deltaE2000(white, BODY_REFERENCE_COLORS.beige)).toBeGreaterThan(12);
  });
});
