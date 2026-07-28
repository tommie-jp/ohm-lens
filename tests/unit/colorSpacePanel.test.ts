import { describe, expect, it } from 'vitest';
import {
  buildColorSpaceSvg,
  COLOR_SPACE_PANEL_HEIGHT,
  projectToPanel,
} from '../../src/annotate/colorSpace.js';
import { DEFAULT_PALETTE } from '../../src/core/color/palette.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';

describe('projectToPanel', () => {
  it('立方体の 8 頂点がすべて別の位置に写る', () => {
    // Arrange: 等角投影だと黒と白が重なるので、斜投影であることの確認
    const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])));

    // Act
    const seen = new Set(
      corners.map(([x, y, z]) => {
        const point = projectToPanel(x as number, y as number, z as number);
        return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
      }),
    );

    // Assert
    expect(seen.size).toBe(8);
  });

  it('原点は投影しても原点', () => {
    const point = projectToPanel(0, 0, 0);

    expect(point.x).toBeCloseTo(0, 6);
    expect(point.y).toBeCloseTo(0, 6);
  });

  it('縦軸が上を向く（SVG の y は下向きなので符号が反転する）', () => {
    const low = projectToPanel(0, 0, 0);
    const high = projectToPanel(0, 1, 0);

    expect(high.y).toBeLessThan(low.y);
  });
});

describe('buildColorSpaceSvg', () => {
  const observed = [srgb255ToLab(180, 60, 50), srgb255ToLab(40, 40, 40)];

  it('基準色は色名をその色で置く', () => {
    // Arrange / Act
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, [], { x: 0, y: 0 });

    // Assert: 12 色 × 6 面（RGB と Lab、それぞれ立体 1 面と平面 2 面）
    const names = svg.match(/class="ref-name"/g) ?? [];
    expect(names).toHaveLength(72);
    expect(svg).toContain('>白<');
    expect(svg).toContain('>金<');
  });

  it('実測色はカラーコードの番号をその色で置く', () => {
    // Act
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    // Assert: 2 本 × 6 面。番号は 1 から
    const numbers = svg.match(/class="observed-number"/g) ?? [];
    expect(numbers).toHaveLength(12);
    expect(svg).toContain('>1<');
    expect(svg).toContain('>2<');
  });

  it('実測色の番号はその色で塗る', () => {
    // Arrange: 1 本目は赤っぽい色
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, [srgb255ToLab(200, 40, 40)], { x: 0, y: 0 });

    // Act
    const match = /class="observed-number"[^>]*fill="([^"]+)"/.exec(svg);

    // Assert
    expect(match?.[1]).toMatch(/^rgb\(2\d\d /);
  });

  it('2 次元の面には軸名が出る', () => {
    // Act
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 0, y: 0 });

    // Assert: 指定された 4 つの平面
    for (const title of ['B-R', 'G-B', 'b*-a*', 'b*-L*']) {
      expect(svg).toContain(title);
    }
  });

  it('バンドが 1 本も無くても壊れない', () => {
    expect(() => buildColorSpaceSvg(DEFAULT_PALETTE, [], { x: 0, y: 0 })).not.toThrow();
  });

  it('指定した位置に描く（パネルの高さぶんに収まる）', () => {
    // Arrange / Act
    const svg = buildColorSpaceSvg(DEFAULT_PALETTE, observed, { x: 100, y: 500 });

    // Assert: 全要素が y 500..500+高さ の帯に入る
    const ys = [...svg.matchAll(/(?:\scy|\sy)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...ys)).toBeLessThanOrEqual(500 + COLOR_SPACE_PANEL_HEIGHT);
  });

  it('Lab では黒・灰・白が重ならない（明度が軸になっている）', () => {
    // Arrange: a*b* 平面だけだと無彩色がすべて原点に重なる
    const black = projectToPanel(0.5, 11 / 100, 0.5);
    const grey = projectToPanel(0.5, 54 / 100, 0.5);
    const white = projectToPanel(0.5, 97 / 100, 0.5);

    // Assert
    expect(black.y).not.toBeCloseTo(grey.y, 3);
    expect(grey.y).not.toBeCloseTo(white.y, 3);
  });
});
