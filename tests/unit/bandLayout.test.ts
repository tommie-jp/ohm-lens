import { describe, expect, it } from 'vitest';
import { bandLayoutScore } from '../../src/core/bands/layout.js';
import type { ColorRun } from '../../src/core/bands/runs.js';

const LAB = { l: 50, a: 0, b: 0 };

/** 中心位置と幅からランを作る。 */
function runsAt(spec: readonly (readonly [number, number])[]): ColorRun[] {
  return spec.map(([center, width]) => ({
    start: center - width / 2,
    end: center + width / 2,
    lab: LAB,
  }));
}

describe('bandLayoutScore', () => {
  it('バンドが 3 本未満なら規格外', () => {
    expect(bandLayoutScore(runsAt([[20, 6], [40, 6]]))).toBeNull();
  });

  it('バンドが 7 本を超えたら規格外', () => {
    const runs = runsAt([20, 35, 50, 65, 80, 95, 110, 125].map((c) => [c, 6] as const));

    expect(bandLayoutScore(runs)).toBeNull();
  });

  it('等間隔・等幅の並びが最も高く評価される', () => {
    // Arrange: 4 本が 20px 間隔、幅もそろっている
    const even = runsAt([[20, 8], [40, 8], [60, 8], [80, 8]]);
    const uneven = runsAt([[20, 8], [26, 8], [60, 8], [95, 8]]);

    // Act / Assert
    expect(bandLayoutScore(even)).toBeGreaterThan(bandLayoutScore(uneven) as number);
  });

  it('幅がばらついているほど低く評価される', () => {
    const same = runsAt([[20, 8], [45, 8], [70, 8]]);
    const mixed = runsAt([[20, 3], [45, 8], [70, 20]]);

    expect(bandLayoutScore(same)).toBeGreaterThan(bandLayoutScore(mixed) as number);
  });

  it('完全に等間隔・等幅なら 1 に近い', () => {
    const runs = runsAt([[20, 8], [40, 8], [60, 8], [80, 8], [100, 8]]);

    expect(bandLayoutScore(runs)).toBeGreaterThan(0.9);
  });

  it('間隔がばらばらでも 0 未満にはならない', () => {
    const runs = runsAt([[10, 2], [12, 20], [90, 4]]);

    expect(bandLayoutScore(runs)).toBeGreaterThanOrEqual(0);
  });
});
