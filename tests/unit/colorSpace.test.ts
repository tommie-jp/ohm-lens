import { describe, expect, it } from 'vitest';
import {
  deltaE2000,
  labToCss,
  labToRgb,
  rgbToLab,
  srgb255ToLab,
} from '../../src/core/color/colorSpace.js';

describe('rgbToLab', () => {
  it('白 (1,1,1) は L≈100, a≈0, b≈0', () => {
    // Act
    const lab = rgbToLab({ r: 1, g: 1, b: 1 });

    // Assert
    expect(lab.l).toBeCloseTo(100, 1);
    expect(lab.a).toBeCloseTo(0, 1);
    expect(lab.b).toBeCloseTo(0, 1);
  });

  it('黒 (0,0,0) は L≈0', () => {
    const lab = rgbToLab({ r: 0, g: 0, b: 0 });

    expect(lab.l).toBeCloseTo(0, 1);
  });

  it('赤 (1,0,0) は a が大きく正', () => {
    const lab = rgbToLab({ r: 1, g: 0, b: 0 });

    expect(lab.a).toBeGreaterThan(50);
  });

  it('青 (0,0,1) は b が大きく負', () => {
    const lab = rgbToLab({ r: 0, g: 0, b: 1 });

    expect(lab.b).toBeLessThan(-50);
  });
});

describe('srgb255ToLab', () => {
  it('0..255 の整数を受け取り rgbToLab と一致する', () => {
    // Act
    const fromBytes = srgb255ToLab(255, 0, 0);
    const fromUnit = rgbToLab({ r: 1, g: 0, b: 0 });

    // Assert
    expect(fromBytes.l).toBeCloseTo(fromUnit.l, 6);
    expect(fromBytes.a).toBeCloseTo(fromUnit.a, 6);
    expect(fromBytes.b).toBeCloseTo(fromUnit.b, 6);
  });
});

describe('labToRgb', () => {
  it('rgbToLab の逆変換になっている', () => {
    // Arrange
    const original = { r: 0.8, g: 0.2, b: 0.3 };

    // Act
    const roundTrip = labToRgb(rgbToLab(original));

    // Assert
    expect(roundTrip.r).toBeCloseTo(original.r, 6);
    expect(roundTrip.g).toBeCloseTo(original.g, 6);
    expect(roundTrip.b).toBeCloseTo(original.b, 6);
  });

  it('色域外の Lab は 0..1 にクランプする', () => {
    // Arrange: sRGB で表現できない極端に彩度の高い色
    const outOfGamut = { l: 60, a: 120, b: -120 };

    // Act
    const rgb = labToRgb(outOfGamut);

    // Assert
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe('labToCss', () => {
  it('rgb() 表記の文字列を返す', () => {
    expect(labToCss(srgb255ToLab(200, 30, 30))).toBe('rgb(200 30 30)');
  });

  it('白は rgb(255 255 255)', () => {
    expect(labToCss(srgb255ToLab(255, 255, 255))).toBe('rgb(255 255 255)');
  });
});

describe('deltaE2000', () => {
  it('同一色の色差は 0', () => {
    // Arrange
    const lab = srgb255ToLab(128, 64, 32);

    // Act / Assert
    expect(deltaE2000(lab, lab)).toBeCloseTo(0, 9);
  });

  it('色差は対称', () => {
    const a = srgb255ToLab(200, 30, 30);
    const b = srgb255ToLab(30, 200, 30);

    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 9);
  });

  it('似た色ほど色差が小さい', () => {
    // Arrange
    const red = srgb255ToLab(200, 30, 30);
    const slightlyDifferentRed = srgb255ToLab(205, 35, 30);
    const green = srgb255ToLab(30, 200, 30);

    // Act / Assert
    expect(deltaE2000(red, slightlyDifferentRed)).toBeLessThan(deltaE2000(red, green));
  });

  it('茶と赤は HSV より Lab+ΔE2000 の方が分離できる程度の差がある', () => {
    // Arrange: 実際の抵抗バンドに近い茶と赤
    const brown = srgb255ToLab(102, 51, 0);
    const red = srgb255ToLab(200, 30, 30);

    // Act / Assert
    expect(deltaE2000(brown, red)).toBeGreaterThan(10);
  });
});
