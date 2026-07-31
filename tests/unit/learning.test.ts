import { describe, expect, it } from 'vitest';
import {
  addObservations,
  expectedSequences,
  calibrationAssignments,
  matchRunsToValue,
  paletteOverrides,
  type Observations,
} from '../../src/core/learning.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor, ProfileSample } from '../../src/types.js';

function labOf(color: BandColor): LabColor {
  const [r, g, b] = BAND_SRGB[color];
  return srgb255ToLab(r, g, b);
}

function runsOf(colors: readonly BandColor[]): { lab: LabColor; start: number; end: number }[] {
  return colors.map((color, index) => ({
    lab: labOf(color),
    start: index * 12,
    end: index * 12 + 8,
  }));
}

describe('expectedSequences', () => {
  it('4.7kΩ ±5% は yellow-violet-red-gold を含む', () => {
    const sequences = expectedSequences(4700, 5).map((s) => s.join('-'));

    expect(sequences).toContain('yellow-violet-red-gold');
  });

  it('4.7kΩ ±1% は 5 バンド解釈も含む', () => {
    const sequences = expectedSequences(4700, 1).map((s) => s.join('-'));

    expect(sequences).toContain('yellow-violet-black-brown-brown');
  });

  it('1Ω ±1% は銀倍率の 5 バンドを含む', () => {
    const sequences = expectedSequences(1, 1).map((s) => s.join('-'));

    expect(sequences).toContain('brown-black-black-silver-brown');
  });

  it('許容差 null では許容差バンドを付けない', () => {
    const sequences = expectedSequences(1000, null).map((s) => s.join('-'));

    expect(sequences).toContain('brown-black-red');
    for (const sequence of sequences) {
      expect(sequence.endsWith('gold')).toBe(false);
    }
  });

  it('E 系列で表せない端数は空配列', () => {
    expect(expectedSequences(123.456, 5)).toEqual([]);
  });
});

describe('matchRunsToValue', () => {
  it('綺麗なランは正しい色に対応付く', () => {
    // Arrange
    const runs = runsOf(['yellow', 'violet', 'red', 'gold']);

    // Act
    const match = matchRunsToValue(runs, 4700, 5);

    // Assert
    expect(match).not.toBeNull();
    expect(match?.assignments.map((a) => a.color)).toEqual(['yellow', 'violet', 'red', 'gold']);
    expect(match?.cost).toBeLessThan(5);
  });

  it('逆向きでも対応付く', () => {
    const runs = runsOf(['gold', 'red', 'violet', 'yellow']);

    const match = matchRunsToValue(runs, 4700, 5);

    expect(match).not.toBeNull();
    expect(match?.assignments.map((a) => a.color)).toEqual(['gold', 'red', 'violet', 'yellow']);
  });

  it('ノイズのランを飛ばして対応付く', () => {
    // Arrange: 2 本目に灰色ノイズ
    const runs = [
      ...runsOf(['yellow']),
      { lab: labOf('grey'), start: 9, end: 11 },
      ...runsOf(['violet', 'red', 'gold']).map((run) => ({
        ...run,
        start: run.start + 20,
        end: run.end + 20,
      })),
    ];

    // Act
    const match = matchRunsToValue(runs, 4700, 5);

    // Assert
    expect(match?.assignments).toHaveLength(4);
  });

  it('値が合わないときはコストが高い', () => {
    // Arrange: 実体は 4.7kΩ のラン
    const runs = runsOf(['yellow', 'violet', 'red', 'gold']);

    // Act
    const right = matchRunsToValue(runs, 4700, 5);
    const wrong = matchRunsToValue(runs, 220, 5);

    // Assert
    expect(right?.cost ?? Number.POSITIVE_INFINITY).toBeLessThan(
      wrong?.cost ?? Number.POSITIVE_INFINITY,
    );
  });

  it('ランが足りなければ null', () => {
    expect(matchRunsToValue(runsOf(['yellow']), 4700, 5)).toBeNull();
  });

  it('許容差バンドが検出できていなくても、数字・倍率バンドだけで対応付く', () => {
    // Arrange: 220Ω ±5% だが金バンドが本体に融合して 3 本しか無い
    const runs = runsOf(['red', 'red', 'brown']);

    // Act
    const match = matchRunsToValue(runs, 220, 5);

    // Assert
    expect(match).not.toBeNull();
    expect(match?.assignments.map((a) => a.color)).toEqual(['red', 'red', 'brown']);
    expect(match?.toleranceObserved).toBe(false);
  });

  it('許容差バンドが検出できていれば toleranceObserved は true', () => {
    const match = matchRunsToValue(runsOf(['red', 'red', 'brown', 'gold']), 220, 5);

    expect(match?.toleranceObserved).toBe(true);
    expect(match?.assignments).toHaveLength(4);
  });
});

