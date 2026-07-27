import { describe, expect, it } from 'vitest';
import { alignRunsToBands } from '../../src/core/bands/align.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor } from '../../src/types.js';

function labOf(color: BandColor): LabColor {
  const [r, g, b] = BAND_SRGB[color];
  return srgb255ToLab(r, g, b);
}

function runsOf(colors: readonly BandColor[]): { lab: LabColor; width: number }[] {
  return colors.map((color) => ({ lab: labOf(color), width: 5 }));
}

describe('alignRunsToBands', () => {
  it('本数が一致していれば素直に対応付ける', () => {
    // Arrange
    const runs = runsOf(['yellow', 'violet', 'red', 'gold']);

    // Act
    const result = alignRunsToBands(runs, ['yellow', 'violet', 'red', 'gold']);

    // Assert
    expect(result?.assignments).toEqual([
      { runIndex: 0, color: 'yellow' },
      { runIndex: 1, color: 'violet' },
      { runIndex: 2, color: 'red' },
      { runIndex: 3, color: 'gold' },
    ]);
  });

  it('余分なランを飛ばして対応付ける', () => {
    // Arrange: 先頭と途中にノイズのランが混ざっている
    const runs = runsOf(['white', 'yellow', 'violet', 'grey', 'red', 'gold']);

    // Act
    const result = alignRunsToBands(runs, ['yellow', 'violet', 'red', 'gold']);

    // Assert: ノイズ（index 0 と 3）が飛ばされる
    expect(result?.assignments.map((a) => a.runIndex)).toEqual([1, 2, 4, 5]);
  });

  it('ランが足りなければ null', () => {
    const runs = runsOf(['yellow', 'violet']);

    expect(alignRunsToBands(runs, ['yellow', 'violet', 'red', 'gold'])).toBeNull();
  });

  it('飛ばせる本数に上限を設けられる', () => {
    // Arrange: 4 本に対してランが 8 本（4 本余分）
    const runs = runsOf(['white', 'white', 'yellow', 'violet', 'white', 'red', 'gold', 'white']);

    // Act / Assert
    expect(alignRunsToBands(runs, ['yellow', 'violet', 'red', 'gold'], { maxSkips: 2 })).toBeNull();
    expect(
      alignRunsToBands(runs, ['yellow', 'violet', 'red', 'gold'], { maxSkips: 4 }),
    ).not.toBeNull();
  });

  it('総コストを返す（小さいほど確からしい）', () => {
    // Arrange
    const exact = runsOf(['yellow', 'violet', 'red', 'gold']);
    const wrong = runsOf(['green', 'blue', 'black', 'white']);

    // Act
    const good = alignRunsToBands(exact, ['yellow', 'violet', 'red', 'gold']);
    const bad = alignRunsToBands(wrong, ['yellow', 'violet', 'red', 'gold']);

    // Assert
    expect(good?.cost).toBeLessThan(bad?.cost ?? Number.POSITIVE_INFINITY);
    expect(good?.cost).toBeCloseTo(0, 3);
  });

  it('幅の広いランを優先して選ぶ', () => {
    // Arrange: 同じ色のランが 2 本あり、片方が明らかに広い
    const runs = [
      { lab: labOf('yellow'), width: 1 },
      { lab: labOf('yellow'), width: 12 },
      { lab: labOf('violet'), width: 10 },
    ];

    // Act
    const result = alignRunsToBands(runs, ['yellow', 'violet']);

    // Assert: 幅 1 の方ではなく 12 の方が選ばれる
    expect(result?.assignments[0]?.runIndex).toBe(1);
  });

  it('空の入力は null', () => {
    expect(alignRunsToBands([], ['yellow'])).toBeNull();
    expect(alignRunsToBands(runsOf(['yellow']), [])).toBeNull();
  });
});
