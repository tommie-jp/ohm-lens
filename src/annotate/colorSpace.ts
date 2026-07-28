import type { BandColor, LabColor } from '../types.js';
import { labToCss, labToRgb } from '../core/color/colorSpace.js';
import { BAND_COLOR_ABBR, BAND_COLOR_JA } from '../core/color/colors.js';
import type { Palette } from '../core/color/palette.js';

/**
 * 検出結果画像の左下に色空間を描く（デバッグ用）。
 *
 * 「この写真のバンドが基準色からどれだけ離れているか」を目で確かめるための面。
 * 誤読を追うとき、`summary.txt` の色名だけでは「惜しかったのか、まるで違うのか」
 * が分からない。基準色を赤い `+`、この写真の実測色を赤い `○` で同じ面に置けば、
 * 引き寄せられた先がひと目で分かる。
 *
 * **RGB と Lab の両方を 3 軸のまま描く。** a\*b\* 平面だけだと黒・灰・白・銀が
 * すべて原点に重なり、いちばん取り違えやすい組が見えなくなる。真の等角投影は
 * 灰色軸に沿って見るので黒と白が重なってしまうため、斜投影にしている。
 */

/** 立体の面 1 つの一辺 [px]。 */
const FACE_SIZE = 180;

/** 平面の面 1 つの一辺 [px]。 */
const PLANE_SIZE = 150;

/** 軸ラベルを置く位置（辺の長さに対する割合）。 */
const AXIS_TIP = 1.15;

/** 面の余白 [px]。 */
const MARGIN = 12;

/** 面と面の間隔 [px]。 */
const FACE_GAP = 22;

/** 見出しの高さ [px]。 */
const TITLE_HEIGHT = 16;

const MARKER_COLOR = '#ff3b30';

/**
 * Lab の a\*・b\* を 0..1 に正規化する範囲。
 * バンド色は概ねこの中に収まる。外れた値は端に張り付く。
 */
const CHROMA_MIN = -60;
const CHROMA_MAX = 80;

/** 斜投影の角度 [rad]。等角にすると灰色軸方向に潰れて黒と白が重なる。 */
const YAW = (35 * Math.PI) / 180;
const PITCH = (25 * Math.PI) / 180;

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/**
 * 投影後の面の広がり（原点からの距離 [px]）。
 * 立方体の頂点と軸ラベルの先まで含めた実寸から出す。
 */
const EXTENT = (() => {
  const points: Point2[] = [];
  for (const x of [0, 1, AXIS_TIP]) {
    for (const y of [0, 1, AXIS_TIP]) {
      for (const z of [0, 1, AXIS_TIP]) points.push(projectRaw(x, y, z));
    }
  }
  return {
    left: -Math.min(...points.map((p) => p.x)),
    right: Math.max(...points.map((p) => p.x)),
    top: -Math.min(...points.map((p) => p.y)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
})();

/** 面 1 つが占める幅と高さ [px]。 */
const FACE_WIDTH = EXTENT.left + EXTENT.right;
const FACE_HEIGHT = EXTENT.top + EXTENT.bottom;

/** 平面 1 つが占める幅と高さ（軸ラベルの余地を含む） [px]。 */
const PLANE_WIDTH = PLANE_SIZE + 26;
const PLANE_HEIGHT = PLANE_SIZE + 18;

/** 1 行が占める高さ [px]（見出し + 面のうち高いほう）。 */
const ROW_HEIGHT = TITLE_HEIGHT + Math.max(FACE_HEIGHT, PLANE_HEIGHT);

/** パネル帯の高さ [px]。RGB と Lab で 2 行。 */
export const COLOR_SPACE_PANEL_HEIGHT = Math.ceil(ROW_HEIGHT * 2 + MARGIN * 3);

/** パネル帯の幅 [px]。1 行は「立体 1 面 + 平面 2 面」。 */
export const COLOR_SPACE_PANEL_WIDTH = Math.ceil(
  FACE_WIDTH + PLANE_WIDTH * 2 + FACE_GAP * 2 + MARGIN * 2,
);

/**
 * 0..1 の 3 次元座標を面の中の 2 次元座標へ落とす。
 * 戻り値は面の原点（左下の立方体の原点）を (0, 0) とした px。
 */
function projectRaw(x: number, y: number, z: number): Point2 {
  const rotatedX = x * Math.cos(YAW) - z * Math.sin(YAW);
  const depth = x * Math.sin(YAW) + z * Math.cos(YAW);
  const rotatedY = y * Math.cos(PITCH) - depth * Math.sin(PITCH);
  // SVG は y が下向きなので符号を反転する
  return { x: rotatedX * FACE_SIZE, y: -rotatedY * FACE_SIZE };
}

export function projectToPanel(x: number, y: number, z: number): Point2 {
  return projectRaw(x, y, z);
}

export interface ColorSpaceOptions {
  /** パネル帯の左上（元画像の座標） */
  readonly x: number;
  readonly y: number;
  /** 日本語フォントが無い環境では false */
  readonly japanese?: boolean;
}

/** 立方体の 12 辺（頂点は 0/1 の組み合わせ）。 */
const CUBE_EDGES: readonly (readonly [readonly number[], readonly number[]])[] = (() => {
  const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])));
  const edges: [readonly number[], readonly number[]][] = [];
  for (const from of corners) {
    for (const to of corners) {
      const diff = from.reduce((sum, value, i) => sum + Math.abs(value - (to[i] as number)), 0);
      // 1 軸だけ違う組が辺。順序を固定して重複を除く
      if (diff === 1 && from.join() < to.join()) edges.push([from, to]);
    }
  }
  return edges;
})();

