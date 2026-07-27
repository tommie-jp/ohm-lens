import { describe, expect, it } from 'vitest';
import { deltaE2000, srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { adaptToAnchor, buildAdaptation } from '../../src/core/color/whiteBalance.js';

describe('buildAdaptation / adaptToAnchor', () => {
  it('観測アンカーが基準と一致するなら色は変化しない', () => {
    // Arrange
    const reference = srgb255ToLab(210, 180, 140);
    const adaptation = buildAdaptation(reference, reference);
    const sample = srgb255ToLab(200, 30, 30);

    // Act
    const adapted = adaptToAnchor(sample, adaptation);

    // Assert
    expect(deltaE2000(adapted, sample)).toBeCloseTo(0, 6);
  });

  it('観測アンカーを基準アンカーへ移す', () => {
    // Arrange: 青被りした環境で撮影された本体色
    const reference = srgb255ToLab(210, 180, 140);
    const observed = srgb255ToLab(180, 175, 190);
    const adaptation = buildAdaptation(observed, reference);

    // Act
    const adapted = adaptToAnchor(observed, adaptation);

    // Assert
    expect(deltaE2000(adapted, reference)).toBeLessThan(1);
  });

  it('色被りしたサンプルを基準側へ近づける', () => {
    // Arrange: 全体が青被り（b* が負方向にずれる）した状況を模す
    const referenceAnchor = srgb255ToLab(210, 180, 140);
    const observedAnchor = { ...referenceAnchor, b: referenceAnchor.b - 20 };
    const trueRed = srgb255ToLab(200, 30, 30);
    const observedRed = { ...trueRed, b: trueRed.b - 20 };
    const adaptation = buildAdaptation(observedAnchor, referenceAnchor);

    // Act
    const adapted = adaptToAnchor(observedRed, adaptation);

    // Assert
    expect(deltaE2000(adapted, trueRed)).toBeLessThan(deltaE2000(observedRed, trueRed));
  });

  it('明度のずれも補正する', () => {
    // Arrange: 露出アンダーで L が一律に低い
    const referenceAnchor = srgb255ToLab(210, 180, 140);
    const observedAnchor = { ...referenceAnchor, l: referenceAnchor.l * 0.7 };
    const adaptation = buildAdaptation(observedAnchor, referenceAnchor);
    const trueGreen = srgb255ToLab(30, 140, 60);
    const observedGreen = { ...trueGreen, l: trueGreen.l * 0.7 };

    // Act
    const adapted = adaptToAnchor(observedGreen, adaptation);

    // Assert
    expect(Math.abs(adapted.l - trueGreen.l)).toBeLessThan(Math.abs(observedGreen.l - trueGreen.l));
  });

  it('L が 0 のアンカーでもゼロ除算せず有限値を返す', () => {
    // Arrange
    const adaptation = buildAdaptation({ l: 0, a: 0, b: 0 }, srgb255ToLab(210, 180, 140));

    // Act
    const adapted = adaptToAnchor(srgb255ToLab(200, 30, 30), adaptation);

    // Assert
    expect(Number.isFinite(adapted.l)).toBe(true);
    expect(Number.isFinite(adapted.a)).toBe(true);
    expect(Number.isFinite(adapted.b)).toBe(true);
  });
});
