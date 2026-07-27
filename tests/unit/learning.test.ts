import { describe, expect, it } from 'vitest';
import {
  addObservations,
  expectedSequences,
  matchRunsToValue,
  paletteOverrides,
  type Observations,
} from '../../src/core/learning.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor } from '../../src/types.js';

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
