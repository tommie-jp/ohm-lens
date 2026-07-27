import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SCALES,
  createBudget,
  frameStats,
  recordFrame,
  type BudgetState,
} from '../../src/debug/frameBudget.js';

/** duration ミリ秒のフレームを count 回記録する。 */
function feed(state: BudgetState, durationMs: number, count: number): BudgetState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = recordFrame(next, durationMs);
  return next;
}

describe('createBudget', () => {
  it('目標 fps と最高解像度から始まる', () => {
    const state = createBudget(8);

    expect(state.targetFps).toBe(8);
    expect(state.scaleIndex).toBe(0);
  });
});

describe('frameStats', () => {
  it('計測前は null', () => {
    expect(frameStats(createBudget(8))).toBeNull();
  });

  it('処理時間が律速なら、そこから実効 fps を出す', () => {
    // Arrange: 目標 30fps（予算 33ms）に対して 1 フレーム 50ms。
    // 間引きより処理時間の方が厳しいので 1000/50 = 20fps になる
    const state = feed(createBudget(30), 50, 5);

    // Act
    const stats = frameStats(state);

    // Assert
    expect(stats?.meanMs).toBeCloseTo(50, 6);
    expect(stats?.fps).toBeCloseTo(20, 6);
  });

  it('実効 fps は目標 fps を超えない（間引きの上限）', () => {
    // Arrange: 1ms で終わっても目標 8fps 以上には出さない
    const state = feed(createBudget(8), 1, 10);

    // Act / Assert
    expect(frameStats(state)?.fps).toBeCloseTo(8, 6);
  });

  it('直近のフレームだけを見る（古い計測を引きずらない）', () => {
    // Arrange: 遅い時期 → 速い時期
    let state = feed(createBudget(8), 500, 30);
    state = feed(state, 20, 30);

    // Act / Assert
    expect(frameStats(state)?.meanMs).toBeCloseTo(20, 0);
  });
});

describe('recordFrame — 負荷が高いときの劣化', () => {
  it('予算を超え続けると目標 fps を下げる', () => {
    // Arrange: 8fps の予算 125ms に対して 300ms かかる
    const state = feed(createBudget(8), 300, 12);

    // Assert
    expect(state.targetFps).toBeLessThan(8);
  });

  it('fps を下げきったら解像度を落とす', () => {
    // Arrange: どれだけ間引いても間に合わない重さ
    const state = feed(createBudget(8), 5000, 60);

    // Assert
    expect(state.scaleIndex).toBeGreaterThan(0);
  });

  it('解像度は下限より下がらない', () => {
    const state = feed(createBudget(8), 100_000, 300);

    expect(state.scaleIndex).toBeLessThanOrEqual(ANALYSIS_SCALES.length - 1);
  });

  it('目標 fps は下限より下がらない', () => {
    const state = feed(createBudget(8), 100_000, 300);

    expect(state.targetFps).toBeGreaterThanOrEqual(1);
  });
});

describe('recordFrame — 余裕があるときの回復', () => {
  it('落とした解像度を先に戻す', () => {
    // Arrange: いったん重くして解像度を落としてから、軽い処理に戻す
    let state = feed(createBudget(8), 5000, 60);
    const degraded = state.scaleIndex;
    expect(degraded).toBeGreaterThan(0);

    // Act
    state = feed(state, 1, 120);

    // Assert
    expect(state.scaleIndex).toBeLessThan(degraded);
  });

  it('解像度を戻しきってから fps を戻す', () => {
    // Arrange
    let state = feed(createBudget(8), 300, 12);
    expect(state.targetFps).toBeLessThan(8);

    // Act: 十分軽い処理を続ける
    state = feed(state, 1, 200);

    // Assert
    expect(state.scaleIndex).toBe(0);
    expect(state.targetFps).toBe(8);
  });

  it('目標を超えて上がることはない', () => {
    const state = feed(createBudget(8), 1, 300);

    expect(state.targetFps).toBeLessThanOrEqual(8);
    expect(state.scaleIndex).toBe(0);
  });
});

describe('recordFrame — 安定域では動かさない', () => {
  it('予算内に収まっているなら設定を変えない', () => {
    // Arrange: 8fps の予算 125ms に対して 100ms（ぎりぎり内側）
    const state = feed(createBudget(8), 100, 40);

    // Assert
    expect(state.targetFps).toBe(8);
    expect(state.scaleIndex).toBe(0);
  });

  it('元の状態を変更しない（イミュータブル）', () => {
    // Arrange
    const original = createBudget(8);

    // Act
    recordFrame(original, 500);

    // Assert
    expect(original.samples).toHaveLength(0);
  });
});
