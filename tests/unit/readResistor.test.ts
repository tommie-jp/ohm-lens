import { describe, expect, it } from 'vitest';
import type { Band, BandColor } from '../../src/types.js';
import { readResistor } from '../../src/core/value/decode.js';

function bandsAt(specs: [BandColor, number, number, number?][]): Band[] {
  return specs.map(([color, start, end, confidence]) => ({
    color,
    start,
    end,
    confidence: confidence ?? 1,
  }));
}

describe('readResistor', () => {
  it('gold が右端なら左から読んで 4.7kΩ ±5%', () => {
    // Arrange
    const bands = bandsAt([
      ['yellow', 10, 14],
      ['violet', 20, 24],
      ['red', 30, 34],
      ['gold', 50, 54],
    ]);

    // Act
    const reading = readResistor(bands, 64);

    // Assert
    expect(reading?.ohms).toBeCloseTo(4700, 6);
    expect(reading?.tolerance).toBe(5);
    expect(reading?.direction).toBe('ltr');
  });

  it('バンドが逆順に並んでいても正しく読む', () => {
    // Arrange: 物理的に左端が gold（抵抗器が反対向き）
    const bands = bandsAt([
      ['gold', 10, 14],
      ['red', 30, 34],
      ['violet', 40, 44],
      ['yellow', 50, 54],
    ]);

    // Act
    const reading = readResistor(bands, 64);

    // Assert
    expect(reading?.ohms).toBeCloseTo(4700, 6);
    expect(reading?.direction).toBe('rtl');
  });

  it('方向が曖昧でも E系列適合の良い方向を選ぶ', () => {
    // Arrange: 等間隔で許容差バンドが無い 3 バンド。
    // ltr: brown black red = 1000Ω(E24 上)
    // rtl: red black brown = 200Ω(E24 上)… どちらも E24 上なので
    // 適合では決まらないが、いずれかを返し confidence を下げること
    const bands = bandsAt([
      ['brown', 10, 14],
      ['black', 20, 24],
      ['red', 30, 34],
    ]);

    // Act
    const reading = readResistor(bands, 44);

    // Assert
    expect(reading).not.toBeNull();
    expect(reading?.confidence).toBeLessThan(0.7);
  });

  it('片方向だけがデコード可能ならそちらを選ぶ', () => {
    // Arrange: 等間隔。rtl だと先頭が gold になり数字バンドとして不正
    const bands = bandsAt([
      ['brown', 10, 14],
      ['black', 20, 24],
      ['red', 30, 34],
      ['gold', 40, 44],
    ]);

    // Act
    const reading = readResistor(bands, 54);

    // Assert
    expect(reading?.direction).toBe('ltr');
    expect(reading?.ohms).toBeCloseTo(1000, 6);
  });

  it('バンドの確信度が低いと全体の確信度も下がる', () => {
    // Arrange
    const confident = bandsAt([
      ['yellow', 10, 14],
      ['violet', 20, 24],
      ['red', 30, 34],
      ['gold', 50, 54],
    ]);
    const unsure = bandsAt([
      ['yellow', 10, 14, 0.4],
      ['violet', 20, 24, 1],
      ['red', 30, 34, 1],
      ['gold', 50, 54, 1],
    ]);

    // Act
    const high = readResistor(confident, 64);
    const low = readResistor(unsure, 64);

    // Assert
    expect(low?.confidence).toBeLessThan(high?.confidence ?? 0);
  });

  it('どちらの方向でもデコードできなければ null', () => {
    const bands = bandsAt([
      ['gold', 10, 14],
      ['silver', 20, 24],
      ['gold', 30, 34],
    ]);

    expect(readResistor(bands, 44)).toBeNull();
  });

  it('バンドが並び順どおりでなくても位置でソートして読む', () => {
    // Arrange: 配列の順序が位置と一致していない
    const bands = bandsAt([
      ['gold', 50, 54],
      ['yellow', 10, 14],
      ['red', 30, 34],
      ['violet', 20, 24],
    ]);

    // Act
    const reading = readResistor(bands, 64);

    // Assert
    expect(reading?.ohms).toBeCloseTo(4700, 6);
  });

  it('確信度は常に 0..1 に収まる', () => {
    const reading = readResistor(
      bandsAt([
        ['yellow', 10, 14],
        ['violet', 20, 24],
        ['red', 30, 34],
        ['gold', 50, 54],
      ]),
      64,
    );

    expect(reading?.confidence).toBeGreaterThanOrEqual(0);
    expect(reading?.confidence).toBeLessThanOrEqual(1);
  });
});
