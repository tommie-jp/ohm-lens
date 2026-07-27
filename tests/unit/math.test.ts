import { describe, expect, it } from 'vitest';
import { clamp, clamp01, medianInPlace, normalizedMargin } from '../../src/core/math.js';

describe('clamp', () => {
  it.each([
    [5, 0, 10, 5],
    [-1, 0, 10, 0],
    [11, 0, 10, 10],
  ])('clamp(%s, %s, %s) → %s', (value, min, max, expected) => {
    expect(clamp(value, min, max)).toBe(expected);
  });
});

describe('clamp01', () => {
  it.each([
    [0.5, 0.5],
    [-0.1, 0],
    [1.5, 1],
  ])('clamp01(%s) → %s', (value, expected) => {
    expect(clamp01(value)).toBe(expected);
  });
});

describe('medianInPlace', () => {
  it('奇数個は中央の値', () => {
    expect(medianInPlace(Float64Array.from([3, 1, 2]))).toBe(2);
  });

  it('偶数個は中央 2 つの平均', () => {
    expect(medianInPlace(Float64Array.from([4, 1, 3, 2]))).toBe(2.5);
  });

  it('外れ値に引っ張られない', () => {
    expect(medianInPlace(Float64Array.from([10, 10, 10, 10, 1000]))).toBe(10);
  });

  it('空配列は NaN', () => {
    expect(medianInPlace(new Float64Array(0))).toBeNaN();
  });

  it('Uint8ClampedArray でも動く', () => {
    expect(medianInPlace(Uint8ClampedArray.from([200, 30, 100]))).toBe(100);
  });

  it('引数を破壊的にソートする（呼び出し側はスクラッチバッファを渡す）', () => {
    // Arrange
    const values = Float64Array.from([3, 1, 2]);

    // Act
    medianInPlace(values);

    // Assert
    expect(Array.from(values)).toEqual([1, 2, 3]);
  });
});

describe('normalizedMargin', () => {
  it('差が大きいほど 1 に近づく', () => {
    expect(normalizedMargin(0, 100)).toBeCloseTo(1, 6);
  });

  it('同値なら 0', () => {
    expect(normalizedMargin(5, 5)).toBe(0);
  });

  it('両方 0 なら 0（ゼロ除算しない）', () => {
    expect(normalizedMargin(0, 0)).toBe(0);
  });

  it('常に 0..1 に収まる', () => {
    for (const [a, b] of [
      [1, 3],
      [3, 1],
      [0.5, 40],
    ] as const) {
      const margin = normalizedMargin(a, b);
      expect(margin).toBeGreaterThanOrEqual(0);
      expect(margin).toBeLessThanOrEqual(1);
    }
  });
});
