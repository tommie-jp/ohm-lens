import { describe, expect, it } from 'vitest';
import {
  CHART,
  absoluteSum,
  chartPlotHeight,
  formatPercentTick,
  percentTickValues,
} from '../../src/annotate/profileChart.js';
import { alongPercentAt } from '../../src/core/bands/boundaries.js';
import { buildAnnotationSvg, type AnnotateInput } from '../../src/annotate/render.js';
import type { Band, ProfileSample } from '../../src/types.js';
import type { OrientedBox } from '../../src/core/locate.js';

/**
 * グラフの目盛りと格子。
 *
 * X 軸は抵抗器の長手方向。検出した赤い四角形の長さを 100%、左端を 0% とする。
 * ROI は本体の外側にも余白を取って切り出すので、目盛りは 0〜100% の外側
 * （負の側と 100% 超）にも伸びる。そこが本体の外だと目で分かるようにする。
 */

const BOX: OrientedBox = {
  centerX: 200,
  centerY: 100,
  angleDeg: 0,
  length: 120,
  thickness: 40,
};

/** 解析と同じ ROI 余白。 */
const PADDING = 0.28;

function bandsOf(colors: readonly Band['color'][]): Band[] {
  return colors.map((color, index) => ({
    color,
    start: index * 10,
    end: index * 10 + 8,
    confidence: 0.9,
  }));
}

function inputOf(overrides: Partial<AnnotateInput> = {}): AnnotateInput {
  return {
    width: 800,
    height: 200,
    box: BOX,
    bands: bandsOf(['red', 'red', 'brown']),
    rectify: { padding: PADDING, targetHeight: 40 },
    caption: 'test',
    profile: {
      samples: Array.from({ length: 40 }, (_, x) => ({
        x,
        lab: { l: 50 + (x % 7), a: x % 3, b: -5 + (x % 5) },
      })),
      extent: { start: 2, end: 38 },
      runs: [
        { start: 3, end: 6 },
        { start: 10, end: 13 },
      ],
    },
    ...overrides,
  };
}

describe('absoluteSum', () => {
  it('3 成分の微分の絶対値を足す', () => {
    // Arrange: L* は +2/サンプル、a* は -4/サンプル、b* は動かない
    const samples: ProfileSample[] = Array.from({ length: 4 }, (_, x) => ({
      x,
      lab: { l: x * 2, a: -x * 4, b: 7 },
    }));

    // Act
    const abs = absoluteSum(samples);

    // Assert: |2| + |-4| + |0| = 6
    expect(abs).toEqual([6, 6, 6, 6]);
  });

  it('符号が打ち消し合わない（合計ではなく絶対値の和）', () => {
    // Arrange: L* が上がる分だけ a* が下がる。単純な和なら 0 になってしまう
    const samples: ProfileSample[] = Array.from({ length: 3 }, (_, x) => ({
      x,
      lab: { l: x * 5, a: -x * 5, b: 0 },
    }));

    // Act / Assert
    expect(absoluteSum(samples).every((value) => value === 10)).toBe(true);
  });

  it('サンプルが 1 点以下なら空', () => {
    expect(absoluteSum([])).toEqual([]);
    expect(absoluteSum([{ x: 0, lab: { l: 1, a: 2, b: 3 } }])).toEqual([]);
  });
});

describe('alongPercentAt', () => {
  it('左端が 0%、右端が 100% になるよう ROI の余白を差し引く', () => {
    // Arrange: 余白 28% なので ROI は -28%〜128% を映している
    const count = 100;

    // Act / Assert
    expect(alongPercentAt(0, count, PADDING)).toBeCloseTo(-28, 6);
    expect(alongPercentAt(count - 1, count, PADDING)).toBeCloseTo(128, 6);
    expect(alongPercentAt((count - 1) / 2, count, PADDING)).toBeCloseTo(50, 6);
  });

  it('余白が無ければ ROI がそのまま 0〜100%', () => {
    expect(alongPercentAt(0, 10, 0)).toBe(0);
    expect(alongPercentAt(9, 10, 0)).toBe(100);
  });
});

describe('percentTickValues', () => {
  it('5% 刻みで、ROI に映っている範囲だけ返す', () => {
    // Arrange / Act
    const values = percentTickValues(PADDING);

    // Assert: 余白 0.28 なので -28%〜128% の中に入る -25%〜125%
    expect(values[0]).toBe(-25);
    expect(values[values.length - 1]).toBe(125);
    expect(values).toHaveLength(31);
    expect(values.every((value, index) => index === 0 || value - (values[index - 1] as number) === 5)).toBe(
      true,
    );
  });

  it('余白が無ければ 0〜100% に収まる', () => {
    const values = percentTickValues(0);

    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(100);
    expect(values).toHaveLength(21);
  });

});

describe('目盛りと格子', () => {
  it('X 軸に % の目盛りを出す', () => {
    const svg = buildAnnotationSvg(inputOf());

    expect(svg).toContain('>0%<');
    expect(svg).toContain('>100%<');
  });

  it('Y 軸の目盛りは 2 点（最大・最小）より多く刻む', () => {
    // Arrange
    const svg = buildAnnotationSvg(inputOf());

    // Act: 左軸の目盛り（右端揃えの文字）を数える
    const count = svg.split('text-anchor="end"').length - 1;

    // Assert: Lab と微分の 2 枚 × 3 点以上
    expect(count).toBeGreaterThan(4);
  });

  it('格子を引く', () => {
    const svg = buildAnnotationSvg(inputOf());

    expect(svg.split(CHART.gridColor).length - 1).toBeGreaterThan(4);
  });

  it('abs は専用のプレーンに 1 本だけ描く', () => {
    // Arrange / Act
    const svg = buildAnnotationSvg(inputOf());

    // Assert: Lab 3 本 + abs 1 本 + 微分 3 本
    expect(svg.split('<polyline').length - 1).toBe(7);
    // abs だけのプレーンには右軸が無いので、凡例に「(左)」は付かない
    expect(svg).toContain('>abs</text>');
    expect(svg).not.toContain('>abs(左)<');
  });

  it('プロット高は見出し・X 軸ラベル・凡例を引いた残り', () => {
    expect(chartPlotHeight()).toBe(
      CHART.height - CHART.padding * 2 - CHART.xLabelHeight - CHART.legendHeight,
    );
  });
});

/**
 * X 軸のラベルの表記。
 *
 * 5% 刻みで並べると間隔は約 22px しかない。単位を全部に付けると「-25%」が
 * 4 文字で入らず隣と重なる。25% の倍数だけに付ける。
 */
describe('formatPercentTick', () => {
  it('25% の倍数には単位を付ける', () => {
    expect(formatPercentTick(0)).toBe('0%');
    expect(formatPercentTick(25)).toBe('25%');
    expect(formatPercentTick(100)).toBe('100%');
    expect(formatPercentTick(-25)).toBe('-25%');
  });

  it('それ以外は数字だけにする（隣と重ならないように）', () => {
    expect(formatPercentTick(5)).toBe('5');
    expect(formatPercentTick(-20)).toBe('-20');
    expect(formatPercentTick(115)).toBe('115');
  });
});
