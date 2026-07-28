import { describe, expect, it } from 'vitest';
import { jointReadResistor, type JointRun } from '../../src/core/value/jointDecode.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor } from '../../src/types.js';
import { MIN_REPORTABLE_CONFIDENCE } from '../../src/core/format.js';

function labOf(color: BandColor): LabColor {
  const [r, g, b] = BAND_SRGB[color];
  return srgb255ToLab(r, g, b);
}

/** 2 色の Lab を weight で混ぜる（紛らわしい色を作る用）。 */
function mix(a: LabColor, b: LabColor, weight: number): LabColor {
  return {
    l: a.l * (1 - weight) + b.l * weight,
    a: a.a * (1 - weight) + b.a * weight,
    b: a.b * (1 - weight) + b.b * weight,
  };
}

function runsOf(colors: readonly BandColor[], width = 8): JointRun[] {
  return colors.map((color, index) => ({
    lab: labOf(color),
    start: index * (width + 4),
    end: index * (width + 4) + width,
  }));
}

describe('jointReadResistor — 正常系', () => {
  it('綺麗な 4 バンドを読む', () => {
    // Arrange
    const runs = runsOf(['yellow', 'violet', 'red', 'gold']);

    // Act
    const reading = jointReadResistor(runs);

    // Assert
    expect(reading?.ohms).toBeCloseTo(4700, 6);
    expect(reading?.tolerance).toBe(5);
    expect(reading?.direction).toBe('ltr');
  });

  it('逆向きの 4 バンドを rtl として読む', () => {
    const runs = runsOf(['gold', 'red', 'violet', 'yellow']);

    const reading = jointReadResistor(runs);

    expect(reading?.ohms).toBeCloseTo(4700, 6);
    expect(reading?.direction).toBe('rtl');
  });

  it('5 バンド（銀倍率）を読む', () => {
    // Arrange: 実物の 1Ω ±1%（brown-black-black-silver-brown）
    const runs = runsOf(['brown', 'black', 'black', 'silver', 'brown']);

    // Act
    const reading = jointReadResistor(runs);

    // Assert
    expect(reading?.ohms).toBeCloseTo(1, 6);
    expect(reading?.tolerance).toBe(1);
  });

  it('3 バンド（許容差なし）を読む', () => {
    const reading = jointReadResistor(runsOf(['brown', 'black', 'red']));

    expect(reading?.ohms).toBeCloseTo(1000, 6);
    expect(reading?.tolerance).toBeNull();
  });
});

describe('jointReadResistor — 構造制約による曖昧さの解消', () => {
  it('最近傍では E 系列に合わない色を、次点の候補で救う', () => {
    // Arrange: 220Ω（red-red-brown-gold）の 2 本目を橙寄りに濁す。
    // 独立分類なら orange が最近傍 → 230Ω（E24 に無い）になるところ、
    // 全体最適なら red を選んで 220Ω（E24 上）に落ち着くはず
    const muddy = mix(labOf('orange'), labOf('red'), 0.42);
    const runs: JointRun[] = [
      { lab: labOf('red'), start: 0, end: 8 },
      { lab: muddy, start: 12, end: 20 },
      { lab: labOf('brown'), start: 24, end: 32 },
      { lab: labOf('gold'), start: 40, end: 48 },
    ];

    // Act
    const reading = jointReadResistor(runs);

    // Assert
    expect(reading?.ohms).toBeCloseTo(220, 6);
  });

  it('数字バンドに置けない色（gold）が中央に来たら別候補で読む', () => {
    // Arrange: 3 本目が gold と yellow の中間（gold 寄り）。
    // gold は数字バンドに使えないので、yellow として読むしかない
    const muddy = mix(labOf('gold'), labOf('yellow'), 0.45);
    const runs: JointRun[] = [
      { lab: labOf('red'), start: 0, end: 8 },
      { lab: muddy, start: 12, end: 20 },
      { lab: labOf('brown'), start: 24, end: 32 },
      { lab: labOf('gold'), start: 40, end: 48 },
    ];

    // Act
    const reading = jointReadResistor(runs);

    // Assert: red-yellow-brown-gold = 240Ω ±5%（E24 上）
    expect(reading?.ohms).toBeCloseTo(240, 6);
  });
});

