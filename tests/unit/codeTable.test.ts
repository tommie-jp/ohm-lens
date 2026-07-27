import { describe, expect, it } from 'vitest';
import {
  digitOf,
  multiplierOf,
  tempCoefficientOf,
  toleranceOf,
} from '../../src/core/value/codeTable.js';

describe('digitOf', () => {
  it.each([
    ['black', 0],
    ['brown', 1],
    ['red', 2],
    ['orange', 3],
    ['yellow', 4],
    ['green', 5],
    ['blue', 6],
    ['violet', 7],
    ['grey', 8],
    ['white', 9],
  ] as const)('%s は数字 %s', (color, expected) => {
    expect(digitOf(color)).toBe(expected);
  });

  it.each(['gold', 'silver'] as const)('%s は数字バンドになれず null を返す', (color) => {
    expect(digitOf(color)).toBeNull();
  });
});

describe('multiplierOf', () => {
  it.each([
    ['black', 1],
    ['brown', 10],
    ['red', 100],
    ['orange', 1000],
    ['yellow', 10_000],
    ['green', 100_000],
    ['blue', 1_000_000],
  ] as const)('%s は倍率 %s', (color, expected) => {
    expect(multiplierOf(color)).toBe(expected);
  });

  it('gold は倍率 0.1', () => {
    expect(multiplierOf('gold')).toBeCloseTo(0.1, 10);
  });

  it('silver は倍率 0.01', () => {
    expect(multiplierOf('silver')).toBeCloseTo(0.01, 10);
  });
});

describe('toleranceOf', () => {
  it.each([
    ['brown', 1],
    ['red', 2],
    ['green', 0.5],
    ['blue', 0.25],
    ['violet', 0.1],
    ['grey', 0.05],
    ['gold', 5],
    ['silver', 10],
  ] as const)('%s は許容差 ±%s%%', (color, expected) => {
    expect(toleranceOf(color)).toBe(expected);
  });

  it.each(['black', 'orange', 'yellow', 'white'] as const)(
    '%s は許容差バンドになれず null を返す',
    (color) => {
      expect(toleranceOf(color)).toBeNull();
    },
  );
});

describe('tempCoefficientOf', () => {
  it.each([
    ['black', 250],
    ['brown', 100],
    ['red', 50],
    ['orange', 15],
    ['yellow', 25],
    ['green', 20],
    ['blue', 10],
    ['violet', 5],
    ['grey', 1],
  ] as const)('%s は温度係数 %s ppm/K', (color, expected) => {
    expect(tempCoefficientOf(color)).toBe(expected);
  });

  it.each(['white', 'gold', 'silver'] as const)(
    '%s は温度係数バンドになれず null を返す',
    (color) => {
      expect(tempCoefficientOf(color)).toBeNull();
    },
  );
});
