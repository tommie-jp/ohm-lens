import type { Band } from '../types.js';
import type { OrientedBox } from '../core/locate.js';
import type { RectifyOptions } from '../core/rectify.js';
import { bandCorners, labelAnchor, labelSide } from '../core/roiMapping.js';
import { BAND_COLOR_ABBR, BAND_COLOR_JA, bandColorCss } from '../core/color/colors.js';
import type { UsedRun } from '../core/value/jointDecode.js';
import type { LabColor } from '../types.js';
import type { Palette } from '../core/color/palette.js';
import { buildColorSpaceSvg, colorSpacePanelSize } from './colorSpace.js';

/**
 * 検出結果を SVG として組み立てる（Node 側の焼き込み用）。
 *
 * 描画そのものは sharp の SVG 合成に任せ、ここは「何をどこに描くか」だけを
 * 決める。座標はすべて `core/roiMapping` の逆変換で元画像に戻す。
 *
 * 意味ラベル（0 / ×10 / ±5%）は**デコーダの解釈**であって正解ではない。
 * 誤読のときは間違った解釈がそのまま出る。それを見るための道具。
 */

const BOX_COLOR = '#ff3b30';

/** 採用されなかったランの色。捨てた事実が見えるようにする。 */
const DROPPED_COLOR = '#8e8e93';

const CAPTION_HEIGHT = 26;

/** 注釈の文字の大きさ。太さに比例させる。 */
function labelFontPx(box: OrientedBox): number {
  return Math.max(12, Math.round(box.thickness * 0.3));
}

/** 番号を置く距離（箱の縁から）。 */
function numberOffset(fontPx: number): number {
  return fontPx * 0.8;
}

/**
 * バンドの一覧表の寸法。
 *
 * 以前は色名と意味をバンドのすぐ脇に置いていたが、バンドが詰まると重なるので
 * 1 本ごとに段違いにする必要があり、それでも読みにくかった。写真の下に
 * 表としてまとめる方が、番号との対応も追いやすい。
 */
const TABLE = {
  /** 1 列の幅 */
  columnWidth: 58,
  /** 行の高さ */
  rowHeight: 22,
  /** 色玉の 1 辺 */
  swatch: 16,
  /** 表の外側の余白 */
  padding: 10,
  fontPx: 15,
} as const;

/** 表の行数（番号・色名・色玉・意味）。 */
const TABLE_ROWS = 4;

/** バンド一覧表の高さ [px]。バンドが無ければ 0。 */
export function tableHeightFor(bandCount: number): number {
  if (bandCount === 0) return 0;
  return TABLE.rowHeight * TABLE_ROWS + TABLE.padding * 2;
}

/** バンド一覧表の幅 [px]。 */
function tableWidthFor(bandCount: number): number {
  return TABLE.columnWidth * bandCount + TABLE.padding * 2;
}

export interface AnnotateInput {
  readonly width: number;
  readonly height: number;
  readonly box: OrientedBox | null;
  readonly bands: readonly Band[];
  readonly rectify: RectifyOptions;
  /** デコーダが採用したラン（無ければ色名のみ表示） */
  readonly usedRuns?: readonly UsedRun[];
  /** 捨てられたランの添字 */
  readonly droppedRuns?: readonly number[];
  readonly caption: string;
  /** 日本語フォントが無い環境では false にして英字にする */
  readonly japanese?: boolean;
  /**
   * 左下に色空間を描くための基準色と実測色。
   * 省略すると描かない（帯も足さない）。
   */
  readonly colorSpace?: {
    readonly palette: Palette;
    /** 検出したバンドの実測色 */
    readonly observed: readonly LabColor[];
  };
  /** 注釈のために写真の外へ広げた量（{@link labelOverflow} の結果） */
  readonly labelOverflow?: LabelOverflow;
}

/** 注釈が写真の外へどれだけはみ出すか [px]。 */
export interface LabelOverflow {
  readonly right: number;
  readonly bottom: number;
}

/**
 * 注釈（番号・色名・意味）が写真の下・右へどれだけはみ出すかを測る。
 *
 * 写真の外へ出た文字は色空間パネルに重なる。あらかじめ測っておいて、
 * その分だけキャンバスを広げてから描く。
 */