/** 面の中の座標を、元画像の座標へ移す。 */
function place(origin: Point2, point: Point2): Point2 {
  return { x: origin.x + point.x, y: origin.y + point.y };
}

function line(from: Point2, to: Point2, stroke: string, width: number, opacity = 1): string {
  return (
    `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" ` +
    `x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" ` +
    `stroke="${stroke}" stroke-width="${width}" opacity="${opacity}" />`
  );
}

function label(
  at: Point2,
  text: string,
  size: number,
  fill: string,
  halo = false,
  anchor: 'middle' | 'start' = 'middle',
): string {
  // 印の上に重なっても読めるよう、必要なら白フチを付ける
  const stroke = halo
    ? `stroke="rgba(255,255,255,0.9)" stroke-width="${(size * 0.4).toFixed(1)}" paint-order="stroke" `
    : '';
  return (
    `<text x="${at.x.toFixed(1)}" y="${at.y.toFixed(1)}" font-family="sans-serif" ` +
    `font-size="${size}" fill="${fill}" text-anchor="${anchor}" ` +
    `${stroke}dominant-baseline="central">${text}</text>`
  );
}

/** 立方体の枠と 3 本の軸ラベルを描く。 */
function frame(origin: Point2, axes: readonly [string, string, string]): string {
  const parts = CUBE_EDGES.map(([from, to]) =>
    line(
      place(origin, projectToPanel(from[0] as number, from[1] as number, from[2] as number)),
      place(origin, projectToPanel(to[0] as number, to[1] as number, to[2] as number)),
      '#b0b0b8',
      1,
      0.9,
    ),
  );

  const tips: [number, number, number][] = [
    [AXIS_TIP, 0, 0],
    [0, AXIS_TIP, 0],
    [0, 0, AXIS_TIP],
  ];
  tips.forEach(([x, y, z], index) => {
    parts.push(
      label(
        place(origin, projectToPanel(x, y, z)),
        axes[index] as string,
        11,
        '#6b6b73',
      ),
    );
  });
  return parts.join('');
}

/** 基準色の印（赤い +）。色玉と色名を添えて、どれがどの色か分かるようにする。 */
function referenceMark(at: Point2, css: string, name: string): string {
  const arm = 4;
  return (
    `<circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="4.5" fill="${css}" ` +
    `stroke="rgba(0,0,0,0.45)" stroke-width="0.8" />` +
    `<line class="ref-plus" x1="${(at.x - arm).toFixed(1)}" y1="${at.y.toFixed(1)}" ` +
    `x2="${(at.x + arm).toFixed(1)}" y2="${at.y.toFixed(1)}" ` +
    `stroke="${MARKER_COLOR}" stroke-width="1.4" />` +
    `<line x1="${at.x.toFixed(1)}" y1="${(at.y - arm).toFixed(1)}" ` +
    `x2="${at.x.toFixed(1)}" y2="${(at.y + arm).toFixed(1)}" ` +
    `stroke="${MARKER_COLOR}" stroke-width="1.4" />` +
    label({ x: at.x, y: at.y - 10 }, name, 9, '#33333a', true)
  );
}

/**
 * 2 次元の面（平面図）を描く。
 *
 * 立体図は全体の散らばりを掴むのに向くが、重なった点の前後関係が読めない。
 * 指定の 2 軸だけを見る平面図を並べると、どの成分で近いのかがはっきりする。
 * 軸は**先に書いたほうが横**（`B-R` なら横が B、縦が R）。
 */
function planeFace(
  origin: Point2,
  title: string,
  axes: readonly [string, string],
  points: readonly { readonly at: Point2; readonly draw: (at: Point2) => string }[],
): string {
  const parts: string[] = [
    label({ x: origin.x + PLANE_SIZE / 2, y: origin.y - 8 }, title, 11, '#33333a'),
    `<rect x="${origin.x}" y="${origin.y}" width="${PLANE_SIZE}" height="${PLANE_SIZE}" ` +
      `fill="none" stroke="#b0b0b8" stroke-width="1" />`,
    label({ x: origin.x + PLANE_SIZE / 2, y: origin.y + PLANE_SIZE + 9 }, axes[0], 10, '#6b6b73'),
    label({ x: origin.x - 12, y: origin.y + PLANE_SIZE / 2 }, axes[1], 10, '#6b6b73'),
  ];
  for (const point of points) parts.push(point.draw(point.at));
  return parts.join('');
}

