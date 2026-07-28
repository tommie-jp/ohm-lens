import { describe, expect, it } from 'vitest';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_REFERENCE_COLORS, BODY_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import { classifyBandColor, isBodyColor, rankBandColors } from '../../src/core/bands/classify.js';

describe('基準色テーブル', () => {
  it('12 色すべてのバンド色に基準 Lab が定義されている', () => {
    expect(Object.keys(BAND_REFERENCE_COLORS)).toHaveLength(12);
  });

  it('本体色に beige / lightblue / greywhite / olive が定義されている', () => {
    // 実物のボディはこの 4 系統に分かれる（炭素皮膜・金属皮膜・セメント・
    // 金属酸化皮膜）。足りないと無彩色のボディが無理に beige へ寄せられ、
    // 色順応補正が b* を ±18 動かして青バンドを灰に潰す
    expect(Object.keys(BODY_REFERENCE_COLORS).sort()).toStrictEqual([
      'beige',
      'greywhite',
      'lightblue',
      'olive',
    ]);
  });

  it('基準色はすべて有限の Lab 値', () => {
    for (const lab of Object.values(BAND_REFERENCE_COLORS)) {
      expect(Number.isFinite(lab.l)).toBe(true);
      expect(Number.isFinite(lab.a)).toBe(true);
      expect(Number.isFinite(lab.b)).toBe(true);
    }
  });
});

describe('classifyBandColor', () => {
  it.each([
    ['black', 20, 20, 20],
    ['brown', 102, 51, 0],
    ['red', 200, 30, 30],
    ['orange', 240, 130, 20],
    ['yellow', 235, 210, 50],
    ['green', 30, 140, 60],
    ['blue', 40, 70, 180],
    ['violet', 120, 60, 160],
    ['grey', 130, 130, 130],
    ['white', 245, 245, 245],
  ] as const)('典型的な %s を正しく分類する', (expected, r, g, b) => {
    // Act
    const result = classifyBandColor(srgb255ToLab(r, g, b));

    // Assert
    expect(result.color).toBe(expected);
  });

  it('基準色そのものは確信度がほぼ 1', () => {
    // Arrange
    const reference = BAND_REFERENCE_COLORS.red;

    // Act
    const result = classifyBandColor(reference);

    // Assert
    expect(result.color).toBe('red');
    expect(result.deltaE).toBeCloseTo(0, 6);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('2 色のちょうど中間では確信度が下がる', () => {
    // Arrange: 茶と赤の Lab 中点
    const brown = BAND_REFERENCE_COLORS.brown;
    const red = BAND_REFERENCE_COLORS.red;
    const midpoint = {
      l: (brown.l + red.l) / 2,
      a: (brown.a + red.a) / 2,
      b: (brown.b + red.b) / 2,
    };

    // Act
    const result = classifyBandColor(midpoint);

    // Assert
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('確信度は次点との差が小さいほど下がる', () => {
    // Arrange: 基準色そのものと、灰と銀の中間（紛らわしい）
    const grey = BAND_REFERENCE_COLORS.grey;
    const silver = BAND_REFERENCE_COLORS.silver;
    const between = {
      l: (grey.l + silver.l) / 2,
      a: (grey.a + silver.a) / 2,
      b: (grey.b + silver.b) / 2,
    };

    // Act / Assert
    expect(classifyBandColor(between).confidence).toBeLessThan(
      classifyBandColor(grey).confidence,
    );
  });

  it('確信度は常に 0..1 に収まる', () => {
    for (const rgb of [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [10, 200, 250],
    ] as const) {
      const result = classifyBandColor(srgb255ToLab(rgb[0], rgb[1], rgb[2]));

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('rankBandColors', () => {
  it('上位候補を ΔE の小さい順に返す', () => {
    // Act
    const candidates = rankBandColors(srgb255ToLab(200, 30, 30));

    // Assert
    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.color).toBe('red');
    expect(candidates[0]?.deltaE).toBeLessThanOrEqual(candidates[1]?.deltaE ?? 0);
    expect(candidates[1]?.deltaE).toBeLessThanOrEqual(candidates[2]?.deltaE ?? 0);
  });

  it('件数を指定できる', () => {
    expect(rankBandColors(srgb255ToLab(200, 30, 30), 5)).toHaveLength(5);
  });

  it('最有力候補は classifyBandColor と一致する', () => {
    // Arrange
    const lab = srgb255ToLab(102, 51, 0);

    // Act / Assert
    expect(rankBandColors(lab)[0]?.color).toBe(classifyBandColor(lab).color);
  });
});

describe('isBodyColor', () => {
  it('ベージュの本体色を本体と判定する', () => {
    expect(isBodyColor(BODY_REFERENCE_COLORS.beige)).toBe(true);
  });

  it('水色の本体色を本体と判定する', () => {
    expect(isBodyColor(BODY_REFERENCE_COLORS.lightblue)).toBe(true);
  });

  it('赤いバンドは本体ではない', () => {
    expect(isBodyColor(BAND_REFERENCE_COLORS.red)).toBe(false);
  });

  it('閾値を指定できる', () => {
    // Arrange: ベージュから少しずれた色
    const offBeige = { ...BODY_REFERENCE_COLORS.beige, a: BODY_REFERENCE_COLORS.beige.a + 8 };

    // Act / Assert
    expect(isBodyColor(offBeige, 1)).toBe(false);
    expect(isBodyColor(offBeige, 30)).toBe(true);
  });
});
