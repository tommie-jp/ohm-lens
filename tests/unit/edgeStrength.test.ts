import { describe, expect, it } from 'vitest';
import {
  edgeStrength,
  robustScale,
  savitzkyGolayDerivative,
  type EdgeStrengthOptions,
} from '../../src/core/bands/edgeStrength.js';
import type { ProfileSample } from '../../src/types.js';

/**
 * バンド境界の強さ。
 *
 * 素の中心差分は雑音をそのまま増幅するので、Savitzky–Golay で平滑化しながら
 * 微分する。チャンネルの重みは固定係数を置かず、1 枚ごとの雑音床（MAD）で
 * 割って自動で合わせる。合算ではなく max を採るのは、境界が 1 チャンネルに
 * しか出ないことがあるため（黒・灰・白・銀は L\* だけ、茶・赤は a\*・b\* だけ）。
 *
 * 根拠は `docs/13-バンド境界の検出指標.md` §2〜§4。
 */

function rampOf(length: number, slope: number): ProfileSample[] {
  return Array.from({ length }, (_, x) => ({ x, lab: { l: x * slope, a: 0, b: 0 } }));
}

/** 指定位置で L* が跳ねる段差。 */
function stepOf(length: number, at: number, height: number): ProfileSample[] {
  return Array.from({ length }, (_, x) => ({
    x,
    lab: { l: x < at ? 0 : height, a: 0, b: 0 },
  }));
}

describe('savitzkyGolayDerivative', () => {
  it('傾き一定の入力では微分も一定になる', () => {
    // Arrange / Act
    const derived = savitzkyGolayDerivative(rampOf(11, 3).map((s) => s.lab.l), 5);

    // Assert: 端も含めて傾き 3
    expect(derived.every((value) => Math.abs(value - 3) < 1e-9)).toBe(true);
  });

  it('2 次までの曲線を歪めない（Savitzky–Golay の性質）', () => {
    // Arrange: y = x² の微分は 2x
    const values = Array.from({ length: 11 }, (_, x) => x * x);

    // Act
    const derived = savitzkyGolayDerivative(values, 5);

    // Assert: 内側は解析解と一致する
    for (let i = 2; i < 9; i += 1) {
      expect(derived[i] as number).toBeCloseTo(2 * i, 6);
    }
  });

  it('単発の雑音は素の中心差分より小さくなる', () => {
    // Arrange: 平坦な列の 1 点だけが跳ねている
    const values = Array.from({ length: 11 }, (_, x) => (x === 5 ? 10 : 0));

    // Act
    const smoothed = savitzkyGolayDerivative(values, 5);
    const central = values.map((_, i) =>
      i === 0 || i === values.length - 1
        ? 0
        : ((values[i + 1] as number) - (values[i - 1] as number)) / 2,
    );

    // Assert
    expect(Math.max(...smoothed.map(Math.abs))).toBeLessThan(Math.max(...central.map(Math.abs)));
  });

  it('サンプルが窓より短くても落ちない', () => {
    expect(savitzkyGolayDerivative([1, 2], 5)).toHaveLength(2);
    expect(savitzkyGolayDerivative([], 5)).toEqual([]);
  });
});

describe('robustScale', () => {
  it('MAD を標準偏差の尺度に換算する', () => {
    // Arrange: 対称な分布。MAD = 1 なので 1.4826 になる
    const values = [-2, -1, -1, 0, 1, 1, 2];

    // Act / Assert
    expect(robustScale(values)).toBeCloseTo(1.4826, 3);
  });

  it('外れ値に引っ張られない（境界を含む列から雑音床を取るため）', () => {
    // Arrange: 大半は ±1 で、1 点だけ 100 跳ねる
    const noisy = [...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1)), 100];

    // Act
    const mean = noisy.reduce((sum, value) => sum + value, 0) / noisy.length;
    const deviation = Math.sqrt(
      noisy.reduce((sum, value) => sum + (value - mean) ** 2, 0) / noisy.length,
    );

    // Assert: 標準偏差は外れ値 1 点で 20 以上に膨らむが、MAD は雑音の幅に留まる
    expect(deviation).toBeGreaterThan(20);
    expect(robustScale(noisy)).toBeLessThan(deviation / 5);
  });

  it('全部同じ値でも 0 を返さない（ゼロ割を避ける）', () => {
    expect(robustScale([3, 3, 3, 3])).toBeGreaterThan(0);
  });
});

describe('edgeStrength', () => {
  const options: EdgeStrengthOptions = { window: 5 };

  it('段差の位置で最大になる', () => {
    // Arrange
    const profile = stepOf(21, 10, 40);

    // Act
    const strength = edgeStrength(profile, options);

    // Assert: 山の頂点が段差の位置
    const peak = strength.indexOf(Math.max(...strength));
    expect(Math.abs(peak - 10)).toBeLessThanOrEqual(1);
  });

  it('色みだけが動く境界も拾う（L\\* が動かなくても）', () => {
    // Arrange: L* は一定、a* だけ跳ねる
    const profile: ProfileSample[] = Array.from({ length: 21 }, (_, x) => ({
      x,
      lab: { l: 50, a: x < 10 ? 0 : 30, b: 0 },
    }));

    // Act
    const strength = edgeStrength(profile, options);

    // Assert
    const peak = strength.indexOf(Math.max(...strength));
    expect(Math.abs(peak - 10)).toBeLessThanOrEqual(1);
    expect(Math.max(...strength)).toBeGreaterThan(1);
  });

  it('雑音の大きいチャンネルが小さいチャンネルの境界を埋めない', () => {
    // Arrange: L* は大きな雑音、a* に本物の段差。
    // 合算だと L* の雑音に埋もれるが、正規化 max なら段差が立つ
    const profile: ProfileSample[] = Array.from({ length: 41 }, (_, x) => ({
      x,
      lab: { l: (x % 2 === 0 ? 6 : -6) + 50, a: x < 20 ? 0 : 12, b: 0 },
    }));

    // Act
    const strength = edgeStrength(profile, options);

    // Assert: 段差の位置が、雑音だけの区間より明確に高い
    const atStep = strength[20] as number;
    const noiseFloor = Math.max(...strength.slice(2, 15));
    expect(atStep).toBeGreaterThan(noiseFloor);
  });

  it('サンプルが 1 点以下なら空', () => {
    expect(edgeStrength([], options)).toEqual([]);
    expect(edgeStrength([{ x: 0, lab: { l: 1, a: 2, b: 3 } }], options)).toEqual([]);
  });
});