describe('jointReadResistor — 余分なランの除去', () => {
  it('細いノイズのランを落として読む', () => {
    // Arrange: 4 バンドの間に幅 2 の灰色ノイズが挟まっている
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
  });

  it('幅の広い正当なバンドは落とさない', () => {
    // Arrange: 5 本すべて幅広 → 5 バンドとして読むべき
    const runs = runsOf(['brown', 'black', 'black', 'brown', 'brown'], 10);

    // Act
    const reading = jointReadResistor(runs);

    // Assert: 1kΩ ±1%
    expect(reading?.ohms).toBeCloseTo(1000, 6);
    expect(reading?.tolerance).toBe(1);
  });
});

describe('jointReadResistor — 異常系', () => {
  it('ランが少なすぎれば null', () => {
    expect(jointReadResistor(runsOf(['red', 'gold']))).toBeNull();
    expect(jointReadResistor([])).toBeNull();
  });

  it('無意味な列（gold/silver のみ）は null か、確信度が閾値未満', () => {
    // gold/silver は数字バンドに置けないため、最近傍では読めない。
    // 次点候補（gold→yellow など）で再解釈される場合もあるが、
    // その場合は確信度が下がって「?」表示になること
    const reading = jointReadResistor(runsOf(['gold', 'silver', 'gold']));

    if (reading !== null) {
      expect(reading.confidence).toBeLessThan(MIN_REPORTABLE_CONFIDENCE);
    }
  });

  it('確信度は 0..1 に収まる', () => {
    const reading = jointReadResistor(runsOf(['yellow', 'violet', 'red', 'gold']));

    expect(reading?.confidence).toBeGreaterThanOrEqual(0);
    expect(reading?.confidence).toBeLessThanOrEqual(1);
  });

  it('綺麗な列は濁った列より確信度が高い', () => {
    // Arrange
    const clean = jointReadResistor(runsOf(['yellow', 'violet', 'red', 'gold']));
    const muddyLab = mix(labOf('red'), labOf('brown'), 0.5);
    const muddy = jointReadResistor([
      { lab: labOf('yellow'), start: 0, end: 8 },
      { lab: labOf('violet'), start: 12, end: 20 },
      { lab: muddyLab, start: 24, end: 32 },
      { lab: labOf('gold'), start: 40, end: 48 },
    ]);

    // Assert
    expect(clean?.confidence ?? 0).toBeGreaterThan(muddy?.confidence ?? 0);
  });

  it('ランが多すぎても破綻しない（幅の広い順に絞る）', () => {
    // Arrange: 正しい 4 バンド + ノイズ 6 本
    const noise = (index: number): JointRun => ({
      lab: labOf('grey'),
      start: 100 + index * 4,
      end: 102 + index * 4,
    });
    const runs = [...runsOf(['yellow', 'violet', 'red', 'gold'], 10), ...Array.from({ length: 6 }, (_, i) => noise(i))];

    // Act
    const reading = jointReadResistor(runs);

    // Assert
    expect(reading).not.toBeNull();
  });
});

describe('許容差バンドの間隔による方向の加点', () => {
  /**
   * IEC 60062 は許容差バンドを他より離して印刷する。実測でも 15-339ohm は
   * 間隔が 3/3/4/14 と許容差の手前だけ 3.5 倍開く。
   *
   * ただし単独では当てにならない（`docs/07` で 14 枚中 4 枚しか合わず 4 枚は逆）。
   * ここで担保するのは「効かせてはいけない場面で黙っていること」。
   */
  function runsWithGaps(colors: readonly BandColor[], gaps: readonly number[]): JointRun[] {
    let x = 0;
    return colors.map((color, index) => {
      if (index > 0) x += gaps[index - 1] as number;
      const run = { lab: labOf(color), start: x, end: x + 6 };
      x += 6;
      return run;
    });
  }

  it('3 バンドの読みには効かせない（許容差バンドが無い）', () => {
    // Arrange: 間隔が極端に偏っていても 3 バンドなら無視する
    const even = runsWithGaps(['brown', 'black', 'red'], [4, 4]);
    const skewed = runsWithGaps(['brown', 'black', 'red'], [1, 30]);

    // Act
    const a = jointReadResistor(even);
    const b = jointReadResistor(skewed);

    // Assert
    expect(a?.ohms).toBe(b?.ohms);
  });

  it('間隔が均一なら読みを変えない', () => {
    // Arrange
    const colors: BandColor[] = ['brown', 'black', 'red', 'gold'];

    // Act
    const even = jointReadResistor(runsWithGaps(colors, [5, 5, 5]));
    const alsoEven = jointReadResistor(runsWithGaps(colors, [6, 6, 6]));

    // Assert
    expect(even?.ohms).toBe(alsoEven?.ohms);
    expect(even?.ohms).toBeCloseTo(1000, 6);
  });

  it('許容差の手前が離れている向きを妨げない', () => {
    // Arrange: 許容差 gold が右端で、その手前だけ広い（IEC どおりの並び）
    const runs = runsWithGaps(['brown', 'black', 'red', 'gold'], [3, 3, 14]);

    // Act
    const reading = jointReadResistor(runs);

    // Assert
    expect(reading?.ohms).toBeCloseTo(1000, 6);
    expect(reading?.direction).toBe('ltr');
  });
});

