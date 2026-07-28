import type { BandColor, LabColor } from '../types.js';
import { labToCss, labToRgb } from '../core/color/colorSpace.js';
import { BAND_COLOR_ABBR, BAND_COLOR_JA } from '../core/color/colors.js';
import type { Palette } from '../core/color/palette.js';

/**
 * 検出結果画像の左下に色空間を描く（デバッグ用）。
 *
 * 「この写真のバンドが基準色からどれだけ離れているか」を目で確かめるための面。
 * 誤読を追うとき、`summary.txt` の色名だけでは「惜しかったのか、まるで違うのか」
 * が分からない。基準色は**色名をその色で**、実測色は写真に焼いた**通し番号を
 * その色で**同じ面に置けば、どのバンドがどこへ引き寄せられたかが追える。
 *
 * 面は 2 軸の平面図を 4 枚。立体図もかつて描いていたが、重なった点の前後関係が
 * 読めないうえ場所を食うのでやめた。**どの成分で近いのかは平面図のほうが速い。**
 *
 * | 空間 | 面 |
 * | ------ | ---- |
 * | RGB | `B-R`、`G-B` |
 * | CIE L\*a\*b\* | `b*-a*`、`b*-L*` |
 *
 * 軸は**先に書いたほうが横**（`B-R` なら横が B、縦が R）。
 */

/** 面 1 つの一辺 [px]。 */
const PLANE_SIZE = 200;

/** 面の左に空ける幅 [px]（縦軸の目盛りと軸名のぶん）。 */
const AXIS_GUTTER = 34;

/** 面の下に空ける高さ [px]（横軸の目盛りと軸名のぶん）。 */
const AXIS_FOOTER = 34;

/** 面の見出しの高さ [px]。 */
const TITLE_HEIGHT = 15;

/** 座標一覧の 1 行の高さ [px]。 */
const LIST_LINE_HEIGHT = 12;

/** 座標一覧に使う最大行数。あふれたら打ち切る。 */
const LIST_MAX_LINES = 2;

/** 1 行に収める座標の個数。 */
const LIST_PER_LINE = 4;

const MARGIN = 12;
const GAP = 20;

/** 面 1 つが占める領域 [px]。 */
const CELL_WIDTH = AXIS_GUTTER + PLANE_SIZE;
const CELL_HEIGHT =
  TITLE_HEIGHT + PLANE_SIZE + AXIS_FOOTER + LIST_LINE_HEIGHT * LIST_MAX_LINES;

/** パネル帯の幅・高さ [px]。2 行 2 列。 */
export const COLOR_SPACE_PANEL_WIDTH = MARGIN * 2 + CELL_WIDTH * 2 + GAP;
export const COLOR_SPACE_PANEL_HEIGHT = MARGIN * 2 + CELL_HEIGHT * 2 + GAP;

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export interface ColorSpaceOptions {
  /** パネル帯の左上（元画像の座標） */
  readonly x: number;
  readonly y: number;
  /** 日本語フォントが無い環境では false */
  readonly japanese?: boolean;
}

