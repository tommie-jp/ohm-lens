import { describe, expect, it } from 'vitest';
import type { Band, BandColor } from '../../src/types.js';
import { determineDirection } from '../../src/core/value/direction.js';

/** 等間隔にバンドを並べたテスト用ヘルパー。 */
function bandsAt(specs: [BandColor, number, number][]): Band[] {
  return specs.map(([color, start, end]) => ({ color, start, end, confidence: 1 }));
}

describe('determineDirection — 許容差バンドによる判定', () => {
  it('右端が gold なら左から読む (ltr)', () => {
    // Arrange
    const bands = bandsAt([
      ['yellow', 10, 14],
      ['violet', 20, 24],
      ['red', 30, 34],
      ['gold', 50, 54],
    ]);

    // Act
    const result = determineDirection(bands, 64);

    // Assert
    expect(result.direction).toBe('ltr');
    expect(result.reason).toBe('tolerance-band');
  });

  it('左端が silver なら右から読む (rtl)', () => {
    const bands = bandsAt([
      ['silver', 10, 14],
      ['red', 30, 34],
      ['violet', 40, 44],
      ['yellow', 50, 54],
    ]);

    const result = determineDirection(bands, 64);

    expect(result.direction).toBe('rtl');
    expect(result.reason).toBe('tolerance-band');
  });

  it('両端が gold/silver なら判定できず余白比率にフォールバックする', () => {
    // Arrange: 両端 gold。末尾側の間隔(16)が先頭側(8)より広い
    const bands = bandsAt([
      ['gold', 10, 14],
      ['red', 22, 26],
      ['violet', 30, 34],
      ['gold', 50, 54],
    ]);

    // Act
    const result = determineDirection(bands, 64);

    // Assert
    expect(result.reason).toBe('gap-ratio');
    expect(result.direction).toBe('ltr');
  });
});

describe('determineDirection — 余白比率による判定', () => {
  it('末尾側の間隔が広い方を末尾とみなす', () => {
    // Arrange: 最後のバンドの前に広い間隔がある → 右が末尾 → ltr
    const bands = bandsAt([
      ['brown', 10, 14],
      ['black', 16, 20],
      ['red', 22, 26],
      ['green', 40, 44],
    ]);

    // Act
    const result = determineDirection(bands, 54);

    // Assert
    expect(result.direction).toBe('ltr');
    expect(result.reason).toBe('gap-ratio');
  });

  it('先頭側の間隔が広ければ rtl', () => {
    const bands = bandsAt([
      ['green', 10, 14],
      ['red', 28, 32],
      ['black', 34, 38],
      ['brown', 40, 44],
    ]);

    const result = determineDirection(bands, 54);

    expect(result.direction).toBe('rtl');
    expect(result.reason).toBe('gap-ratio');
  });

  it('間隔が対称なら判定不能として ltr を返しつつ確信度を下げる', () => {
    const bands = bandsAt([
      ['brown', 10, 14],
      ['black', 20, 24],
      ['red', 30, 34],
      ['green', 40, 44],
    ]);

    const result = determineDirection(bands, 54);

    expect(result.reason).toBe('ambiguous');
    expect(result.confidence).toBeLessThan(0.6);
  });
});

describe('determineDirection — 異常系', () => {
  it('バンドが 3 本未満なら判定不能', () => {
    const result = determineDirection(bandsAt([['brown', 10, 14]]), 54);

    expect(result.reason).toBe('ambiguous');
  });

  it('確信度は常に 0..1 に収まる', () => {
    const bands = bandsAt([
      ['yellow', 10, 14],
      ['violet', 20, 24],
      ['red', 30, 34],
      ['gold', 50, 54],
    ]);

    const result = determineDirection(bands, 64);

    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
