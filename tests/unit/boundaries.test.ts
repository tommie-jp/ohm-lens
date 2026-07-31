import { describe, expect, it } from 'vitest';
import {
  boxMatches,
  intervalsFromRuns,
  labelledSamples,
  mergeSeeds,
  scoreBands,
  scoreBoundaries,
  type BandInterval,
  type BoundaryLabel,
} from '../../src/core/bands/boundaries.js';
import type { OrientedBox } from '../../src/core/locate.js';
import type { ProfileSample } from '../../src/types.js';

/**
 * バンド境界の正解データ。
 *
 * 位置は「検出した箱の長手方向の %」。左端が 0%、右端が 100%。
 * 手で直すことを前提にした形式なので、
 *
 * - 種（推定値）を吐いて人が直す。**直した値は二度と上書きしない**
 * - 境界点の羅列ではなくバンドの区間。色列と 1 対 1 なので本数の食い違いに気づける
 *
 * 詳細は `docs/13-バンド境界の検出指標.md` §7。
 */

const BOX: OrientedBox = {
  centerX: 100,
  centerY: 50,
  angleDeg: 0,
  length: 80,
  thickness: 20,
};

function labelOf(bands: BandInterval[], verified = false): BoundaryLabel {
  return { verified, box: BOX, bands };
}

describe('intervalsFromRuns', () => {
  it('サンプル添字を長手方向の % に写す', () => {
    // Arrange: ROI 余白 0.28 なので、101 列は -28%〜128% を映している
    const runs = [
      { start: 0, end: 50 },
      { start: 50, end: 100 },
    ];

    // Act
    const intervals = intervalsFromRuns(runs, 101, 0.28, ['grey', 'red']);

    // Assert
    expect(intervals[0]).toEqual({ color: 'grey', start: -28, end: 50 });
    expect(intervals[1]).toEqual({ color: 'red', start: 50, end: 128 });
  });

  it('% は整数に丸める（元データの分解能を超えないため）', () => {
    // Arrange: 117 列（実測の中央値）なら 1 サンプル ≒ 1.33%
    const intervals = intervalsFromRuns([{ start: 40, end: 47 }], 117, 0.28, ['white']);

    // Act / Assert
    expect(Number.isInteger((intervals[0] as BandInterval).start)).toBe(true);
    expect(Number.isInteger((intervals[0] as BandInterval).end)).toBe(true);
  });

  it('色が足りなければ色なしの区間として残す', () => {
    // Arrange: ランのほうが多い（デコーダが捨てたランがある）場合
    const intervals = intervalsFromRuns([{ start: 0, end: 10 }], 101, 0, []);

    // Assert
    expect(intervals).toHaveLength(1);
    expect((intervals[0] as BandInterval).color).toBeNull();
  });
});

describe('mergeSeeds', () => {
  it('人が確認済みのエントリは上書きしない', () => {
    // Arrange
    const existing = { 'a.jpg': labelOf([{ color: 'red', start: 10, end: 20 }], true) };
    const seeds = { 'a.jpg': labelOf([{ color: 'blue', start: 90, end: 95 }]) };

    // Act
    const merged = mergeSeeds(existing, seeds);

    // Assert
    expect(merged['a.jpg']).toEqual(existing['a.jpg']);
  });

  it('未確認のエントリは新しい種で置き換える', () => {
    const existing = { 'a.jpg': labelOf([{ color: 'red', start: 10, end: 20 }], false) };
    const seeds = { 'a.jpg': labelOf([{ color: 'blue', start: 90, end: 95 }]) };

    expect(merged(existing, seeds).bands[0]?.color).toBe('blue');
  });

  it('新しいファイルは足す', () => {
    const merged = mergeSeeds({}, { 'b.jpg': labelOf([{ color: 'red', start: 1, end: 2 }]) });

    expect(Object.keys(merged)).toEqual(['b.jpg']);
  });

  it('種に無いエントリは消さない（消した画像の正解を失わない）', () => {
    // Arrange: 画像を消しても、直した正解は残しておきたい
    const existing = { 'gone.jpg': labelOf([{ color: 'red', start: 1, end: 2 }], true) };

    // Act
    const merged = mergeSeeds(existing, {});

    // Assert
    expect(Object.keys(merged)).toEqual(['gone.jpg']);
  });
});

