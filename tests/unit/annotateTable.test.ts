import { describe, expect, it } from 'vitest';
import { buildAnnotationSvg, tableHeightFor, type AnnotateInput } from '../../src/annotate/render.js';
import type { Band } from '../../src/types.js';
import type { OrientedBox } from '../../src/core/locate.js';

/**
 * 焼き込み画像のバンド一覧表。
 *
 * 以前は色名と意味をバンドのすぐ脇に置いていて、バンドが詰まると重なった。
 * 写真には番号だけを重ね、色名・色玉・意味は下の表にまとめる。
 */

const BOX: OrientedBox = {
  centerX: 200,
  centerY: 100,
  angleDeg: 0,
  length: 120,
  thickness: 40,
};

function bandsOf(colors: readonly Band['color'][]): Band[] {
  return colors.map((color, index) => ({
    color,
    start: index * 10,
    end: index * 10 + 8,
    confidence: 0.9,
  }));
}

function inputOf(overrides: Partial<AnnotateInput> = {}): AnnotateInput {
  return {
    width: 400,
    height: 200,
    box: BOX,
    bands: bandsOf(['red', 'red', 'brown']),
    rectify: { padding: 0.28, targetHeight: 40 },
    caption: 'test',
    ...overrides,
  };
}

describe('tableHeightFor', () => {
  it('バンドが無ければ高さ 0（表を描かない）', () => {
    expect(tableHeightFor(0)).toBe(0);
  });

  it('バンド数によらず一定の高さ（4 行の表）', () => {
    // Arrange / Act / Assert
    expect(tableHeightFor(3)).toBe(tableHeightFor(7));
    expect(tableHeightFor(3)).toBeGreaterThan(0);
  });
});

describe('バンド一覧表', () => {
  it('番号・色名・意味を表に出す', () => {
    // Arrange
    const input = inputOf({
      usedRuns: [
        { runIndex: 0, color: 'red', role: 'digit', roleText: '2' },
        { runIndex: 1, color: 'red', role: 'digit', roleText: '2' },
        { runIndex: 2, color: 'brown', role: 'multiplier', roleText: '×10' },
      ],
      droppedRuns: [],
    });

    // Act
    const svg = buildAnnotationSvg(input);

    // Assert
    expect(svg).toContain('>茶<');
    expect(svg).toContain('>×10<');
    expect(svg).toContain('>3<');
  });

  it('色名は写真に重ねず、表に 1 度だけ出す', () => {
    // Arrange: 茶は 1 本だけなので、表に出る 1 回だけのはず
    const svg = buildAnnotationSvg(inputOf());

    // Act
    const occurrences = svg.split('>茶<').length - 1;

    // Assert
    expect(occurrences).toBe(1);
  });

  it('採用されなかったランは意味の欄が「除外」になる', () => {
    // Arrange: ラン 2 を捨てる
    const input = inputOf({
      usedRuns: [
        { runIndex: 0, color: 'red', role: 'digit', roleText: '2' },
        { runIndex: 1, color: 'red', role: 'digit', roleText: '2' },
      ],
      droppedRuns: [2],
    });

    // Act
    const svg = buildAnnotationSvg(input);

    // Assert
    expect(svg).toContain('>除外<');
  });

  it('英字表記でも表を描く（日本語フォントが無い環境）', () => {
    const svg = buildAnnotationSvg(inputOf({ japanese: false }));

    expect(svg).toContain('>BRN<');
    expect(svg).not.toContain('>茶<');
  });

  it('検出できなかった写真では表を描かない', () => {
    const svg = buildAnnotationSvg(inputOf({ box: null, bands: [] }));

    expect(svg).not.toContain('>除外<');
    expect(tableHeightFor(0)).toBe(0);
  });
});
