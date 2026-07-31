import { describe, expect, it } from 'vitest';
import { maxScanSpread, runScanSpreads } from '../../src/core/bands/scanSpread.js';
import type { ColorRun } from '../../src/core/bands/runs.js';
import type { LabColor, ProfileSample } from '../../src/types.js';

/**
 * バンド色の行方向のばらつき（docs/13 Phase 5）。
 *
 * バンドは本体の全高にわたる縦縞なので、どの走査線も同じ色を見ているはず。
 * 見ていなければ反射・残留回転・そもそもバンドではないものを疑える。
 */

const BEIGE: LabColor = { l: 70, a: 5, b: 30 };
const RED: LabColor = { l: 45, a: 60, b: 45 };
const GREEN: LabColor = { l: 50, a: -45, b: 30 };

/** バンド区間だけ色を変えた走査線（幅 20）。 */
function scanWith(band: LabColor, width = 20): ProfileSample[] {
  return Array.from({ length: width }, (_, x) => ({
    x,
    lab: x >= 4 && x < 12 ? band : BEIGE,
  }));
}

const RUNS: ColorRun[] = [{ start: 4, end: 12, lab: RED }];

describe('runScanSpreads', () => {
  it('どの走査線も同じ色ならばらつきは 0', () => {
    // Arrange / Act
    const spreads = runScanSpreads(RUNS, [scanWith(RED), scanWith(RED), scanWith(RED)]);

    // Assert
    expect(spreads).toHaveLength(1);
    expect(spreads[0]).toBeCloseTo(0, 6);
  });

  it('走査線ごとに色が散らばっていればばらつきが出る', () => {
    // Arrange: 3 本がそれぞれ違う色に見えている
    const scans = [scanWith(RED), scanWith(GREEN), scanWith(BEIGE)];

    // Act
    const spreads = runScanSpreads(RUNS, scans);

    // Assert
    expect(spreads[0] as number).toBeGreaterThan(0);
  });

  it('1 本だけ外れていても反応しない（中央値なので反射 1 本では騒がない）', () => {
    // Arrange: 3 本のうち 1 本だけ緑。多数は赤で一致している
    const scans = [scanWith(RED), scanWith(RED), scanWith(GREEN)];

    // Act
    const spreads = runScanSpreads(RUNS, scans);

    // Assert: 測っているのは「典型的な走査線がどれだけ外れているか」
    expect(spreads[0]).toBeCloseTo(0, 6);
  });

  it('走査線が 1 本以下なら測れない', () => {
    expect(runScanSpreads(RUNS, [scanWith(RED)])).toStrictEqual([]);
    expect(runScanSpreads(RUNS, [])).toStrictEqual([]);
  });

  it('ランが無ければ空配列', () => {
    expect(runScanSpreads([], [scanWith(RED), scanWith(RED)])).toStrictEqual([]);
  });

  it('走査線がランの区間を覆っていなければ null', () => {
    // Arrange: 幅 6 しかない走査線（ランは x=4..12）
    const short = scanWith(RED, 6);

    // Act / Assert
    expect(runScanSpreads(RUNS, [short, short])).toStrictEqual([null]);
  });

  it('バンドの内側だけを見る（縁に漏れた隣の色を無視する）', () => {
    // Arrange: ラン区間の両端 1 列だけ本体色が漏れている
    const leaky = (lab: LabColor): ProfileSample[] =>
      Array.from({ length: 20 }, (_, x) => ({
        x,
        lab: x >= 5 && x < 11 ? lab : BEIGE,
      }));

    // Act
    const spreads = runScanSpreads(RUNS, [leaky(RED), leaky(RED), leaky(RED)]);

    // Assert: 漏れを見ていれば 0 にならない
    expect(spreads[0]).toBeCloseTo(0, 6);
  });
});

describe('maxScanSpread', () => {
  it('最も揃っていないバンドのばらつきを返す', () => {
    // Arrange: 2 本のラン。片方だけ走査線ごとに色が違う
    const runs: ColorRun[] = [
      { start: 4, end: 8, lab: RED },
      { start: 12, end: 16, lab: RED },
    ];
    const scan = (first: LabColor, second: LabColor): ProfileSample[] =>
      Array.from({ length: 20 }, (_, x) => ({
        x,
        lab: x >= 4 && x < 8 ? first : x >= 12 && x < 16 ? second : BEIGE,
      }));

    // Arrange: 2 本目のバンドだけ走査線ごとに散らばっている
    const scans = [scan(RED, RED), scan(RED, GREEN), scan(RED, BEIGE)];

    // Act
    const worst = maxScanSpread(runs, scans) as number;
    const spreads = runScanSpreads(runs, scans);

    // Assert
    expect(worst).toBeCloseTo(Math.max(...spreads.map((value) => value ?? 0)), 6);
    expect(spreads[0]).toBeCloseTo(0, 6);
    expect(worst).toBeGreaterThan(0);
  });

  it('測れなければ null', () => {
    expect(maxScanSpread([], [])).toBeNull();
    expect(maxScanSpread(RUNS, [scanWith(RED)])).toBeNull();
  });
});
