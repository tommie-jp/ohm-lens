import { describe, expect, it } from 'vitest';
import { normalizeLightness } from '../../src/core/bands/normalize.js';
import type { ProfileSample } from '../../src/types.js';

/** L* だけを指定してプロファイルを作る（a*, b* は 0）。 */
function profileOfLightness(values: readonly number[]): ProfileSample[] {
  return values.map((l, x) => ({ x, lab: { l, a: 0, b: 0 } }));
}

function lightnessOf(profile: readonly ProfileSample[]): number[] {
  return profile.map((sample) => sample.lab.l);
}

describe('normalizeLightness', () => {
  it('一様な明度勾配を平坦にする', () => {
    // Arrange: 40 列にわたって L* が 50 → 90 まで直線的に上がる
    const values = Array.from({ length: 40 }, (_, x) => 50 + x);
    const profile = profileOfLightness(values);

    // Act
    const normalized = lightnessOf(normalizeLightness(profile));

    // Assert: 端を除いて平坦になる
    const middle = normalized.slice(5, -5);
    const spread = Math.max(...middle) - Math.min(...middle);
    expect(spread).toBeLessThan(6);
  });

  it('勾配の上に乗ったバンドの落ち込みは保つ', () => {
    // Arrange: 勾配の途中に暗いバンド（L* を 30 下げる）がある
    const values = Array.from({ length: 60 }, (_, x) => {
      const base = 60 + x * 0.5;
      return x >= 26 && x < 34 ? base - 30 : base;
    });

    // Act
    const normalized = lightnessOf(normalizeLightness(profileOfLightness(values)));

    // Assert: バンド位置は周囲より明確に暗いまま
    const band = normalized.slice(27, 33);
    const body = [...normalized.slice(10, 20), ...normalized.slice(40, 50)];
    const bandMax = Math.max(...band);
    const bodyMin = Math.min(...body);
    expect(bodyMin - bandMax).toBeGreaterThan(15);
  });

  it('平坦なプロファイルはほぼそのまま', () => {
    // Arrange
    const profile = profileOfLightness(Array.from({ length: 30 }, () => 70));

    // Act
    const normalized = lightnessOf(normalizeLightness(profile));

    // Assert
    for (const value of normalized) expect(value).toBeCloseTo(70, 6);
  });

  it('a*, b* は変更しない', () => {
    // Arrange
    const profile: ProfileSample[] = Array.from({ length: 30 }, (_, x) => ({
      x,
      lab: { l: 50 + x, a: 12, b: -34 },
    }));

    // Act
    const normalized = normalizeLightness(profile);

    // Assert
    for (const sample of normalized) {
      expect(sample.lab.a).toBe(12);
      expect(sample.lab.b).toBe(-34);
    }
  });

  it('全体の明度水準は保つ', () => {
    // Arrange
    const values = Array.from({ length: 40 }, (_, x) => 50 + x);
    const before = values.reduce((sum, v) => sum + v, 0) / values.length;

    // Act
    const normalized = lightnessOf(normalizeLightness(profileOfLightness(values)));
    const after = normalized.reduce((sum, v) => sum + v, 0) / normalized.length;

    // Assert
    expect(after).toBeCloseTo(before, 0);
  });

  it('空のプロファイルは空配列', () => {
    expect(normalizeLightness([])).toEqual([]);
  });

  it('窓より短いプロファイルでも壊れない', () => {
    // Arrange
    const profile = profileOfLightness([60, 62, 58]);

    // Act
    const normalized = normalizeLightness(profile);

    // Assert
    expect(normalized).toHaveLength(3);
    for (const sample of normalized) expect(Number.isFinite(sample.lab.l)).toBe(true);
  });

  it('窓幅を指定できる', () => {
    // Arrange
    const values = Array.from({ length: 40 }, (_, x) => 50 + x);
    const profile = profileOfLightness(values);

    // Act: 窓が狭いほど勾配をよく追随して平坦化が強く効く
    const narrow = lightnessOf(normalizeLightness(profile, { windowFraction: 0.1 }));
    const wide = lightnessOf(normalizeLightness(profile, { windowFraction: 0.9 }));

    // Assert
    const spread = (list: number[]): number => Math.max(...list) - Math.min(...list);
    expect(spread(narrow.slice(5, -5))).toBeLessThan(spread(wide.slice(5, -5)));
  });
});