function merged(
  existing: Record<string, BoundaryLabel>,
  seeds: Record<string, BoundaryLabel>,
): BoundaryLabel {
  return mergeSeeds(existing, seeds)['a.jpg'] as BoundaryLabel;
}

describe('scoreBoundaries', () => {
  const truth: BandInterval[] = [
    { color: 'grey', start: 10, end: 20 },
    { color: 'red', start: 40, end: 50 },
  ];

  it('許容差の内側なら一致とみなす', () => {
    // Arrange: すべて 1% ずれている（許容差 2%）
    const detected: BandInterval[] = [
      { color: 'grey', start: 11, end: 21 },
      { color: 'red', start: 41, end: 51 },
    ];

    // Act
    const score = scoreBoundaries(detected, truth, 2);

    // Assert: 境界は 4 本
    expect(score.matched).toBe(4);
    expect(score.missed).toBe(0);
    expect(score.spurious).toBe(0);
    expect(score.meanError).toBeCloseTo(1, 6);
  });

  it('許容差の外は取りこぼしと余分に振り分ける', () => {
    // Arrange: 2 本目のバンドがまるごとずれている
    const detected: BandInterval[] = [
      { color: 'grey', start: 10, end: 20 },
      { color: 'red', start: 80, end: 90 },
    ];

    // Act
    const score = scoreBoundaries(detected, truth, 2);

    // Assert
    expect(score.matched).toBe(2);
    expect(score.missed).toBe(2);
    expect(score.spurious).toBe(2);
  });

  it('1 本の正解に 2 本を当てても二重には数えない', () => {
    // Arrange: 検出が細かく割れている
    const detected: BandInterval[] = [
      { color: 'grey', start: 10, end: 15 },
      { color: 'grey', start: 15, end: 20 },
    ];

    // Act
    const score = scoreBoundaries(detected, truth, 2);

    // Assert: 10 と 20 が当たり、15 が 2 本余る。40/50 は取りこぼし
    expect(score.matched).toBe(2);
    expect(score.spurious).toBe(2);
    expect(score.missed).toBe(2);
  });

  it('正解が空なら検出はすべて余分', () => {
    const score = scoreBoundaries([{ color: 'red', start: 1, end: 2 }], [], 2);

    expect(score.matched).toBe(0);
    expect(score.spurious).toBe(2);
    expect(score.missed).toBe(0);
  });
});

describe('labelledSamples', () => {
  /** 20 列ぶんの単色プロファイル。範囲外は本体色。 */
  const profileOf = (): ProfileSample[] =>
    Array.from({ length: 21 }, (_, x) => ({
      x,
      lab: x >= 8 && x <= 12 ? { l: 40, a: 30, b: 20 } : { l: 70, a: 5, b: 20 },
    }));

  it('区間の中の中央値を色として取り出す', () => {
    // Arrange: 余白 0 なので 40%〜60% が列 8〜12 にあたる
    const bands: BandInterval[] = [{ color: 'red', start: 40, end: 60 }];

    // Act
    const samples = labelledSamples(profileOf(), bands, 0);

    // Assert
    expect(samples).toHaveLength(1);
    expect(samples[0]?.color).toBe('red');
    expect(samples[0]?.lab).toEqual({ l: 40, a: 30, b: 20 });
  });

  it('色が分かっていない区間は飛ばす', () => {
    const samples = labelledSamples(profileOf(), [{ color: null, start: 40, end: 60 }], 0);

    expect(samples).toEqual([]);
  });

  it('プロファイルの外に出る区間は飛ばす（列が取れない）', () => {
    const samples = labelledSamples(profileOf(), [{ color: 'red', start: 200, end: 220 }], 0);

    expect(samples).toEqual([]);
  });

  it('ROI 余白を差し引いて位置を合わせる', () => {
    // Arrange: 余白 0.25 なら、-25%〜125% が列 0〜20 に対応する。
    // 列 8〜12 の中心（列 10）は 50%
    const bands: BandInterval[] = [{ color: 'red', start: 40, end: 60 }];

    // Act
    const samples = labelledSamples(profileOf(), bands, 0.25);

    // Assert: 余白のぶん窓が狭まるが、同じ色を拾える
    expect(samples[0]?.lab).toEqual({ l: 40, a: 30, b: 20 });
  });
});

