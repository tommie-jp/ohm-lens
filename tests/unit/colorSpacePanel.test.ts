import { describe, expect, it } from 'vitest';
import {
  buildColorSpaceSvg,
  COLOR_SPACE_PANEL_HEIGHT,
  COLOR_SPACE_PANEL_WIDTH,
} from '../../src/annotate/colorSpace.js';
import { DEFAULT_PALETTE } from '../../src/core/color/palette.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';

/** 面は RGB 2 枚 + Lab 2 枚。 */
const FACE_COUNT = 4;

describe('buildColorSpaceSvg', () => {
  const observed = [srgb255ToLab(180, 60, 50), srgb255ToLab(40, 40, 40)];

  it('指定の 4 平面を描く', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    for (const title of ['B-R', 'G-B', 'b*-a*', 'b*-L*']) {
      expect(svg).toContain(`>${title}<`);
    }
  });

  it('立体表示は描かない', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    expect(svg).not.toContain('>RGB<');
    expect(svg).not.toContain('>CIE L*a*b*<');
  });

  it('基準色は色名をその色で置く', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, [], { x: 0, y: 0 });

    const names = svg.match(/class="ref-name"/g) ?? [];
    expect(names).toHaveLength(12 * FACE_COUNT);
    expect(svg).toContain('>白<');
  });

  it('実測色はカラーコードの番号をその色で置く', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    const numbers = svg.match(/class="observed-number"/g) ?? [];
    expect(numbers).toHaveLength(observed.length * FACE_COUNT);
  });

  it('番号は色名より後（手前）に描く', () => {
    // Arrange / Act
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    // Assert: 面ごとに、色名をすべて描いてから番号を描く
    const firstName = svg.indexOf('class="ref-name"');
    const firstNumber = svg.indexOf('class="observed-number"');
    expect(firstNumber).toBeGreaterThan(firstName);
  });

  it('軸に目盛りの数値が出る', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    const ticks = svg.match(/class="tick-label"/g) ?? [];
    expect(ticks.length).toBeGreaterThan(FACE_COUNT * 6);
    // RGB は 0..1、Lab は実寸
    expect(svg).toContain('>0.5<');
    expect(svg).toContain('>50<');
  });

  it('格子を引く', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    const grid = svg.match(/class="grid"/g) ?? [];
    expect(grid.length).toBeGreaterThan(FACE_COUNT * 6);
  });

  it('面の下に番号と座標の一覧を出す', () => {
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    const lists = svg.match(/class="value-list"/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(FACE_COUNT);
    // 「1 (0.20, 0.61)」のような形
    expect(svg).toMatch(/1 \(-?[\d.]+, -?[\d.]+\)/);
  });

  it('バンドが 1 本も無くても壊れない', () => {
    expect(() => buildColorSpaceSvg(DEFAULT_PALETTE, [], { x: 0, y: 0 })).not.toThrow();
  });

  it('指定した位置に描く（パネルの大きさに収まる）', () => {
    // Arrange / Act
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 100, y: 500 });

    // Assert
    const ys = [...svg.matchAll(/\sy[12]?="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...ys)).toBeLessThanOrEqual(500 + COLOR_SPACE_PANEL_HEIGHT);

    const xs = [...svg.matchAll(/\sx[12]?="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...xs)).toBeLessThanOrEqual(100 + COLOR_SPACE_PANEL_WIDTH);
  });
});