export function labelOverflow(input: AnnotateInput): LabelOverflow {
  if (input.box === null || input.bands.length === 0) return { right: 0, bottom: 0 };

  const box = input.box;
  const side = labelSide(box);
  const fontPx = labelFontPx(box);
  let maxX = 0;
  let maxY = 0;

  // 写真に重ねるのは番号だけ。色名と意味は下の表に出す
  input.bands.forEach((band) => {
    const at = labelAnchor(box, input.rectify, band, numberOffset(fontPx), side);
    maxX = Math.max(maxX, at.x + fontPx);
    maxY = Math.max(maxY, at.y + fontPx * 0.5);
  });

  return {
    right: Math.max(0, Math.ceil(maxX - input.width)),
    bottom: Math.max(0, Math.ceil(maxY - input.height)),
  };
}

/** 色空間パネルのぶん下に伸ばす高さ [px]。描かないなら 0。 */
export function panelHeightFor(
  input: Pick<AnnotateInput, 'colorSpace'>,
  availableWidth: number,
): number {
  if (input.colorSpace === undefined) return 0;
  return colorSpacePanelSize(input.colorSpace.observed.length, availableWidth).height;
}

/** 色空間パネルに必要な最小の幅 [px]（面が下限の大きさのとき）。 */
export function panelWidthFor(bandCount: number): number {
  return colorSpacePanelSize(bandCount, 0).width;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function points(list: readonly { x: number; y: number }[]): string {
  return list.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/** 検出ボックス（パディングを含まない素の寸法）の四隅。 */
function boxCorners(box: OrientedBox): { x: number; y: number }[] {
  const rad = (box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return (
    [
      [-box.length / 2, -box.thickness / 2],
      [box.length / 2, -box.thickness / 2],
      [box.length / 2, box.thickness / 2],
      [-box.length / 2, box.thickness / 2],
    ] as const
  ).map(([along, across]) => ({
    x: box.centerX + along * cos - across * sin,
    y: box.centerY + along * sin + across * cos,
  }));
}

function textElement(
  x: number,
  y: number,
  content: string,
  fontPx: number,
  fill: string,
  opacity: number,
): string {
  // 白フチ + 塗りで、どんな背景でも読めるようにする
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="sans-serif" ` +
    `font-size="${fontPx}" font-weight="700" text-anchor="middle" ` +
    `dominant-baseline="central" opacity="${opacity}" ` +
    `stroke="rgba(255,255,255,0.94)" stroke-width="${(fontPx * 0.26).toFixed(1)}" ` +
    `paint-order="stroke" fill="${fill}">${escapeXml(content)}</text>`
  );
}

/**
 * バンドの一覧表を描く。番号・色名・色玉・意味の 4 行。
 *
 * 番号は写真に焼いた番号と対応する。色玉を挟むのは、金/黄・灰/銀のような
 * 取り違えを名前だけでなく目で確かめられるようにするため。
 * 採用されなかったランは薄く描き、意味の欄に「除外」と出す。
 */
function buildBandTableSvg(
  input: AnnotateInput,
  nameOf: (color: Band['color']) => string,
  top: number,
): string {
  if (input.bands.length === 0) return '';

  const usedByIndex = new Map((input.usedRuns ?? []).map((used) => [used.runIndex, used]));
  const dropped = new Set(input.droppedRuns ?? []);
  const parts: string[] = [];

  const width = tableWidthFor(input.bands.length);
  const height = tableHeightFor(input.bands.length);
  parts.push(
    `<rect x="0.5" y="${(top + 0.5).toFixed(1)}" width="${width}" height="${height - 1}" ` +
      `fill="#ffffff" stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
  );

  const rowY = (row: number): number =>
    top + TABLE.padding + TABLE.rowHeight * row + TABLE.rowHeight * 0.72;

  input.bands.forEach((band, index) => {
    const used = usedByIndex.get(index);
    const isDropped = dropped.has(index) || (input.usedRuns !== undefined && used === undefined);
    const opacity = isDropped ? 0.45 : 1;
    const cx = TABLE.padding + TABLE.columnWidth * index + TABLE.columnWidth / 2;

    // 1 行目: 番号（写真の番号と対応）
    parts.push(textElement(cx, rowY(0), String(index + 1), TABLE.fontPx, BOX_COLOR, opacity));
    // 2 行目: 色名
    parts.push(textElement(cx, rowY(1), nameOf(band.color), TABLE.fontPx, '#111', opacity));
    // 3 行目: 色玉
    const s = TABLE.swatch;
    parts.push(
      `<rect x="${(cx - s / 2).toFixed(1)}" y="${(rowY(2) - s * 0.78).toFixed(1)}" ` +
        `width="${s}" height="${s}" fill="${bandColorCss(band.color)}" ` +
        `stroke="rgba(0,0,0,0.55)" stroke-width="1" opacity="${opacity}" />`,
    );
    // 4 行目: カラーコード上の意味
    const meaning = used === undefined ? (isDropped ? '除外' : '-') : used.roleText;
    parts.push(
      textElement(
        cx,
        rowY(3),
        meaning,
        Math.round(TABLE.fontPx * 0.9),
        isDropped ? DROPPED_COLOR : '#0a4a7a',
        opacity,
      ),
    );
  });

  return parts.join('');
}

/** 焼き込み用の SVG を返す。 */
export function buildAnnotationSvg(input: AnnotateInput): string {
  const japanese = input.japanese ?? true;
  const nameOf = (color: Band['color']): string =>
    japanese ? BAND_COLOR_JA[color] : BAND_COLOR_ABBR[color];

  const parts: string[] = [];
  const box = input.box;

  if (box !== null) {
    const fontPx = labelFontPx(box);
    const usedByIndex = new Map((input.usedRuns ?? []).map((used) => [used.runIndex, used]));
    const dropped = new Set(input.droppedRuns ?? []);
    // 注釈は水平な抵抗器なら下、垂直なら右に出す
    const side = labelSide(box);

    parts.push(
      `<polygon points="${points(boxCorners(box))}" fill="none" stroke="${BOX_COLOR}" ` +
        `stroke-width="${Math.max(2, Math.round(box.thickness / 16))}" />`,
    );

    input.bands.forEach((band, index) => {
      const used = usedByIndex.get(index);
      const isDropped = dropped.has(index) || (input.usedRuns !== undefined && used === undefined);
      const opacity = isDropped ? 0.5 : 1;

      // バンドの占める範囲（塗らない。色帯そのものを隠さないため）
      parts.push(
        `<polygon points="${points(bandCorners(box, input.rectify, band))}" ` +
          `fill="none" stroke="${isDropped ? DROPPED_COLOR : bandColorCss(band.color)}" ` +
          `stroke-width="2" ${isDropped ? 'stroke-dasharray="4 3"' : ''} />`,
      );

      // 番号はバンドのすぐ外側。色空間の面に出る番号と対応する
      const number = labelAnchor(box, input.rectify, band, numberOffset(fontPx), side);
      parts.push(
        textElement(number.x, number.y, String(index + 1), fontPx, BOX_COLOR, opacity),
      );

      // 色名と意味は写真に重ねず、下の一覧表に出す（詰まると重なって読めないため）
    });
  }

  parts.push(
    `<rect x="0" y="0" width="${input.width}" height="${CAPTION_HEIGHT}" fill="rgba(0,0,0,0.66)" />`,
    `<text x="6" y="18" font-family="monospace" font-size="14" fill="#fff">` +
      `${escapeXml(input.caption)}</text>`,
  );

  const tableTop = input.height + (input.labelOverflow?.bottom ?? 0);
  parts.push(buildBandTableSvg(input, nameOf, tableTop));

  const panelTop = tableTop + tableHeightFor(input.bands.length);
  const panelHeight = panelHeightFor(input, input.width);
  if (input.colorSpace !== undefined) {
    parts.push(
      buildColorSpaceSvg(input.colorSpace.palette, input.colorSpace.observed, {
        x: 0,
        y: panelTop,
        japanese,
        width: input.width,
      }),
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" ` +
    `height="${panelTop + panelHeight}">${parts.join('')}</svg>`
  );
}
