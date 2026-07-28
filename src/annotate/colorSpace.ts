import type { BandColor, LabColor } from '../types.js';
import { deltaE76, labToCss, labToRgb } from '../core/color/colorSpace.js';
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
 *
 * 面の下には 1 バンド 1 行で座標と、近い基準色を **2 通り**並べる。
 *
 * - **面** — その平面の 2 軸だけで測った距離。面ごとに違う答えが出る
 * - **空間** — その色空間の 3 軸で測った距離（RGB / Lab）。同じ空間の 2 面では
 *   同じ答えになる
 *
 * 「B-R では赤が近いが b\*-a\* では茶」のように、どの成分が効いて誤読したのかを
 * 切り分けられる。
 */

/** 面の左に空ける幅 [px]（縦軸の目盛りと軸名のぶん）。 */
const AXIS_GUTTER = 36;

/** 面の下に空ける高さ [px]（横軸の目盛りと軸名のぶん）。 */
const AXIS_FOOTER = 34;

/** 面の見出しの高さ [px]。 */
const TITLE_HEIGHT = 16;

/** 座標一覧の 1 行の高さ [px]。 */
const LIST_LINE_HEIGHT = 13;

const MARGIN = 12;
const GAP = 20;

/** 枠と目盛りの色。格子は薄いまま（点が埋もれないように）。 */
const AXIS_COLOR = '#111';
const GRID_COLOR = '#e2e2e8';

/** 幅の指定が無いときに使う既定の幅 [px]。 */
const DEFAULT_PANEL_WIDTH = 800;

/** 面 1 つの一辺の下限 [px]。狭い写真ではパネルが写真からはみ出す。 */
const MIN_PLANE_SIZE = 220;

/** 近い基準色をいくつ並べるか。 */
const NEAREST_COUNT = 3;

/**
 * 使える幅から面 1 つの一辺を決める。
 * **1 面が画像幅の半分ほど**になるように、2 列ぶんを幅いっぱいに詰める。
 */
function planeSizeFor(availableWidth: number): number {
  const usable = availableWidth - MARGIN * 2 - GAP - AXIS_GUTTER * 2;
  return Math.max(MIN_PLANE_SIZE, Math.floor(usable / 2));
}

export interface PanelSize {
  readonly width: number;
  readonly height: number;
  readonly planeSize: number;
}

/**
 * パネル帯の大きさ。バンド数と使える幅で変わる。
 * 一覧が 1 バンド 1 行なので、本数ぶん縦に伸びる。
 */