/** 面の 1 軸。目盛りは実寸の値で持つ。 */
interface Axis {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

const UNIT_AXIS = (label: string): Axis => ({
  label,
  min: 0,
  max: 1,
  ticks: [0, 0.25, 0.5, 0.75, 1],
});

/** Lab の a\*・b\* の表示範囲。バンド色は概ねこの中に収まる。 */
const CHROMA_AXIS = (label: string): Axis => ({
  label,
  min: -60,
  max: 80,
  ticks: [-60, -30, 0, 30, 60],
});

const LIGHTNESS_AXIS: Axis = { label: 'L*', min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };

interface PlaneSpec {
  readonly title: string;
  readonly x: Axis;
  readonly y: Axis;
  /** その色の (横, 縦) を軸の実寸で返す */
  readonly at: (lab: LabColor) => readonly [number, number];
  /** 一覧に出すときの桁 */
  readonly digits: number;
}

const PLANES: readonly PlaneSpec[] = [
  {
    title: 'B-R',
    x: UNIT_AXIS('B'),
    y: UNIT_AXIS('R'),
    at: (lab) => {
      const { r, b } = labToRgb(lab);
      return [b, r];
    },
    digits: 2,
  },
  {
    title: 'G-B',
    x: UNIT_AXIS('G'),
    y: UNIT_AXIS('B'),
    at: (lab) => {
      const { g, b } = labToRgb(lab);
      return [g, b];
    },
    digits: 2,
  },
  {
    title: 'b*-a*',
    x: CHROMA_AXIS('b*'),
    y: CHROMA_AXIS('a*'),
    at: (lab) => [lab.b, lab.a],
    digits: 0,
  },
  {
    title: 'b*-L*',
    x: CHROMA_AXIS('b*'),
    y: LIGHTNESS_AXIS,
    at: (lab) => [lab.b, lab.l],
    digits: 0,
  },
];

function text(
  at: Point2,
  content: string,
  size: number,
  fill: string,
  options: { readonly anchor?: 'middle' | 'start' | 'end'; readonly className?: string } = {},
): string {
  const className = options.className === undefined ? '' : `class="${options.className}" `;
  return (
    `<text ${className}x="${at.x.toFixed(1)}" y="${at.y.toFixed(1)}" font-family="sans-serif" ` +
    `font-size="${size}" fill="${fill}" text-anchor="${options.anchor ?? 'middle'}" ` +
    `dominant-baseline="central">${content}</text>`
  );
}

/**
 * その色自身で文字を書く。
 *
 * 白や黄のような明るい色は白地に埋もれるので、明度に応じてフチの色を
 * 入れ替える（暗い色には白フチ、明るい色には暗いフチ）。
 */
function coloredText(
  at: Point2,
  content: string,
  lab: LabColor,
  size: number,
  className: string,
): string {
  const halo = lab.l > 70 ? 'rgba(60,60,66,0.85)' : 'rgba(255,255,255,0.9)';
  return (
    `<text class="${className}" x="${at.x.toFixed(1)}" y="${at.y.toFixed(1)}" ` +
    `font-family="sans-serif" font-size="${size}" font-weight="700" ` +
    `text-anchor="middle" dominant-baseline="central" ` +
    `stroke="${halo}" stroke-width="${(size * 0.3).toFixed(1)}" paint-order="stroke" ` +
    `fill="${labToCss(lab)}">${content}</text>`
  );
}

/** 軸の値を 0..1 の位置に直す（範囲外は端に張り付く）。 */
function normalize(axis: Axis, value: number): number {
  const ratio = (value - axis.min) / (axis.max - axis.min);
  return Math.min(1, Math.max(0, ratio));
}

/** 面の中の位置（縦は上向き）。 */
function locate(origin: Point2, plane: PlaneSpec, value: readonly [number, number]): Point2 {
  return {
    x: origin.x + normalize(plane.x, value[0]) * PLANE_SIZE,
    y: origin.y + (1 - normalize(plane.y, value[1])) * PLANE_SIZE,
  };
}

/** 目盛りの数値。整数なら小数点を付けない。 */
function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

/** 枠・格子・目盛り・軸名を描く。 */
function planeFrame(origin: Point2, plane: PlaneSpec): string {
  const parts: string[] = [
    text({ x: origin.x + PLANE_SIZE / 2, y: origin.y - 8 }, plane.title, 12, '#33333a'),
    `<rect x="${origin.x}" y="${origin.y}" width="${PLANE_SIZE}" height="${PLANE_SIZE}" ` +
      `fill="#ffffff" stroke="#9a9aa2" stroke-width="1" />`,
  ];

  for (const tick of plane.x.ticks) {
    const x = origin.x + normalize(plane.x, tick) * PLANE_SIZE;
    parts.push(
      `<line class="grid" x1="${x.toFixed(1)}" y1="${origin.y}" ` +
        `x2="${x.toFixed(1)}" y2="${origin.y + PLANE_SIZE}" stroke="#e2e2e8" stroke-width="1" />`,
      text({ x, y: origin.y + PLANE_SIZE + 8 }, formatTick(tick), 9, '#6b6b73', {
        className: 'tick-label',
      }),
    );
  }
  for (const tick of plane.y.ticks) {
    const y = origin.y + (1 - normalize(plane.y, tick)) * PLANE_SIZE;
    parts.push(
      `<line class="grid" x1="${origin.x}" y1="${y.toFixed(1)}" ` +
        `x2="${origin.x + PLANE_SIZE}" y2="${y.toFixed(1)}" stroke="#e2e2e8" stroke-width="1" />`,
      text({ x: origin.x - 5, y }, formatTick(tick), 9, '#6b6b73', {
        anchor: 'end',
        className: 'tick-label',
      }),
    );
  }

  parts.push(
    text({ x: origin.x + PLANE_SIZE / 2, y: origin.y + PLANE_SIZE + 20 }, plane.x.label, 10, '#44444c'),
    text({ x: origin.x - AXIS_GUTTER + 8, y: origin.y + PLANE_SIZE / 2 }, plane.y.label, 10, '#44444c'),
  );
  return parts.join('');
}

/** 面の下に「1 (0.20, 0.61) 2 (...)」を並べる。 */
function valueList(origin: Point2, plane: PlaneSpec, observed: readonly LabColor[]): string {
  const entries = observed.map((lab, index) => {
    const [x, y] = plane.at(lab);
    return `${index + 1} (${x.toFixed(plane.digits)}, ${y.toFixed(plane.digits)})`;
  });

  const lines: string[] = [];
  for (let at = 0; at < entries.length; at += LIST_PER_LINE) {
    lines.push(entries.slice(at, at + LIST_PER_LINE).join('  '));
  }

  const shown = lines.slice(0, LIST_MAX_LINES);
  if (lines.length > LIST_MAX_LINES) shown[LIST_MAX_LINES - 1] += ' …';

  return shown
    .map((line, index) =>
      text(
        { x: origin.x, y: origin.y + PLANE_SIZE + AXIS_FOOTER + LIST_LINE_HEIGHT * index },
        line,
        9,
        '#44444c',
        { anchor: 'start', className: 'value-list' },
      ),
    )
    .join('');
}

/**
 * 色空間パネルの SVG を返す。
 *
 * @param palette 基準色（色名をその色で置く）
 * @param observed この写真で検出したバンドの実測色（通し番号をその色で置く）
 */
export function buildColorSpaceSvg(
  palette: Palette,
  observed: readonly LabColor[],
  options: ColorSpaceOptions,
): string {
  const japanese = options.japanese ?? true;
  const nameOf = (color: BandColor): string =>
    japanese ? BAND_COLOR_JA[color] : BAND_COLOR_ABBR[color];
  const entries = Object.entries(palette.colors) as [BandColor, LabColor][];

  const parts: string[] = [
    `<rect x="${options.x}" y="${options.y}" width="${COLOR_SPACE_PANEL_WIDTH}" ` +
      `height="${COLOR_SPACE_PANEL_HEIGHT}" fill="rgba(255,255,255,0.93)" />`,
  ];

  PLANES.forEach((plane, index) => {
    const origin: Point2 = {
      x: options.x + MARGIN + AXIS_GUTTER + (CELL_WIDTH + GAP) * (index % 2),
      y: options.y + MARGIN + TITLE_HEIGHT + (CELL_HEIGHT + GAP) * Math.floor(index / 2),
    };

    parts.push(planeFrame(origin, plane));
    // 基準色を先に、実測色の番号をあとに（番号を手前に出す）
    for (const [color, lab] of entries) {
      parts.push(coloredText(locate(origin, plane, plane.at(lab)), nameOf(color), lab, 10, 'ref-name'));
    }
    observed.forEach((lab, number) => {
      parts.push(
        coloredText(locate(origin, plane, plane.at(lab)), String(number + 1), lab, 13, 'observed-number'),
      );
    });
    parts.push(valueList(origin, plane, observed));
  });

  return parts.join('');
}
