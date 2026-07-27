import type { Band } from '../types.js';
import type { OrientedBox } from '../core/locate.js';
import type { RectifyOptions } from '../core/rectify.js';
import { bandCorners, labelAnchor } from '../core/roiMapping.js';
import { BAND_COLOR_ABBR, BAND_COLOR_JA, bandColorCss } from '../core/color/colors.js';
import type { UsedRun } from '../core/value/jointDecode.js';

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
const BAND_FILL = 'rgba(255,255,255,0.30)';

/** 採用されなかったランの色。捨てた事実が見えるようにする。 */
const DROPPED_COLOR = '#8e8e93';

const CAPTION_HEIGHT = 26;

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

/** 焼き込み用の SVG を返す。 */
export function buildAnnotationSvg(input: AnnotateInput): string {
  const japanese = input.japanese ?? true;
  const nameOf = (color: Band['color']): string =>
    japanese ? BAND_COLOR_JA[color] : BAND_COLOR_ABBR[color];

  const parts: string[] = [];
  const box = input.box;

  if (box !== null) {
    const fontPx = Math.max(12, Math.round(box.thickness * 0.3));
    const usedByIndex = new Map((input.usedRuns ?? []).map((used) => [used.runIndex, used]));
    const dropped = new Set(input.droppedRuns ?? []);

    parts.push(
      `<polygon points="${points(boxCorners(box))}" fill="none" stroke="${BOX_COLOR}" ` +
        `stroke-width="${Math.max(2, Math.round(box.thickness / 16))}" />`,
    );

    input.bands.forEach((band, index) => {
      const used = usedByIndex.get(index);
      const isDropped = dropped.has(index) || (input.usedRuns !== undefined && used === undefined);
      const opacity = isDropped ? 0.5 : 1;

      // バンドの占める範囲
      parts.push(
        `<polygon points="${points(bandCorners(box, input.rectify, band))}" ` +
          `fill="${BAND_FILL}" stroke="${isDropped ? DROPPED_COLOR : bandColorCss(band.color)}" ` +
          `stroke-width="2" ${isDropped ? 'stroke-dasharray="4 3"' : ''} />`,
      );

      // ラベルは詰まるので 1 本ごとに段違いにする
      const stagger = index % 2 === 0 ? 0 : fontPx * 2.4;
      const anchor = labelAnchor(box, input.rectify, band, box.thickness * 0.5 + stagger + fontPx);

      // 色玉（金/黄・灰/銀の取り違えを目で確かめられるように）
      parts.push(
        `<circle cx="${(anchor.x - fontPx * 1.5).toFixed(1)}" cy="${anchor.y.toFixed(1)}" ` +
          `r="${(fontPx * 0.34).toFixed(1)}" fill="${bandColorCss(band.color)}" ` +
          `stroke="rgba(0,0,0,0.55)" stroke-width="1" opacity="${opacity}" />`,
      );

      // 1 行目: 色名。2 行目: カラーコード上の意味（採用されたランのみ）
      parts.push(textElement(anchor.x, anchor.y, nameOf(band.color), fontPx, '#111', opacity));
      const meaning = used === undefined ? (isDropped ? '除外' : '') : used.roleText;
      if (meaning !== '') {
        parts.push(
          textElement(
            anchor.x,
            anchor.y + fontPx * 1.15,
            meaning,
            Math.round(fontPx * 0.85),
            isDropped ? DROPPED_COLOR : '#0a4a7a',
            opacity,
          ),
        );
      }
    });
  }

  parts.push(
    `<rect x="0" y="0" width="${input.width}" height="${CAPTION_HEIGHT}" fill="rgba(0,0,0,0.66)" />`,
    `<text x="6" y="18" font-family="monospace" font-size="14" fill="#fff">` +
      `${escapeXml(input.caption)}</text>`,
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" ` +
    `height="${input.height}">${parts.join('')}</svg>`
  );
}