describe('boxMatches', () => {
  const box = { centerX: 100, centerY: 50, angleDeg: 0, length: 80, thickness: 20 };

  it('同じ枠なら一致', () => {
    expect(boxMatches(box, box)).toBe(true);
  });

  it('長さが 5% 以上変わったら不一致（% の基準が動くため）', () => {
    expect(boxMatches(box, { ...box, length: 80 * 1.06 })).toBe(false);
    expect(boxMatches(box, { ...box, length: 80 * 1.02 })).toBe(true);
  });

  it('中心が長さの 5% 以上ずれたら不一致', () => {
    expect(boxMatches(box, { ...box, centerX: 100 + 80 * 0.06 })).toBe(false);
    expect(boxMatches(box, { ...box, centerX: 100 + 80 * 0.02 })).toBe(true);
  });
});

describe('scoreBands', () => {
  it('区間が十分重なるものだけ対応が付いたと数える', () => {
    // Arrange: 2 本の正解に、ぴったり重なる検出が 2 本
    const truth: BandInterval[] = [
      { color: 'red', start: 10, end: 20 },
      { color: 'gold', start: 40, end: 50 },
    ];
    const detected: BandInterval[] = [
      { color: 'red', start: 11, end: 21 },
      { color: 'gold', start: 39, end: 49 },
    ];

    // Act
    const score = scoreBands(detected, truth, 0.3);

    // Assert
    expect(score).toEqual({ matched: 2, missed: 0, spurious: 0 });
  });

  it('本体ごと覆っただけの巨大なランは対応と認めない', () => {
    // Arrange: 正解 1 本を、ROI 全体に広がる 1 本のランが覆っている。
    // 端点の近さで測るとこれを「見つけた」と数えてしまう（本数の失敗が隠れる）
    const truth: BandInterval[] = [{ color: 'gold', start: 45, end: 55 }];
    const detected: BandInterval[] = [{ color: null, start: 0, end: 100 }];

    // Act
    const score = scoreBands(detected, truth, 0.3);

    // Assert
    expect(score).toEqual({ matched: 0, missed: 1, spurious: 1 });
  });

  it('正解 1 本に検出 1 本まで（割れた検出を二重に数えない）', () => {
    // Arrange: 1 本の正解に、それを二分した検出が 2 本
    const truth: BandInterval[] = [{ color: 'brown', start: 0, end: 20 }];
    const detected: BandInterval[] = [
      { color: 'brown', start: 0, end: 10 },
      { color: 'brown', start: 10, end: 20 },
    ];

    // Act
    const score = scoreBands(detected, truth, 0.3);

    // Assert: 良いほう 1 本だけが対応、残りは余分
    expect(score).toEqual({ matched: 1, missed: 0, spurious: 1 });
  });

  it('重なりが無ければ取りこぼしと余分の両方に数える', () => {
    // Arrange
    const truth: BandInterval[] = [{ color: 'red', start: 10, end: 20 }];
    const detected: BandInterval[] = [{ color: 'red', start: 60, end: 70 }];

    // Act
    const score = scoreBands(detected, truth, 0.3);

    // Assert
    expect(score).toEqual({ matched: 0, missed: 1, spurious: 1 });
  });
});
