import { describe, expect, it } from 'vitest';
import { jointReadResistor, type JointRun } from '../../src/core/value/jointDecode.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor } from '../../src/types.js';

function labOf(color: BandColor): LabColor {
  const [r, g, b] = BAND_SRGB[color];
  return srgb255ToLab(r, g, b);
}

function runsOf(colors: readonly BandColor[], width = 8): JointRun[] {
  return colors.map((color, index) => ({
    lab: labOf(color),
    start: index * (width + 4),
    end: index * (width + 4) + width,
  }));
}

/** 役割を「色:意味」の並びに畳んで比較しやすくする。 */
function roleSummary(reading: NonNullable<ReturnType<typeof jointReadResistor>>): string[] {
  return reading.usedRuns.map((used) => `${used.color}:${used.roleText}`);
}

describe('usedRuns — 役割の割り当て', () => {
  it('4 バンドの数字・倍率・許容差を割り当てる', () => {
    // Arrange: 4.7kΩ ±5%
    const reading = jointReadResistor(runsOf(['yellow', 'violet', 'red', 'gold']));

    // Assert
    expect(reading).not.toBeNull();
    expect(roleSummary(reading!)).toEqual([
      'yellow:4',
      'violet:7',
      'red:×100',
      'gold:±5%',
    ]);
    expect(reading!.usedRuns.map((used) => used.role)).toEqual([
      'digit',
      'digit',
      'multiplier',
      'tolerance',
    ]);
  });

  it('5 バンド（銀倍率）も割り当てる', () => {
    // Arrange: 1Ω ±1%
    const reading = jointReadResistor(
      runsOf(['brown', 'black', 'black', 'silver', 'brown']),
    );

    // Assert
    expect(roleSummary(reading!)).toEqual([
      'brown:1',
      'black:0',
      'black:0',
      'silver:×0.01',
      'brown:±1%',
    ]);
  });

  it('3 バンド（許容差なし）では許容差の役割が出ない', () => {
    const reading = jointReadResistor(runsOf(['brown', 'black', 'red']));

    expect(reading!.usedRuns.map((used) => used.role)).toEqual([
      'digit',
      'digit',
      'multiplier',
    ]);
  });

  it('6 バンドでは温度係数の役割が出る', () => {
    // Arrange: 1kΩ ±1% 50ppm
    const reading = jointReadResistor(
      runsOf(['brown', 'black', 'black', 'brown', 'brown', 'red']),
    );

    // Assert
    expect(reading!.usedRuns.at(-1)?.role).toBe('tempco');
    expect(reading!.usedRuns.at(-1)?.roleText).toBe('50ppm');
  });
});

describe('usedRuns — 方向とランの対応', () => {
  it('runIndex は入力したランの順序を指す（逆向きでも）', () => {
    // Arrange: 物理的に gold が先頭（抵抗器が反対向き）
    const reading = jointReadResistor(runsOf(['gold', 'red', 'violet', 'yellow']));

    // Assert: rtl で読むので、意味は末尾から順に付く
    expect(reading!.direction).toBe('rtl');
    const byIndex = new Map(reading!.usedRuns.map((used) => [used.runIndex, used.roleText]));
    expect(byIndex.get(0)).toBe('±5%'); // 先頭の gold が許容差
    expect(byIndex.get(3)).toBe('4'); // 末尾の yellow が第1数字
  });

  it('usedRuns は runIndex の昇順（画像上の並び順）で返る', () => {
    const reading = jointReadResistor(runsOf(['gold', 'red', 'violet', 'yellow']));

    const indices = reading!.usedRuns.map((used) => used.runIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe('usedRuns — 捨てられたラン', () => {
  it('ノイズとして捨てたランは usedRuns に入らない', () => {
    // Arrange: 2 本目に幅 2 の灰色ノイズ
    const runs: JointRun[] = [
      { lab: labOf('yellow'), start: 0, end: 8 },
      { lab: labOf('grey'), start: 10, end: 12 },
      { lab: labOf('violet'), start: 14, end: 22 },
      { lab: labOf('red'), start: 26, end: 34 },
      { lab: labOf('gold'), start: 40, end: 48 },
    ];

    // Act
    const reading = jointReadResistor(runs);

    // Assert
    expect(reading?.ohms).toBeCloseTo(4700, 6);
    expect(reading!.usedRuns).toHaveLength(4);
    expect(reading!.usedRuns.map((used) => used.runIndex)).not.toContain(1);
  });

  it('捨てられたランの添字を droppedRuns で分かる', () => {
    const runs: JointRun[] = [
      { lab: labOf('yellow'), start: 0, end: 8 },
      { lab: labOf('grey'), start: 10, end: 12 },
      { lab: labOf('violet'), start: 14, end: 22 },
      { lab: labOf('red'), start: 26, end: 34 },
      { lab: labOf('gold'), start: 40, end: 48 },
    ];

    const reading = jointReadResistor(runs);

    expect(reading!.droppedRuns).toEqual([1]);
  });

  it('何も捨てなければ droppedRuns は空', () => {
    const reading = jointReadResistor(runsOf(['yellow', 'violet', 'red', 'gold']));

    expect(reading!.droppedRuns).toEqual([]);
  });
});

describe('usedRuns — 分類の訂正が反映される', () => {
  it('最近傍と違う色を採用した場合、その色が usedRuns に出る', () => {
    // Arrange: 2 本目を橙寄りに濁す（独立分類なら orange、全体最適なら red）
    const orange = labOf('orange');
    const red = labOf('red');
    const muddy = {
      l: orange.l * 0.58 + red.l * 0.42,
      a: orange.a * 0.58 + red.a * 0.42,
      b: orange.b * 0.58 + red.b * 0.42,
    };
    const runs: JointRun[] = [
      { lab: labOf('red'), start: 0, end: 8 },
      { lab: muddy, start: 12, end: 20 },
      { lab: labOf('brown'), start: 24, end: 32 },
      { lab: labOf('gold'), start: 40, end: 48 },
    ];

    // Act
    const reading = jointReadResistor(runs);

    // Assert: 220Ω に落ち着くので 2 本目は red として採用される
    expect(reading?.ohms).toBeCloseTo(220, 6);
    expect(reading!.usedRuns[1]?.color).toBe('red');
    expect(reading!.usedRuns[1]?.roleText).toBe('2');
  });
});
