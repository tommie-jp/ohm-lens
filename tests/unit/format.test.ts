import { describe, expect, it } from 'vitest';
import {
  formatOhms,
  formatReading,
  isReportable,
  MIN_REPORTABLE_CONFIDENCE,
} from '../../src/core/format.js';
import type { ResistorReading } from '../../src/types.js';

function reading(overrides: Partial<ResistorReading> = {}): ResistorReading {
  return {
    ohms: 4700,
    rawOhms: 4700,
    tolerance: 5,
    tempCoefficient: null,
    direction: 'ltr',
    confidence: 0.9,
    series: 'E24',
    ...overrides,
  };
}

describe('formatOhms', () => {
  it.each([
    [4700, '4.7kΩ'],
    [1000, '1kΩ'],
    [470, '470Ω'],
    [4.7, '4.7Ω'],
    [1_000_000, '1MΩ'],
    [4_700_000, '4.7MΩ'],
    [1_000_000_000, '1GΩ'],
    [0.1, '100mΩ'],
  ])('%s Ω → %s', (ohms, expected) => {
    expect(formatOhms(ohms)).toBe(expected);
  });

  it('有効数字 3 桁に丸める', () => {
    expect(formatOhms(4642)).toBe('4.64kΩ');
  });

  it('有限でない値は ? を返す', () => {
    expect(formatOhms(Number.NaN)).toBe('?');
  });
});

describe('isReportable', () => {
  it('確信度が閾値以上なら true', () => {
    expect(isReportable(reading({ confidence: MIN_REPORTABLE_CONFIDENCE }))).toBe(true);
  });

  it('確信度が閾値未満なら false', () => {
    expect(isReportable(reading({ confidence: MIN_REPORTABLE_CONFIDENCE - 0.01 }))).toBe(false);
  });

  it('null は false', () => {
    expect(isReportable(null)).toBe(false);
  });

  it('閾値を指定できる', () => {
    expect(isReportable(reading({ confidence: 0.6 }), 0.9)).toBe(false);
    expect(isReportable(reading({ confidence: 0.6 }), 0.5)).toBe(true);
  });
});

describe('formatReading', () => {
  it('許容差つきで整形する', () => {
    expect(formatReading(reading())).toBe('4.7kΩ ±5%');
  });

  it('許容差が無ければ抵抗値のみ', () => {
    expect(formatReading(reading({ tolerance: null }))).toBe('4.7kΩ');
  });

  it('読み取れなければ ?', () => {
    expect(formatReading(null)).toBe('?');
  });

  it('確信度が閾値未満なら値を出さず ?（誤った値を自信ありげに出さない）', () => {
    expect(formatReading(reading({ confidence: 0.2 }))).toBe('?');
  });

  it('閾値を指定できる', () => {
    expect(formatReading(reading({ confidence: 0.6 }), 0.9)).toBe('?');
  });
});
