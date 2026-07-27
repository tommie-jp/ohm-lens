import { describe, expect, it } from 'vitest';
import { hasPlausibleBandCount } from '../../src/core/bands/layout.js';
import type { ColorRun } from '../../src/core/bands/runs.js';

/** 本数だけを見るので、色と位置は何でもよい。 */
function runs(count: number): ColorRun[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * 10,
    end: index * 10 + 6,
    lab: { l: 50, a: 0, b: 0 },
  }));
}

describe('hasPlausibleBandCount', () => {
  it('3 本未満は成立しない', () => {
    expect(hasPlausibleBandCount(runs(0))).toBe(false);
    expect(hasPlausibleBandCount(runs(2))).toBe(false);
  });

  it('3〜7 本は成立する', () => {
    for (const count of [3, 4, 5, 6, 7]) {
      expect(hasPlausibleBandCount(runs(count))).toBe(true);
    }
  });

  it('8 本以上は成立しない（温度係数つきでも 7 本まで）', () => {
    expect(hasPlausibleBandCount(runs(8))).toBe(false);
    expect(hasPlausibleBandCount(runs(12))).toBe(false);
  });
});