describe('addObservations / paletteOverrides', () => {
  it('対応付け結果から色ごとの Lab を蓄積する', () => {
    // Arrange
    let observations: Observations = {};

    // Act
    observations = addObservations(observations, [
      { color: 'red', lab: labOf('red') },
      { color: 'gold', lab: labOf('gold') },
    ]);
    observations = addObservations(observations, [{ color: 'red', lab: labOf('red') }]);

    // Assert
    expect(observations.red).toHaveLength(2);
    expect(observations.gold).toHaveLength(1);
  });

  it('件数が足りない色は上書きに含めない', () => {
    // Arrange
    let observations: Observations = {};
    for (let i = 0; i < 3; i += 1) {
      observations = addObservations(observations, [{ color: 'red', lab: labOf('red') }]);
    }
    observations = addObservations(observations, [{ color: 'gold', lab: labOf('gold') }]);

    // Act
    const overrides = paletteOverrides(observations, 3);

    // Assert
    expect(overrides.red).toBeDefined();
    expect(overrides.gold).toBeUndefined();
  });

  it('上書きは観測の中央値', () => {
    // Arrange
    let observations: Observations = {};
    for (const l of [40, 50, 60]) {
      observations = addObservations(observations, [{ color: 'red', lab: { l, a: 30, b: 20 } }]);
    }

    // Act
    const overrides = paletteOverrides(observations, 3);

    // Assert
    expect(overrides.red?.l).toBe(50);
  });

  it('既定の基準色からかけ離れた学習結果は採用しない', () => {
    // Arrange: 金を「ほぼ白」と学習してしまった状況。実写 39 枚で実際に起きた
    // （背景や肩のランに金が対応付けられ、L126 の白として学習された）
    let observations: Observations = {};
    for (let i = 0; i < 5; i += 1) {
      observations = addObservations(observations, [
        { color: 'gold', lab: { l: 126, a: -7, b: 9 } },
        { color: 'red', lab: labOf('red') },
      ]);
    }

    // Act
    const overrides = paletteOverrides(observations, 3);

    // Assert: 赤は採用、金は既定値のまま
    expect(overrides.red).toBeDefined();
    expect(overrides.gold).toBeUndefined();
  });

  it('妥当な範囲のずれなら採用する（実写に合わせるのが目的なので）', () => {
    // Arrange: 青は基準が彩度過剰で、実写とは 49 ほど離れるが正しい
    let observations: Observations = {};
    for (let i = 0; i < 3; i += 1) {
      observations = addObservations(observations, [{ color: 'blue', lab: { l: 41, a: -7, b: -28 } }]);
    }

    // Act
    const overrides = paletteOverrides(observations, 3);

    // Assert
    expect(overrides.blue).toBeDefined();
  });

  it('色ごとの保存件数に上限がある（古いものから捨てる）', () => {
    // Arrange
    let observations: Observations = {};
    for (let i = 0; i < 120; i += 1) {
      observations = addObservations(observations, [
        { color: 'red', lab: { l: i, a: 0, b: 0 } },
      ]);
    }

    // Assert: 上限 100 件、残っているのは新しい方
    expect(observations.red?.length).toBeLessThanOrEqual(100);
    expect(observations.red?.[0]?.l).toBeGreaterThan(0);
  });

  it('元の観測オブジェクトは変更しない（イミュータブル）', () => {
    // Arrange
    const original: Observations = { red: [labOf('red')] };

    // Act
    addObservations(original, [{ color: 'red', lab: labOf('red') }]);

    // Assert
    expect(original.red).toHaveLength(1);
  });
});

describe('金属色は学習しない', () => {
  /**
   * 金・銀の見え方は色順応補正のアンカー（本体色）に依存して**二峰性**になる。
   * 銀は青ボディでは L*81 b*+17（温色）、ベージュボディでは L*134 b*-16（寒色）
   * に写り、絶対 Lab の 1 点では表現できない。実際に学習させると
   * 05（銀→金で ×10 ずれ）と 15（白→銀で ×100 ずれ）が誤答になった。
   * 対でそろえて学習しても同じなので、金属色はパレットに入れない。
   */

  function samplesOf(lab: LabColor, count: number): LabColor[] {
    return Array.from({ length: count }, () => lab);
  }

  const GOLD: LabColor = { l: 75, a: 5, b: 29 };
  const SILVER: LabColor = { l: 74, a: 0, b: 2 };

  it('金は件数が足りても学習しない', () => {
    // Arrange
    let observations: Observations = {};
    observations = addObservations(
      observations,
      samplesOf(GOLD, 5).map((lab) => ({ color: 'gold' as const, lab })),
    );

    // Act / Assert
    expect(paletteOverrides(observations, 3).gold).toBeUndefined();
  });

  it('金・銀が対でそろっていても学習しない', () => {
    // Arrange
    let observations: Observations = {};
    observations = addObservations(observations, [
      ...samplesOf(GOLD, 3).map((lab) => ({ color: 'gold' as const, lab })),
      ...samplesOf(SILVER, 3).map((lab) => ({ color: 'silver' as const, lab })),
    ]);

    // Act
    const overrides = paletteOverrides(observations, 3);

    // Assert
    expect(overrides.gold).toBeUndefined();
    expect(overrides.silver).toBeUndefined();
  });

  it('金属色を外しても他の色は学習される', () => {
    // Arrange
    let observations: Observations = {};
    observations = addObservations(observations, [
      ...samplesOf(GOLD, 5).map((lab) => ({ color: 'gold' as const, lab })),
      ...samplesOf({ l: 45, a: 40, b: 28 }, 3).map((lab) => ({ color: 'red' as const, lab })),
    ]);

    // Act
    const overrides = paletteOverrides(observations, 3);

    // Assert
    expect(overrides.gold).toBeUndefined();
    expect(overrides.red).toBeDefined();
  });
});