export function colorSpacePanelSize(bandCount: number, availableWidth: number): PanelSize {
  const planeSize = planeSizeFor(availableWidth);
  const cellHeight =
    TITLE_HEIGHT + planeSize + AXIS_FOOTER + LIST_LINE_HEIGHT * Math.max(1, bandCount);

  return {
    width: MARGIN * 2 + (AXIS_GUTTER + planeSize) * 2 + GAP,
    height: MARGIN * 2 + cellHeight * 2 + GAP,
    planeSize,
  };
}

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
  /** パネルに使える幅 [px]。面の大きさをこれに合わせる。 */
  readonly width?: number;
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
  /** 「空間」の距離をどちらで測るか */
  readonly space: 'rgb' | 'lab';
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
    space: 'rgb',
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
    space: 'rgb',
  },
  {
    title: 'b*-a*',
    x: CHROMA_AXIS('b*'),
    y: CHROMA_AXIS('a*'),
    at: (lab) => [lab.b, lab.a],
    digits: 0,
    space: 'lab',
  },
  {
    title: 'b*-L*',
    x: CHROMA_AXIS('b*'),
    y: LIGHTNESS_AXIS,
    at: (lab) => [lab.b, lab.l],
    digits: 0,
    space: 'lab',
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
function locate(
  origin: Point2,
  plane: PlaneSpec,
  value: readonly [number, number],
  planeSize: number,
): Point2 {
  return {
    x: origin.x + normalize(plane.x, value[0]) * planeSize,
    y: origin.y + (1 - normalize(plane.y, value[1])) * planeSize,
  };
}

/** 枠・格子・目盛り・軸名を描く。枠と目盛りは黒、格子は薄く。 */
function planeFrame(origin: Point2, plane: PlaneSpec, planeSize: number): string {
  const parts: string[] = [
    text({ x: origin.x + planeSize / 2, y: origin.y - 8 }, plane.title, 12, AXIS_COLOR),
    `<rect x="${origin.x}" y="${origin.y}" width="${planeSize}" height="${planeSize}" ` +
      `fill="#ffffff" stroke="${AXIS_COLOR}" stroke-width="1" />`,
  ];

  for (const tick of plane.x.ticks) {
    const x = origin.x + normalize(plane.x, tick) * planeSize;
    parts.push(
      `<line class="grid" x1="${x.toFixed(1)}" y1="${origin.y}" ` +
        `x2="${x.toFixed(1)}" y2="${origin.y + planeSize}" stroke="${GRID_COLOR}" stroke-width="1" />`,
      text({ x, y: origin.y + planeSize + 8 }, String(tick), 9, AXIS_COLOR, {
        className: 'tick-label',
      }),
    );
  }
  for (const tick of plane.y.ticks) {
    const y = origin.y + (1 - normalize(plane.y, tick)) * planeSize;
    parts.push(
      `<line class="grid" x1="${origin.x}" y1="${y.toFixed(1)}" ` +
        `x2="${origin.x + planeSize}" y2="${y.toFixed(1)}" stroke="${GRID_COLOR}" stroke-width="1" />`,
      text({ x: origin.x - 5, y }, String(tick), 9, AXIS_COLOR, {
        anchor: 'end',
        className: 'tick-label',
      }),
    );
  }

  parts.push(
    text(
      { x: origin.x + planeSize / 2, y: origin.y + planeSize + 21 },
      plane.x.label,
      11,
      AXIS_COLOR,
    ),
    text({ x: origin.x - AXIS_GUTTER + 9, y: origin.y + planeSize / 2 }, plane.y.label, 11, AXIS_COLOR),
  );
  return parts.join('');
}

/** 距離の近い順に基準色の名前を返す。 */
function nearestNames(
  entries: readonly [BandColor, LabColor][],
  distance: (lab: LabColor) => number,
  nameOf: (color: BandColor) => string,
): string {
  return entries
    .map(([color, lab]) => ({ name: nameOf(color), value: distance(lab) }))
    .sort((a, b) => a.value - b.value)
    .slice(0, NEAREST_COUNT)
    .map((entry) => entry.name)
    .join(' ');
}

/** その平面の 2 軸で測った距離。 */
function planeDistance(plane: PlaneSpec, a: LabColor, b: LabColor): number {
  const [ax, ay] = plane.at(a);
  const [bx, by] = plane.at(b);
  return Math.hypot(ax - bx, ay - by);
}

/** その色空間の 3 軸で測った距離。 */
function spaceDistance(plane: PlaneSpec, a: LabColor, b: LabColor): number {
  if (plane.space === 'lab') return deltaE76(a, b);
  const first = labToRgb(a);
  const second = labToRgb(b);
  return Math.hypot(first.r - second.r, first.g - second.g, first.b - second.b);
}

/**
 * 面の下に 1 バンド 1 行で並べる。
 * 例: `1 (0.21, 0.58)   面: 赤 茶 紫   空間: 赤 橙 茶`
 */
function valueList(
  origin: Point2,
  plane: PlaneSpec,
  observed: readonly LabColor[],
  entries: readonly [BandColor, LabColor][],
  nameOf: (color: BandColor) => string,
  planeSize: number,
): string {
  return observed
    .map((lab, index) => {
      const [x, y] = plane.at(lab);
      const onPlane = nearestNames(entries, (other) => planeDistance(plane, lab, other), nameOf);
      const inSpace = nearestNames(entries, (other) => spaceDistance(plane, lab, other), nameOf);
      const line =
        `${index + 1} (${x.toFixed(plane.digits)}, ${y.toFixed(plane.digits)})` +
        `   面: ${onPlane}   空間: ${inSpace}`;

      return text(
        {
          x: origin.x,
          y: origin.y + planeSize + AXIS_FOOTER + LIST_LINE_HEIGHT * index,
        },
        line,
        10,
        '#33333a',
        { anchor: 'start', className: 'value-list' },
      );
    })
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

  const size = colorSpacePanelSize(observed.length, options.width ?? DEFAULT_PANEL_WIDTH);
  const planeSize = size.planeSize;
  const cellHeight =
    TITLE_HEIGHT + planeSize + AXIS_FOOTER + LIST_LINE_HEIGHT * Math.max(1, observed.length);

  const parts: string[] = [
    `<rect x="${options.x}" y="${options.y}" width="${size.width}" ` +
      `height="${size.height}" fill="rgba(255,255,255,0.93)" />`,
  ];

  PLANES.forEach((plane, index) => {
    const origin: Point2 = {
      x: options.x + MARGIN + AXIS_GUTTER + (AXIS_GUTTER + planeSize + GAP) * (index % 2),
      y: options.y + MARGIN + TITLE_HEIGHT + (cellHeight + GAP) * Math.floor(index / 2),
    };

    parts.push(planeFrame(origin, plane, planeSize));
    // 基準色を先に、実測色の番号をあとに（番号を手前に出す）
    for (const [color, lab] of entries) {
      parts.push(
        coloredText(locate(origin, plane, plane.at(lab), planeSize), nameOf(color), lab, 11, 'ref-name'),
      );
    }
    observed.forEach((lab, number) => {
      parts.push(
        coloredText(
          locate(origin, plane, plane.at(lab), planeSize),
          String(number + 1),
          lab,
          14,
          'observed-number',
        ),
      );
    });
    parts.push(valueList(origin, plane, observed, entries, nameOf, planeSize));
  });

  return parts.join('');
}
