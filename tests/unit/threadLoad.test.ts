import { describe, expect, it } from 'vitest';
import {
  createLoad,
  currentLoad,
  HISTORY_LENGTH,
  recordWork,
  sampleLoad,
  WINDOW_MS,
} from '../../src/debug/threadLoad.js';

describe('recordWork / currentLoad', () => {
  it('仕事が無ければ占有率は 0', () => {
    expect(currentLoad(createLoad(), 1000)).toBe(0);
  });

  it('窓の半分を使っていれば 50%', () => {
    // Arrange: 1 秒の窓に 500ms ぶんの仕事
    const state = recordWork(createLoad(), 1000, 500);

    // Act / Assert
    expect(currentLoad(state, 1000)).toBeCloseTo(0.5, 6);
  });

  it('窓からこぼれた仕事は数えない', () => {
    // Arrange: 窓の外（古い）と中（新しい）に 1 件ずつ
    const old = recordWork(createLoad(), 0, 500);
    const state = recordWork(old, WINDOW_MS + 100, 200);

    // Act / Assert: 古いほうは落ちる
    expect(currentLoad(state, WINDOW_MS + 100)).toBeCloseTo(200 / WINDOW_MS, 6);
  });

  it('窓を超えて働いても 1 を超えない', () => {
    // Arrange: 窓より長い仕事（他スレッドを待つ間に積み上がった場合）
    const state = recordWork(createLoad(), 1000, WINDOW_MS * 3);

    // Act / Assert
    expect(currentLoad(state, 1000)).toBe(1);
  });

  it('元の状態を書き換えない', () => {
    // Arrange
    const before = createLoad();

    // Act
    recordWork(before, 1000, 500);

    // Assert
    expect(currentLoad(before, 1000)).toBe(0);
  });
});

describe('sampleLoad', () => {
  it('呼ぶたびに履歴へ 1 点積む', () => {
    // Arrange
    let state = recordWork(createLoad(), 100, 250);

    // Act
    state = sampleLoad(state, 100);
    state = sampleLoad(state, 200);

    // Assert
    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toBeCloseTo(0.25, 6);
  });

  it('履歴は上限で打ち切り、古いほうから捨てる', () => {
    // Arrange
    let state = createLoad();

    // Act: 上限より多く積む
    for (let i = 0; i < HISTORY_LENGTH + 10; i += 1) state = sampleLoad(state, i * 100);

    // Assert
    expect(state.history).toHaveLength(HISTORY_LENGTH);
  });

  it('窓から出た仕事は履歴を刻むときに捨てる（際限なく溜めない）', () => {
    // Arrange
    let state = createLoad();
    for (let i = 0; i < 50; i += 1) state = recordWork(state, i * 100, 10);

    // Act: 全部が窓から出るまで進める
    state = sampleLoad(state, 50 * 100 + WINDOW_MS);

    // Assert
    expect(state.work).toHaveLength(0);
    expect(state.history.at(-1)).toBe(0);
  });

  it('元の状態を書き換えない', () => {
    // Arrange
    const before = createLoad();

    // Act
    sampleLoad(before, 100);

    // Assert
    expect(before.history).toHaveLength(0);
  });
});
