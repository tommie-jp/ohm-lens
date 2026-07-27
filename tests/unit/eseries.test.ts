import { describe, expect, it } from 'vitest';
import {
  E24_VALUES,
  E96_VALUES,
  seriesForTolerance,
  snapForTolerance,
  snapToSeries,
} from '../../src/core/value/eseries.js';

describe('E系列テーブル', () => {
  it('E24 は 24 個の値を持つ', () => {
    expect(E24_VALUES).toHaveLength(24);
  });

  it('E96 は 96 個の値を持つ', () => {
    expect(E96_VALUES).toHaveLength(96);
  });

  it.each([
    ['E24', E24_VALUES],
    ['E96', E96_VALUES],
  ])('%s は [1, 10) の範囲で昇順に並んでいる', (_name, values) => {
    // Arrange / Act
    const sorted = [...values].sort((a, b) => a - b);

    // Assert
    expect(values).toEqual(sorted);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...values)).toBeLessThan(10);
  });
});

describe('seriesForTolerance', () => {
  it.each([
    [1, 'E96'],
    [0.5, 'E96'],
    [0.25, 'E96'],
    [2, 'E96'],
  ])('許容差 ±%s%% は E96 を選ぶ', (tolerance, expected) => {
    expect(seriesForTolerance(tolerance)).toBe(expected);
  });

  it.each([
    [5, 'E24'],
    [10, 'E24'],
    [20, 'E24'],
  ])('許容差 ±%s%% は E24 を選ぶ', (tolerance, expected) => {
    expect(seriesForTolerance(tolerance)).toBe(expected);
  });

  it('許容差バンドが無いとき (null) は E24 を選ぶ', () => {
    expect(seriesForTolerance(null)).toBe('E24');
  });
});

describe('snapToSeries', () => {
  it('系列上の値はそのまま返す', () => {
    // Arrange / Act
    const result = snapToSeries(4700, 'E24');

    // Assert
    expect(result.ohms).toBeCloseTo(4700, 6);
    expect(result.deviation).toBeCloseTo(0, 6);
  });

  it('E96 の最近傍にスナップする', () => {
    expect(snapToSeries(4650, 'E96').ohms).toBeCloseTo(4640, 6);
  });

  it('E24 に無い値は E24 の最近傍にスナップする', () => {
    // 4650 は E24 では 4700 が最近傍（4300 との対数中点は約 4496）
    expect(snapToSeries(4650, 'E24').ohms).toBeCloseTo(4700, 6);
  });

  it.each([
    [0.047, 'E24', 0.047],
    [470, 'E24', 470],
    [4_700_000, 'E24', 4_700_000],
  ])('%s Ω (%s) のように任意の桁で動作する', (input, series, expected) => {
    expect(snapToSeries(input, series as 'E24' | 'E96').ohms).toBeCloseTo(expected, 9);
  });

  it('対数距離で最近傍を選ぶ（4.64 と 4.75 の中点は約 4.695）', () => {
    // Arrange: 幾何平均 sqrt(4.64 * 4.75) ≈ 4.6947
    // Act / Assert
    expect(snapToSeries(4.69, 'E96').ohms).toBeCloseTo(4.64, 6);
    expect(snapToSeries(4.7, 'E96').ohms).toBeCloseTo(4.75, 6);
  });

  it('ディケードの上端では次のディケードの先頭にスナップする', () => {
    // E24 の最大は 9.1。9.9 は 9.1 より 10 に近い
    expect(snapToSeries(9.9, 'E24').ohms).toBeCloseTo(10, 6);
  });

  it('ディケードの下端でも正しくスナップする', () => {
    // 1.01 は 1.0 が最近傍（E24）
    expect(snapToSeries(1.01, 'E24').ohms).toBeCloseTo(1, 6);
  });

  it('スナップ量を相対偏差として返す', () => {
    // Arrange: 4650 → 4640 なので偏差は 10/4650
    // Act
    const result = snapToSeries(4650, 'E96');

    // Assert
    expect(result.deviation).toBeCloseTo(10 / 4650, 6);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '正の有限値でない入力 (%s) は TypeError を投げる',
    (input) => {
      expect(() => snapToSeries(input, 'E24')).toThrow(TypeError);
    },
  );
});

describe('snapForTolerance', () => {
  it('±5% は E24 のみで判定する', () => {
    // Arrange / Act
    const result = snapForTolerance(4700, 5);

    // Assert
    expect(result.ohms).toBeCloseTo(4700, 6);
    expect(result.series).toBe('E24');
  });

  it('±5% で E24 に無い値はスナップされる', () => {
    expect(snapForTolerance(4800, 5).ohms).toBeCloseTo(4700, 6);
  });

  it('±1% は E96 ∪ E24 で判定する（E24 値の精密品を誤スナップしない）', () => {
    // Arrange: 4.7k は E96 に無いが E24 にあり、1% 品として実在する
    // Act
    const result = snapForTolerance(4700, 1);

    // Assert
    expect(result.ohms).toBeCloseTo(4700, 6);
    expect(result.deviation).toBeCloseTo(0, 9);
    expect(result.series).toBe('E24');
  });

  it('±1% で E96 固有の値はそのまま通る', () => {
    const result = snapForTolerance(4640, 1);

    expect(result.ohms).toBeCloseTo(4640, 6);
    expect(result.series).toBe('E96');
  });

  it('±1% でどちらの系列にも無い値はより近い方にスナップする', () => {
    // 4690 は E96 の 4640(dev 1.06%) より E24 の 4700(dev 0.21%) が近い
    const result = snapForTolerance(4690, 1);

    expect(result.ohms).toBeCloseTo(4700, 6);
    expect(result.series).toBe('E24');
  });
});
