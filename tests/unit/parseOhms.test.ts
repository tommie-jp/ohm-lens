import { describe, expect, it } from 'vitest';
import { parseOhms } from '../../src/core/value/parseOhms.js';

describe('parseOhms', () => {
  it.each([
    ['220', 220],
    ['47', 47],
    ['4.7', 4.7],
    ['0.47', 0.47],
    ['4.7k', 4700],
    ['4.7K', 4700],
    ['10k', 10_000],
    ['1M', 1_000_000],
    ['10M', 10_000_000],
    ['2.2m', 2_200_000],
  ])('"%s" → %s Ω', (input, expected) => {
    expect(parseOhms(input)).toBeCloseTo(expected, 9);
  });

  it.each([
    ['4k7', 4700],
    ['1k5', 1500],
    ['4R7', 4.7],
    ['R47', 0.47],
    ['1M2', 1_200_000],
  ])('部品表記 "%s" → %s Ω', (input, expected) => {
    expect(parseOhms(input)).toBeCloseTo(expected, 9);
  });

  it.each([
    ['220Ω', 220],
    ['4.7kΩ', 4700],
    ['4.7 kΩ', 4700],
    ['220 ohm', 220],
    ['１０ｋ', 10_000],
  ])('単位や全角つき "%s" → %s Ω', (input, expected) => {
    expect(parseOhms(input)).toBeCloseTo(expected, 9);
  });

  it.each(['', '   ', 'abc', '4.7x', '--3', 'k', '0', '-5'])(
    '不正な入力 "%s" は null',
    (input) => {
      expect(parseOhms(input)).toBeNull();
    },
  );
});
