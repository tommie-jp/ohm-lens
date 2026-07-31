import { describe, expect, it } from 'vitest';
import { buildAnnotationSvg, type AnnotateInput } from '../../src/annotate/render.js';
import { LABEL_COLOR } from '../../src/annotate/profileChart.js';
import type { BandInterval } from '../../src/core/bands/boundaries.js';
import type { Band } from '../../src/types.js';
import type { OrientedBox } from '../../src/core/locate.js';

/**
 * 正解の境界を Lab グラフに重ねる。
 *
 * 手で直すときは「検出がどこを切ったか」と「正解はどこか」を並べて見たい。
 * 検出のラン境界は赤、正解は緑にして、X 軸の % 目盛りの上で見比べる。
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
    width: 800,
    height: 200,
    box: BOX,
    bands: bandsOf(['red', 'red', 'brown']),
    rectify: { padding: 0.28, targetHeight: 40 },
    caption: 'test',
    profile: {
      samples: Array.from({ length: 40 }, (_, x) => ({
        x,
        lab: { l: 50 + (x % 7), a: x % 3, b: -5 + (x % 5) },
      })),
      extent: { start: 2, end: 38 },
      runs: [
        { start: 3, end: 6 },
        { start: 10, end: 13 },
      ],
    },
    ...overrides,
  };
}

const LABELS: BandInterval[] = [
  { color: 'grey', start: 10, end: 20 },
  { color: 'red', start: 40, end: 50 },
];

describe('正解の境界の重ね描き', () => {
  it('正解があれば区間を描く', () => {
    // Arrange / Act
    const svg = buildAnnotationSvg(inputOf({ labels: LABELS }));

    // Assert: 区間 2 本ぶん
    expect(svg.split(LABEL_COLOR).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('正解が無ければ何も足さない', () => {
    const svg = buildAnnotationSvg(inputOf());

    expect(svg).not.toContain(LABEL_COLOR);
  });

  it('正解は % の位置に置く（サンプル添字ではない）', () => {
    // Arrange: 0% と 100% は ROI 余白 0.28 のとき、プロット幅の 28/156 と 128/156
    const svg = buildAnnotationSvg(
      inputOf({ labels: [{ color: 'grey', start: 0, end: 100 }] }),
    );

    // Act: 正解の矩形の x と幅を読む
    const match = svg.match(
      new RegExp(`<rect x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)"[^>]*fill="${LABEL_COLOR}"`),
    );

    // Assert: 幅は 100/156 = 64% ぶん
    expect(match).not.toBeNull();
    const width = Number((match as RegExpMatchArray)[2]);
    const plotWidth = 800 - 10 * 2 - 40 * 2;
    expect(width / plotWidth).toBeCloseTo(100 / 156, 2);
  });
});
