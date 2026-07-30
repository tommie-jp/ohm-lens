import { describe, expect, it } from 'vitest';
import {
  createStabilizer,
  pushReading,
  DEFAULT_REQUIRED_MATCHES,
  type StabilizerState,
} from '../../src/debug/readingStabilizer.js';

/** 続けて流し込んだ結果をまとめて見る。 */
function feed(state: StabilizerState, values: readonly string[]): (string | null)[] {
  const stables: (string | null)[] = [];
  let current = state;
  for (const value of values) {
    const result = pushReading(current, value);
    current = result.state;
    stables.push(result.stable);
  }
  return stables;
}

describe('pushReading', () => {
  it('既定では 3 回続けて一致するまで値を出さない', () => {
    // Act
    const stables = feed(createStabilizer(), ['4.7kΩ', '4.7kΩ', '4.7kΩ']);

    // Assert
    expect(DEFAULT_REQUIRED_MATCHES).toBe(3);
    expect(stables).toEqual([null, null, '4.7kΩ']);
  });

  it('揺れている間は出さない', () => {
    // Arrange: 1 フレームごとに読み値が変わる状況
    const stables = feed(createStabilizer(), ['4.7kΩ', '47kΩ', '4.7kΩ', '470Ω']);

    // Assert
    expect(stables).toEqual([null, null, null, null]);
  });

  it('揺れたあとでも、続けて一致すれば出す', () => {
    const stables = feed(createStabilizer(), ['47kΩ', '4.7kΩ', '4.7kΩ', '4.7kΩ']);

    expect(stables).toEqual([null, null, null, '4.7kΩ']);
  });

  it('一致が続く間は出し続ける', () => {
    const stables = feed(createStabilizer(), ['4.7kΩ', '4.7kΩ', '4.7kΩ', '4.7kΩ']);

    expect(stables).toEqual([null, null, '4.7kΩ', '4.7kΩ']);
  });

  it('値が変わったら、また一致するまで出さない', () => {
    // Arrange: 4.7k で確定したあと別の抵抗器に持ち替えた
    const stables = feed(createStabilizer(), ['4.7kΩ', '4.7kΩ', '4.7kΩ', '10kΩ', '10kΩ']);

    // Assert: 確定 → 持ち替えで止まる → 3 回そろって再確定
    expect(stables).toEqual([null, null, '4.7kΩ', null, null]);
  });

  it('「?」も 3 回続けば確定した表示として出す', () => {
    expect(feed(createStabilizer(), ['?', '?', '?'])).toEqual([null, null, '?']);
  });

  it('必要回数は変えられる', () => {
    expect(feed(createStabilizer(2), ['1kΩ', '1kΩ'])).toEqual([null, '1kΩ']);
  });

  it('状態を書き換えない', () => {
    // Arrange
    const state = createStabilizer();
    const after = pushReading(state, '4.7kΩ');

    // Assert
    expect(state.recent).toEqual([]);
    expect(after.state.recent).toEqual(['4.7kΩ']);
  });
});
