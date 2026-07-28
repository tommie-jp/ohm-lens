import { describe, expect, it } from 'vitest';
import {
  blockHeightFor,
  buildAnnotationSvg,
  tableHeightFor,
  type AnnotateInput,
} from '../../src/annotate/render.js';
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

describe('中心線プロファイルのグラフ', () => {
  const profileOf = (length: number): NonNullable<AnnotateInput['profile']> => ({
    samples: Array.from({ length }, (_, x) => ({
      x,
      lab: { l: 50 + (x % 7), a: x % 3, b: -5 + (x % 5) },
    })),
    extent: { start: 2, end: length - 2 },
    runs: [
      { start: 3, end: 6 },
      { start: 10, end: 13 },
    ],
  });

  it('プロファイルが無ければ帯の高さは表だけで決まる', () => {
    // Arrange / Act / Assert
    expect(blockHeightFor({ bands: bandsOf(['red', 'red', 'brown']) })).toBe(tableHeightFor(3));
  });

  it('プロファイルがあれば帯は表より高くなる（グラフを右に並べる）', () => {
    const height = blockHeightFor({
      bands: bandsOf(['red', 'red', 'brown']),
      profile: profileOf(40),
    });

    expect(height).toBeGreaterThan(tableHeightFor(3));
  });

  it('L* / a* / b* の 3 本を折れ線で描く', () => {
    // Arrange
    const input = inputOf({ width: 800, profile: profileOf(40) });

    // Act
    const svg = buildAnnotationSvg(input);

    // Assert
    expect(svg.split('<polyline').length - 1).toBe(3);
    expect(svg).toContain('>L*(左)<');
    expect(svg).toContain('>a*(右)<');
    expect(svg).toContain('>b*(右)<');
  });

  it('プロファイルが空ならグラフを描かない', () => {
    const svg = buildAnnotationSvg(
      inputOf({ width: 800, profile: { samples: [], extent: null, runs: [] } }),
    );

    expect(svg).not.toContain('<polyline');
  });

  it('幅が足りなければグラフを省く（表とパネルを壊さない）', () => {
    // Arrange: 表だけで埋まる細いキャンバス
    const svg = buildAnnotationSvg(inputOf({ width: 200, profile: profileOf(40) }));

    // Assert
    expect(svg).not.toContain('<polyline');
    expect(svg).toContain('>茶<');
  });

  it('ランの通し番号をグラフにも重ねる（写真・表と同じ番号）', () => {
    // Arrange: 番号は 写真 + 表 + グラフ の 3 か所に出る
    const withChart = buildAnnotationSvg(inputOf({ width: 800, profile: profileOf(40) }));
    const withoutChart = buildAnnotationSvg(inputOf({ width: 800 }));

    // Act
    const countIn = (svg: string): number => svg.split('>1<').length - 1;

    // Assert
    expect(countIn(withoutChart)).toBe(2);
    expect(countIn(withChart)).toBe(3);
  });

  it('除外されたランはグラフ上でも薄くする', () => {
    // Arrange
    const svg = buildAnnotationSvg(
      inputOf({
        width: 800,
        profile: profileOf(40),
        usedRuns: [{ runIndex: 0, color: 'red', role: 'digit', roleText: '2' }],
        droppedRuns: [1],
      }),
    );

    // Assert: 薄い番号（opacity 0.45）が描かれている
    expect(svg).toContain('opacity="0.45"');
  });

  it('L* と a*/b* でスケールを分け、目盛りを左右に出す', () => {
    // Arrange: L* は 50 前後、a*/b* は 0 付近と値域がまるで違う
    const input = inputOf({ width: 800, profile: profileOf(40) });

    // Act
    const svg = buildAnnotationSvg(input);

    // Assert: 左寄せ（右端揃え）と右寄せ（左端揃え）の目盛りが両方ある
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('text-anchor="start"');
    expect(svg).toContain('>L*(左)<');
    expect(svg).toContain('>a*(右)<');
    expect(svg).toContain('>b*(右)<');
  });

  it('L* と a*/b* がそれぞれプロットの上下 80% を使う', () => {
    // Arrange: L* は 40..69、a*/b* は -2..4 と桁違いの幅。
    // a* と b* は 1 つのスケールを共有するので、埋めるのは 2 本合わせて
    const samples = Array.from({ length: 30 }, (_, x) => ({
      x,
      lab: { l: 40 + x, a: -2 + (x % 7) * 0.5, b: 4 - (x % 5) * 0.5 },
    }));
    const svg = buildAnnotationSvg(
      inputOf({ width: 800, profile: { samples, extent: null, runs: [] } }),
    );

    // Act
    const ysOf = (index: number): number[] => {
      const all = [...svg.matchAll(/<polyline points="([^"]+)"/g)];
      return ((all[index] as RegExpMatchArray)[1] as string)
        .split(' ')
        .map((point) => Number(point.split(',')[1]));
    };
    const lightnessYs = ysOf(0);
    const chromaYs = [...ysOf(1), ...ysOf(2)];
    const spanOf = (ys: readonly number[]): number => Math.max(...ys) - Math.min(...ys);

    // Assert: どちらも同じ高さ（プロット高の 80%）を使う
    expect(spanOf(chromaYs)).toBeCloseTo(spanOf(lightnessYs), 1);
    // 最大値が 10%、最小値が 90% の位置なので、使う高さは 80%
    const plotHeight = 150 - 10 * 2 - 11;
    expect(spanOf(lightnessYs)).toBeCloseTo(plotHeight * 0.8, 1);
  });
});
