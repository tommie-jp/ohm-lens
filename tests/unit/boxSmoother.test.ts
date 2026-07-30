import { describe, expect, it } from 'vitest';
import { createSmoother, pushBox, type SmootherState } from '../../src/debug/boxSmoother.js';
import type { OrientedBox } from '../../src/core/locate.js';

const box = (overrides: Partial<OrientedBox> = {}): OrientedBox => ({
  centerX: 100,
  centerY: 50,
  angleDeg: 0,
  length: 80,
  thickness: 20,
  ...overrides,
});

/** 同じボックスを何度か流し込んだ後の状態を作る。 */
function feed(state: SmootherState, boxes: readonly (OrientedBox | null)[]): SmootherState {
  return boxes.reduce((current, item) => pushBox(current, item).state, state);
}

describe('pushBox', () => {
  it('定常入力では入力と同じボックスに収束する', () => {
    // Arrange
    const state = feed(createSmoother(), [box(), box(), box()]);

    // Act
    const { box: smoothed } = pushBox(state, box());

    // Assert
    expect(smoothed).not.toBeNull();
    expect(smoothed?.centerX).toBeCloseTo(100);
    expect(smoothed?.centerY).toBeCloseTo(50);
    expect(smoothed?.angleDeg).toBeCloseTo(0);
    expect(smoothed?.length).toBeCloseTo(80);
    expect(smoothed?.thickness).toBeCloseTo(20);
  });

  it('小さな揺れは平均されて滑らかになる', () => {
    // Arrange: 中心が ±2px で揺れる入力
    const state = feed(createSmoother({ window: 4 }), [
      box({ centerX: 98 }),
      box({ centerX: 102 }),
      box({ centerX: 98 }),
    ]);

    // Act
    const { box: smoothed } = pushBox(state, box({ centerX: 102 }));

    // Assert: 平均は 100。単発の入力値 102 より揺れが小さい
    expect(smoothed?.centerX).toBeCloseTo(100);
  });

  it('±90° 付近の折り返しでも角度が 0° に化けない', () => {
    // Arrange: +89° と -89° はほぼ同じ向き（180° の対称性）
    const state = feed(createSmoother(), [box({ angleDeg: 89 }), box({ angleDeg: -89 })]);

    // Act
    const { box: smoothed } = pushBox(state, box({ angleDeg: 89 }));

    // Assert: 素朴な平均だと約 30° になる。±90° 近くに留まること
    expect(Math.abs(smoothed?.angleDeg ?? 0)).toBeGreaterThan(85);
  });

  it('中心が大きく跳んだら平均を引きずらず即座に追従する', () => {
    // Arrange: 抵抗器を持ち替えた想定
    const state = feed(createSmoother({ jumpRatio: 0.25 }), [box(), box(), box()]);
    const moved = box({ centerX: 300, centerY: 200 });

    // Act
    const { box: smoothed } = pushBox(state, moved);

    // Assert: 旧位置との平均ではなく新位置そのもの
    expect(smoothed?.centerX).toBeCloseTo(300);
    expect(smoothed?.centerY).toBeCloseTo(200);
  });

  it('検出が途切れても保持フレーム内は直前の枠を出し続ける', () => {
    // Arrange
    const state = feed(createSmoother({ holdFrames: 2 }), [box(), box()]);

    // Act
    const first = pushBox(state, null);
    const second = pushBox(first.state, null);

    // Assert
    expect(first.box?.centerX).toBeCloseTo(100);
    expect(second.box?.centerX).toBeCloseTo(100);
  });

  it('保持フレームを超えたら枠を消す', () => {
    // Arrange
    const state = feed(createSmoother({ holdFrames: 2 }), [box(), box()]);

    // Act
    const exhausted = feed(state, [null, null]);
    const { box: smoothed } = pushBox(exhausted, null);

    // Assert
    expect(smoothed).toBeNull();
  });

  it('一度も検出していなければ null のまま', () => {
    expect(pushBox(createSmoother(), null).box).toBeNull();
  });

  it('検出が戻ったら miss カウントがリセットされる', () => {
    // Arrange: miss 1 回 → 検出 1 回
    const state = feed(createSmoother({ holdFrames: 2 }), [box(), null, box()]);

    // Act: 再び miss しても保持は満額使える
    const first = pushBox(state, null);
    const second = pushBox(first.state, null);

    // Assert
    expect(second.box).not.toBeNull();
  });
});
