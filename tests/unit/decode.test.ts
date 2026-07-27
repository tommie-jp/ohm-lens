import { describe, expect, it } from 'vitest';
import type { BandColor } from '../../src/types.js';
import { decodeBandSequence } from '../../src/core/value/decode.js';

describe('decodeBandSequence — 正常系', () => {
  it('4バンド: brown black red gold → 1kΩ ±5%', () => {
    // Arrange
    const colors: BandColor[] = ['brown', 'black', 'red', 'gold'];

    // Act
    const result = decodeBandSequence(colors);

    // Assert
    expect(result).not.toBeNull();
    expect(result?.ohms).toBeCloseTo(1000, 6);
    expect(result?.tolerance).toBe(5);
    expect(result?.tempCoefficient).toBeNull();
    expect(result?.series).toBe('E24');
  });

  it('4バンド: yellow violet red gold → 4.7kΩ ±5%', () => {
    const result = decodeBandSequence(['yellow', 'violet', 'red', 'gold']);

    expect(result?.ohms).toBeCloseTo(4700, 6);
    expect(result?.tolerance).toBe(5);
  });

  it('5バンド: brown black black brown brown → 1kΩ ±1%', () => {
    const result = decodeBandSequence(['brown', 'black', 'black', 'brown', 'brown']);

    expect(result?.ohms).toBeCloseTo(1000, 6);
    expect(result?.tolerance).toBe(1);
  });

  it('6バンド: 5バンド + 温度係数バンド', () => {
    const result = decodeBandSequence(['brown', 'black', 'black', 'brown', 'brown', 'red']);

    expect(result?.ohms).toBeCloseTo(1000, 6);
    expect(result?.tolerance).toBe(1);
    expect(result?.tempCoefficient).toBe(50);
  });

  it('3バンド: 許容差バンドが無い場合 tolerance は null', () => {
    const result = decodeBandSequence(['brown', 'black', 'red']);

    expect(result?.ohms).toBeCloseTo(1000, 6);
    expect(result?.tolerance).toBeNull();
    expect(result?.series).toBe('E24');
  });

  it('gold 倍率: yellow violet gold gold → 4.7Ω ±5%', () => {
    const result = decodeBandSequence(['yellow', 'violet', 'gold', 'gold']);

    expect(result?.ohms).toBeCloseTo(4.7, 6);
    expect(result?.tolerance).toBe(5);
  });

  it('silver 倍率: brown black silver gold → 0.1Ω ±5%', () => {
    const result = decodeBandSequence(['brown', 'black', 'silver', 'gold']);

    expect(result?.ohms).toBeCloseTo(0.1, 6);
  });
});

describe('decodeBandSequence — E系列適合', () => {
  it('E24 に無い値はスナップされ deviation が大きくなる', () => {
    // Arrange: yellow grey red = 48×100 = 4800Ω。E24 には無い（4700 が最近傍）
    // Act
    const result = decodeBandSequence(['yellow', 'grey', 'red', 'gold']);

    // Assert
    expect(result?.rawOhms).toBeCloseTo(4800, 6);
    expect(result?.ohms).toBeCloseTo(4700, 6);
    expect(result?.snapDeviation).toBeGreaterThan(0.02);
  });

  it('E24 上の値は deviation が 0', () => {
    const result = decodeBandSequence(['yellow', 'violet', 'red', 'gold']);

    expect(result?.snapDeviation).toBeCloseTo(0, 9);
  });

  it('E24 値の 1% 品（4.7kΩ ±1%）を E96 の 4.75k に誤スナップしない', () => {
    // Arrange: yellow violet black brown brown = 470×10 = 4700Ω ±1%
    // E96 には 4.70 が無い（4.64 / 4.75）が、E24 値の 1% 品は実在する
    // Act
    const result = decodeBandSequence(['yellow', 'violet', 'black', 'brown', 'brown']);

    // Assert
    expect(result?.ohms).toBeCloseTo(4700, 6);
    expect(result?.snapDeviation).toBeCloseTo(0, 9);
  });

  it('E96 固有の値（4.64kΩ ±1%）も正しく扱う', () => {
    // yellow blue yellow brown brown = 464×10 = 4640Ω ±1%
    const result = decodeBandSequence(['yellow', 'blue', 'yellow', 'brown', 'brown']);

    expect(result?.ohms).toBeCloseTo(4640, 6);
    expect(result?.snapDeviation).toBeCloseTo(0, 9);
    expect(result?.series).toBe('E96');
  });
});

describe('decodeBandSequence — 実物の青ボディ金属皮膜（sample/ の撮影分）', () => {
  it('7.5Ω ±1%: violet-green-black-silver-brown（銀倍率）', () => {
    const result = decodeBandSequence(['violet', 'green', 'black', 'silver', 'brown']);

    expect(result?.ohms).toBeCloseTo(7.5, 6);
    expect(result?.tolerance).toBe(1);
    expect(result?.snapDeviation).toBeCloseTo(0, 9);
  });

  it('10MΩ ±1%: brown-black-black-green-brown', () => {
    const result = decodeBandSequence(['brown', 'black', 'black', 'green', 'brown']);

    expect(result?.ohms).toBeCloseTo(10e6, 6);
    expect(result?.tolerance).toBe(1);
    expect(result?.snapDeviation).toBeCloseTo(0, 9);
  });

  it('1Ω ±1%: brown-black-black-silver-brown（銀倍率）', () => {
    const result = decodeBandSequence(['brown', 'black', 'black', 'silver', 'brown']);

    expect(result?.ohms).toBeCloseTo(1, 6);
    expect(result?.tolerance).toBe(1);
    expect(result?.snapDeviation).toBeCloseTo(0, 9);
  });
});

describe('decodeBandSequence — 異常系', () => {
  it.each([
    [[], 'バンド無し'],
    [['brown'], '1バンド'],
    [['brown', 'black'], '2バンド'],
    [['brown', 'black', 'red', 'gold', 'brown', 'red', 'green'], '7バンド'],
  ] as [BandColor[], string][])('%#: %s は null を返す', (colors) => {
    expect(decodeBandSequence(colors)).toBeNull();
  });

  it('数字バンドに gold が来たら null', () => {
    expect(decodeBandSequence(['gold', 'black', 'red', 'gold'])).toBeNull();
  });

  it('倍率バンドに使えない色（本体色由来の誤検出など）は null', () => {
    // 倍率に white は 10^9 まで定義があるので有効。ここでは 5 バンドの
    // 倍率位置に gold が来るケースを許容することを確認する
    expect(decodeBandSequence(['brown', 'black', 'black', 'gold', 'brown'])?.ohms).toBeCloseTo(
      10,
      6,
    );
  });

  it('許容差バンドに使えない色（black）は null', () => {
    expect(decodeBandSequence(['brown', 'black', 'red', 'black'])).toBeNull();
  });

  it('6バンド目に温度係数として使えない色（white）は null', () => {
    expect(decodeBandSequence(['brown', 'black', 'black', 'brown', 'brown', 'white'])).toBeNull();
  });
});
