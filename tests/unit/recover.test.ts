import { describe, expect, it } from 'vitest';
import { recoverToleranceRun } from '../../src/core/bands/recover.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB, BODY_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor, ProfileSample } from '../../src/types.js';
import type { ColorRun } from '../../src/core/bands/runs.js';

/**
 * 見つからなかった許容差バンドの拾い直し。
 *
 * 位置を絞ったうえで本体色との差を見るので、全体のラン分割より弱い基準で
 * 拾える。ただし**条件を満たさないときに何もしない**ことが同じくらい大事で、
 * 無理に 4 本目を作ると誤読が増える。
 */

const BODY: LabColor = srgb255ToLab(...(BODY_SRGB.beige as [number, number, number]));
const bandLab = (color: BandColor): LabColor =>
  srgb255ToLab(...(BAND_SRGB[color] as [number, number, number]));

/** 本体色で埋めたプロファイルの、指定範囲だけ色を差し替える。 */
function profileWith(
  length: number,
  patches: readonly { start: number; end: number; lab: LabColor }[],
): ProfileSample[] {
  return Array.from({ length }, (_, x) => {
    const patch = patches.find((p) => x >= p.start && x < p.end);
    return { x, lab: patch === undefined ? BODY : patch.lab };
  });
}

function runOf(start: number, end: number, color: BandColor): ColorRun {
  return { start, end, lab: bandLab(color) };
}

describe('recoverToleranceRun', () => {
  /** 100 列の本体に、3 本のバンドと 1 本の金バンドを置いた並び。 */
  const THREE: ColorRun[] = [runOf(20, 26, 'brown'), runOf(34, 40, 'black'), runOf(48, 54, 'red')];

  it('3 本目の先に色の変化があれば 4 本目として拾う', () => {
    // Arrange: 3 本目の中心 51、間隔 14 なので探索窓は 65..79。そこに金を置く
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
      { start: 68, end: 74, lab: bandLab('gold') },
    ]);

    // Act
    const runs = recoverToleranceRun(profile, THREE);

    // Assert
    expect(runs).toHaveLength(4);
    expect((runs[3] as ColorRun).start).toBeGreaterThanOrEqual(65);
    expect((runs[3] as ColorRun).end).toBeLessThanOrEqual(80);
  });

  it('探索窓に色の変化が無ければ足さない', () => {
    // Arrange: バンドは 3 本だけ（先は本体色のまま）
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
    ]);

    // Act / Assert
    expect(recoverToleranceRun(profile, THREE)).toHaveLength(3);
  });

  it('ランが 3 本でなければ何もしない', () => {
    const profile = profileWith(100, []);

    expect(recoverToleranceRun(profile, THREE.slice(0, 2))).toHaveLength(2);
    expect(recoverToleranceRun(profile, [...THREE, runOf(68, 74, 'gold')])).toHaveLength(4);
  });

  it('3 本目が本体の中央付近に無ければ探さない', () => {
    // Arrange: 3 本が右に寄っていて、3 本目が 80% の位置にある
    const shifted = [runOf(50, 56, 'brown'), runOf(64, 70, 'black'), runOf(78, 84, 'red')];
    const profile = profileWith(100, [{ start: 92, end: 98, lab: bandLab('gold') }]);

    // Act / Assert: 先に場所が残っていないので拾わない
    expect(recoverToleranceRun(profile, shifted)).toHaveLength(3);
  });

  it('拾ったランの色はその区間の中央値になる', () => {
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
      { start: 68, end: 74, lab: bandLab('green') },
    ]);

    const runs = recoverToleranceRun(profile, THREE);

    expect((runs[3] as ColorRun).lab.a).toBeCloseTo(bandLab('green').a, 1);
  });

  it('空のプロファイルでも落ちない', () => {
    expect(recoverToleranceRun([], THREE)).toHaveLength(3);
  });
});