/** 指定した色を並べたプロファイル（各バンドの幅を指定できる）。 */
function profileOf(
  layout: readonly { color: BandColor; width: number }[],
): { profile: ProfileSample[]; bands: { start: number; end: number }[] } {
  const profile: ProfileSample[] = [];
  const bands: { start: number; end: number }[] = [];
  let x = 0;
  for (const { color, width } of layout) {
    bands.push({ start: x, end: x + width });
    for (let i = 0; i < width; i += 1) {
      profile.push({ x, lab: labOf(color) });
      x += 1;
    }
  }
  return { profile, bands };
}

describe('calibrationAssignments', () => {
  it('バンド 1 本につき 3 点ぶんの観測を返す', () => {
    // Arrange
    const { profile, bands } = profileOf([
      { color: 'yellow', width: 9 },
      { color: 'violet', width: 9 },
    ]);

    // Act
    const assignments = calibrationAssignments(profile, bands, ['yellow', 'violet']);

    // Assert
    expect(assignments).toHaveLength(6);
    expect(assignments.map((one) => one.color)).toEqual([
      'yellow', 'yellow', 'yellow', 'violet', 'violet', 'violet',
    ]);
  });

  it('選んだ色をそのまま観測の色にする（推測色ではなく人手の正解）', () => {
    // Arrange: 見た目は yellow だが、人が violet だと直した場合
    const { profile, bands } = profileOf([{ color: 'yellow', width: 6 }]);

    // Act
    const assignments = calibrationAssignments(profile, bands, ['violet']);

    // Assert: 色名は violet、Lab は実写（yellow の見え方）
    expect(assignments.map((one) => one.color)).toEqual(['violet', 'violet', 'violet']);
    for (const one of assignments) {
      expect(one.lab.b).toBeCloseTo(labOf('yellow').b, 6);
    }
  });

  it('バンドを 3 区間に割り、区間ごとの中央値を取る', () => {
    // Arrange: 明度が段階的に変わる 1 本（前 30 / 中 50 / 後 70）
    const profile: ProfileSample[] = [];
    [30, 30, 30, 50, 50, 50, 70, 70, 70].forEach((l, x) => {
      profile.push({ x, lab: { l, a: 0, b: 0 } });
    });

    // Act
    const assignments = calibrationAssignments(profile, [{ start: 0, end: 9 }], ['red']);

    // Assert: 3 点が前・中・後を代表する（同じ値の複製ではない）
    expect(assignments.map((one) => one.lab.l)).toEqual([30, 50, 70]);
  });

  it('幅が 3 未満のバンドでも 3 点返す', () => {
    // Arrange
    const { profile, bands } = profileOf([{ color: 'red', width: 2 }]);

    // Act / Assert
    expect(calibrationAssignments(profile, bands, ['red'])).toHaveLength(3);
  });

  it('金・銀も観測としては保存する（採用の可否は paletteOverrides の仕事）', () => {
    // Arrange
    const { profile, bands } = profileOf([{ color: 'gold', width: 6 }]);

    // Act
    const assignments = calibrationAssignments(profile, bands, ['gold']);

    // Assert: 保存はする。ただし paletteOverrides は採用しない
    expect(assignments).toHaveLength(3);
    expect(paletteOverrides(addObservations({}, assignments)).gold).toBeUndefined();
  });

  it('プロファイルに画素が無いバンドは飛ばす', () => {
    // Arrange: プロファイルの外を指すバンド
    const { profile } = profileOf([{ color: 'red', width: 6 }]);

    // Act
    const assignments = calibrationAssignments(
      profile,
      [{ start: 0, end: 6 }, { start: 90, end: 96 }],
      ['red', 'blue'],
    );

    // Assert: 実在する 1 本ぶんだけ
    expect(assignments).toHaveLength(3);
    expect(assignments.every((one) => one.color === 'red')).toBe(true);
  });

  it('バンド数と色数が食い違うときは何も学習しない', () => {
    // Arrange
    const { profile, bands } = profileOf([
      { color: 'red', width: 6 },
      { color: 'blue', width: 6 },
    ]);

    // Act / Assert
    expect(calibrationAssignments(profile, bands, ['red'])).toEqual([]);
  });

  it('バンドが無ければ空', () => {
    expect(calibrationAssignments([], [], [])).toEqual([]);
  });

  it('1 回の校正で採用の最低件数に届く（校正した色がすぐ効く）', () => {
    // Arrange
    const { profile, bands } = profileOf([{ color: 'red', width: 9 }]);

    // Act
    const observations = addObservations({}, calibrationAssignments(profile, bands, ['red']));

    // Assert
    expect(paletteOverrides(observations).red).toBeDefined();
  });
});