/**
 * バンド間隔の不揃いによる確信度の減点。
 *
 * IEC 60062 は数字・倍率バンドを等間隔に印刷する。間隔が極端に不揃いなら、
 * ランの取りこぼしか過分割が起きている疑いが濃い。実測（39 枚）では
 * 間隔の変動係数が 0.55 を超える読みは 4 枚あり**すべて誤読**で、
 * 正解の最大は 0.50 だった。
 */
describe('間隔の不揃いによる確信度の減点', () => {
  /** 指定した間隔でランを並べる。 */
  function runsWithGaps(colors: readonly BandColor[], gaps: readonly number[]): JointRun[] {
    const width = 8;
    let x = 0;
    return colors.map((color, index) => {
      if (index > 0) x += width + (gaps[index - 1] as number);
      return { lab: labOf(color), start: x, end: x + width };
    });
  }

  it('間隔が不揃いなら確信度が下がる', () => {
    // Arrange: 同じ色・同じ本数で、間隔だけを変えた 2 通り
    const colors: BandColor[] = ['yellow', 'violet', 'red', 'gold'];
    const even = runsWithGaps(colors, [4, 4, 10]);
    const uneven = runsWithGaps(colors, [1, 20, 3]);

    // Act
    const evenReading = jointReadResistor(even);
    const unevenReading = jointReadResistor(uneven);

    // Assert: 値は同じでも、不揃いな方は自信を持てない
    expect(evenReading?.ohms).toBeCloseTo(4700, 6);
    expect(unevenReading?.ohms).toBeCloseTo(4700, 6);
    expect(unevenReading?.confidence).toBeLessThan(evenReading?.confidence ?? 0);
  });

  it('許容差バンドが離れているだけでは減点しない', () => {
    // Arrange: 数字・倍率は等間隔で、許容差の手前だけ広い（IEC 60062 の標準）。
    //          実測では正解の許容差間隔は芯の間隔の 2.44 倍までに収まる
    const colors: BandColor[] = ['yellow', 'violet', 'red', 'gold'];
    const standard = runsWithGaps(colors, [4, 4, 10]);
    const tight = runsWithGaps(colors, [4, 4, 4]);

    // Act / Assert
    expect(jointReadResistor(standard)?.confidence).toBeCloseTo(
      jointReadResistor(tight)?.confidence ?? 0,
      2,
    );
  });

  it('3 バンドには効かせない（許容差バンドが無く、間隔が 2 つしか無い）', () => {
    const colors: BandColor[] = ['yellow', 'violet', 'red'];

    const even = jointReadResistor(runsWithGaps(colors, [4, 4]));
    const uneven = jointReadResistor(runsWithGaps(colors, [1, 20]));

    expect(uneven?.confidence).toBeCloseTo(even?.confidence ?? 0, 2);
  });

  it('許容差バンドだけが極端に離れていれば減点する', () => {
    // Arrange: 芯の間隔 4 に対し許容差の手前が 32（8 倍）。実測の 15-339ohm と
    //          同じ形で、あいだのバンドを取りこぼしたときにこうなる
    const colors: BandColor[] = ['yellow', 'violet', 'red', 'gold'];
    const normal = runsWithGaps(colors, [4, 4, 8]);
    const stretched = runsWithGaps(colors, [4, 4, 32]);

    // Act / Assert
    expect(jointReadResistor(stretched)?.confidence).toBeLessThan(
      jointReadResistor(normal)?.confidence ?? 0,
    );
  });
});