/** 0..1 の (横, 縦) を平面の中の座標へ。縦は上向きにする。 */
function onPlane(origin: Point2, horizontal: number, vertical: number): Point2 {
  return {
    x: origin.x + clamp01(horizontal) * PLANE_SIZE,
    y: origin.y + (1 - clamp01(vertical)) * PLANE_SIZE,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 実測色の印（赤い ○）。中は実測色で塗る。 */
function observedMark(at: Point2, css: string): string {
  return (
    `<circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="5.5" fill="${css}" ` +
    `opacity="0.85" />` +
    `<circle class="observed-ring" cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="5.5" ` +
    `fill="none" stroke="${MARKER_COLOR}" stroke-width="1.8" />`
  );
}

function normalizeChroma(value: number): number {
  return (value - CHROMA_MIN) / (CHROMA_MAX - CHROMA_MIN);
}

/** Lab を Lab 面の 0..1 座標へ。縦軸が L\*。 */
function labCoords(lab: LabColor): [number, number, number] {
  return [normalizeChroma(lab.a), lab.l / 100, normalizeChroma(lab.b)];
}

/** Lab を RGB 面の 0..1 座標へ（色域外はクランプ済み）。 */
function rgbCoords(lab: LabColor): [number, number, number] {
  const { r, g, b } = labToRgb(lab);
  return [r, g, b];
}

/**
 * 色空間パネルの SVG を返す。
 *
 * @param palette 基準色（赤い + で置く）
 * @param observed この写真で検出したバンドの実測色（赤い ○ で置く）
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

  /** 1 行ぶん（立体 1 面 + 平面 2 面）を描く。 */
  const row = (
    index: number,
    title: string,
    coords: (lab: LabColor) => [number, number, number],
    solidAxes: readonly [string, string, string],
    planes: readonly {
      readonly title: string;
      readonly axes: readonly [string, string];
      /** 3 成分から (横, 縦) を選ぶ */
      readonly pick: (c: [number, number, number]) => [number, number];
    }[],
  ): void => {
    const top = options.y + MARGIN + (ROW_HEIGHT + MARGIN) * index;
    // 見出しは行の左端に置く（立体の軸ラベルと重ならないように）
    parts.push(
      label({ x: options.x + 6, y: top + 8 }, title, 12, '#33333a', false, 'start'),
    );

    const solidOrigin: Point2 = {
      x: options.x + MARGIN + EXTENT.left,
      y: top + TITLE_HEIGHT + EXTENT.top,
    };
    parts.push(frame(solidOrigin, solidAxes));
    for (const [color, lab] of entries) {
      const [x, y, z] = coords(lab);
      parts.push(
        referenceMark(place(solidOrigin, projectToPanel(x, y, z)), labToCss(lab), nameOf(color)),
      );
    }
    for (const lab of observed) {
      const [x, y, z] = coords(lab);
      parts.push(observedMark(place(solidOrigin, projectToPanel(x, y, z)), labToCss(lab)));
    }

    planes.forEach((plane, column) => {
      const origin: Point2 = {
        x: options.x + MARGIN + FACE_WIDTH + FACE_GAP + (PLANE_WIDTH + FACE_GAP) * column + 14,
        y: top + TITLE_HEIGHT + 4,
      };
      const marks = [
        ...entries.map(([color, lab]) => {
          const [h, v] = plane.pick(coords(lab));
          return {
            at: onPlane(origin, h, v),
            draw: (at: Point2) => referenceMark(at, labToCss(lab), nameOf(color)),
          };
        }),
        ...observed.map((lab) => {
          const [h, v] = plane.pick(coords(lab));
          return { at: onPlane(origin, h, v), draw: (at: Point2) => observedMark(at, labToCss(lab)) };
        }),
      ];
      parts.push(planeFace(origin, plane.title, plane.axes, marks));
    });
  };

  row(0, 'RGB', rgbCoords, ['R', 'G', 'B'], [
    { title: 'B-R', axes: ['B', 'R'], pick: ([r, , b]) => [b, r] },
    { title: 'G-B', axes: ['G', 'B'], pick: ([, g, b]) => [g, b] },
  ]);
  row(1, 'CIE L*a*b*', labCoords, ['a*', 'L*', 'b*'], [
    { title: 'b*-a*', axes: ['b*', 'a*'], pick: ([a, , b]) => [b, a] },
    { title: 'b*-L*', axes: ['b*', 'L*'], pick: ([, l, b]) => [b, l] },
  ]);

  return parts.join('');
}
