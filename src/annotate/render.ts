import type { Band, ProfileSample } from '../types.js';
import type { OrientedBox } from '../core/locate.js';
import type { RectifyOptions } from '../core/rectify.js';
import { bandCorners, labelAnchor, labelSide } from '../core/roiMapping.js';
import { BAND_COLOR_ABBR, BAND_COLOR_JA, bandColorCss } from '../core/color/colors.js';
import { decodedOhmsFor, roleTextsFor, type UsedRun } from '../core/value/jointDecode.js';
import { formatOhms } from '../core/format.js';
import type { LabColor } from '../types.js';
import type { Palette } from '../core/color/palette.js';
import type { BandInterval } from '../core/bands/boundaries.js';
import { buildColorSpaceSvg, colorSpacePanelSize } from './colorSpace.js';
import {
  CHART,
  SERIES_COLOR,
  absoluteSum,
  buildChartSvg,
  buildRoiStripSvg,
  chartBlockHeight,
  differentiate,
  LABEL_COLOR,
  sectionTitleSvg,
  stripBlockHeight,
  type StripData,
  type ChartSeries,
} from './profileChart.js';

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

/**
 * キャプション帯の 1 行の高さ [px]。
 *
 * 以前は写真の上に半透明の黒で重ねていたが、上端に写った抵抗器やバンドが
 * 隠れた。写真の外に帯を作り、独立した文字列として出す。
 * 写真は帯の高さだけ下にずらして描く。
 */
export const CAPTION_LINE_HEIGHT = 26;

const CAPTION_FONT_PX = 14;

/** 帯の左右の余白 [px]。 */
const CAPTION_PADDING = 6;

/**
 * 等幅フォントでの文字幅 [px]。全角は 2 文字ぶんとして数える。
 * キャプションには「期待 82kΩ」のような日本語が混ざる。
 */
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 0x2000 ? 2 : 1;
  return units;
}

/**
 * キャプションを帯の幅に合わせて折り返す。
 *
 * 切り詰めると期待値や確信度が読めなくなるので、行を足して全文を見せる。
 * 単語の途中で折れないよう空白で分け、1 語が長すぎるときだけ強制的に折る。
 */
export function captionLines(caption: string, width: number): string[] {
  const perLine = Math.max(8, Math.floor((width - CAPTION_PADDING * 2) / (CAPTION_FONT_PX * 0.62)));
  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = '';
  };

  for (const word of caption.split(' ')) {
    let piece = word;
    // 1 語で 1 行に収まらないときは、収まる長さで切って次の行へ送る
    while (textUnits(piece) > perLine) {
      flush();
      let head = '';
      for (const ch of piece) {
        if (textUnits(head + ch) > perLine) break;
        head += ch;
      }
      lines.push(head);
      piece = piece.slice(head.length);
    }
    if (piece.length === 0) continue;
    const candidate = current.length === 0 ? piece : `${current} ${piece}`;
    if (textUnits(candidate) > perLine) {
      flush();
      current = piece;
    } else {
      current = candidate;
    }
  }
  flush();

  return lines.length === 0 ? [''] : lines;
}

/** キャプション帯の高さ [px]。折り返した行数ぶん高くなる。 */
export function captionHeightFor(caption: string, width: number): number {
  return captionLines(caption, width).length * CAPTION_LINE_HEIGHT;
}

/** 段の見出しの文言（日本語フォントが無い環境では英字にする）。 */
const SECTION_TITLES = {
  table: { ja: 'カラーコード読み取り値', en: 'Color code reading' },
  expected: { ja: 'カラーコード期待値', en: 'Color code expected' },
  strip: { ja: '水平化・色補正 ROI', en: 'Rectified ROI' },
  lab: { ja: 'Labグラフ', en: 'Lab chart' },
  abs: { ja: 'absグラフ', en: 'abs chart' },
  derivative: { ja: 'Lab微分グラフ２', en: 'Lab derivative 2' },
} as const;

/** abs の定義。グラフの見出しの脇に出して、何を描いているかを明示する。 */
const ABS_FORMULA = 'abs = |dL*/dx| + |da*/dx| + |db*/dx|';

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

/** 期待値の表の行数（番号・色名・色玉・区間）。 */
const EXPECTED_ROWS = 4;

/**
 * 期待値の表の高さ [px]（見出しを含む）。正解データが無ければ 0。
 *
 * 人手で確定した境界（`boundaries.json` の `verified: true`）だけを出す。
 * 種（推定値）を並べても検出そのものを写しているだけで、見比べる意味がない。
 */
export function expectedTableHeightFor(labels: readonly BandInterval[] | undefined): number {
  if (labels === undefined || labels.length === 0) return 0;
  return CHART.titleHeight + TABLE.rowHeight * EXPECTED_ROWS + TABLE.padding * 2;
}

/** バンド一覧表の高さ [px]（見出しを含む）。バンドが無ければ 0。 */
export function tableHeightFor(bandCount: number): number {
  if (bandCount === 0) return 0;
  return CHART.titleHeight + TABLE.rowHeight * TABLE_ROWS + TABLE.padding * 2;
}

/** バンド一覧表の幅 [px]。 */
function tableWidthFor(bandCount: number): number {
  return TABLE.columnWidth * bandCount + TABLE.padding * 2;
}

/**
 * 表とグラフの帯の高さ [px]。
 *
 * グラフは表の右ではなく下に、幅いっぱいの段として積む。表の右に置くと
 * 写真が細いときにグラフまで細くなり、ラン境界が潰れて読めなかった。
 *
 * 段は 表 → ROI ストリップ → Lab グラフ → abs グラフ → Lab 微分グラフ２ の順。
 * ROI ストリップを Lab グラフの真上に置くのは、**X 軸を共有させる**ため
 * （`plotGeometry`）。グラフの 0% / 100% の破線が画像上の本体の端に重なる。
 */
export function blockHeightFor(
  input: Pick<AnnotateInput, 'bands' | 'profile' | 'strip' | 'labels'>,
): number {
  const table = tableHeightFor(input.bands.length) + expectedTableHeightFor(input.labels);
  const hasProfile = input.profile !== undefined && input.profile.samples.length > 0;
  if (!hasProfile) return table;
  return table + (input.strip === undefined ? 0 : stripBlockHeight()) + chartBlockHeight() * 3;
}

export interface AnnotateInput {
  readonly width: number;
  readonly height: number;
  readonly box: OrientedBox | null;
  readonly bands: readonly Band[];
  readonly rectify: RectifyOptions;
  /** デコーダが採用したラン（無ければ色名のみ表示） */
  readonly usedRuns?: readonly UsedRun[];
  /**
   * 読み取った抵抗値 [Ω]。読み取り値の表の見出しに添える。
   * `null` は「読取不可」、省略すると見出しに何も添えない。
   */
  readonly readingOhms?: number | null;
  /** 読み取り値を値として出してよいか。false なら見出しに「(保留)」を付ける */
  readonly readingConfident?: boolean;
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
  /**
   * 中心線の 1D プロファイル（色順応補正後）。ラン分割が実際に食べている値。
   * 省略するとグラフを描かない。
   */
  readonly profile?: {
    readonly samples: readonly ProfileSample[];
    /** 本体と判定された範囲。特定できなければ null */
    readonly extent: { readonly start: number; readonly end: number } | null;
    /** バンド候補のランの境界（縦線で重ねる） */
    readonly runs: readonly { readonly start: number; readonly end: number }[];
  };
  /**
   * 水平化・色補正した ROI。Lab グラフの真上に、X 軸を揃えて描く。
   * 省略すると描かない（帯も足さない）。
   */
  readonly strip?: StripData;
  /**
   * 人手で確定した境界の区間 [%]。あれば Lab グラフに重ねる。
   * 検出のラン境界と並べて見るためのもので、解析には使わない。
   */
  readonly labels?: readonly BandInterval[];
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
 * 読み取り値の表の見出しに添える抵抗値。
 *
 * 色名と意味の並びだけでは「結局いくつなのか」がすぐに読めない。
 * 確信度が足りないものは実機では出ない値なので「(保留)」と断る。
 * 値を渡されていなければ何も添えない（`undefined`）。
 */
function readingNote(
  input: Pick<AnnotateInput, 'readingOhms' | 'readingConfident'>,
): string | undefined {
  if (input.readingOhms === undefined) return undefined;
  if (input.readingOhms === null) return '読取不可';
  return `${formatOhms(input.readingOhms)}${input.readingConfident === false ? '(保留)' : ''}`;
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
  title: string,
  top: number,
): string {
  if (input.bands.length === 0) return '';

  const usedByIndex = new Map((input.usedRuns ?? []).map((used) => [used.runIndex, used]));
  const dropped = new Set(input.droppedRuns ?? []);
  const parts: string[] = [sectionTitleSvg(0, top, title, readingNote(input))];

  const frameTop = top + CHART.titleHeight;
  const width = tableWidthFor(input.bands.length);
  const height = tableHeightFor(input.bands.length) - CHART.titleHeight;
  parts.push(
    `<rect x="0.5" y="${(frameTop + 0.5).toFixed(1)}" width="${width}" height="${height - 1}" ` +
      `fill="#ffffff" stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
  );

  const rowY = (row: number): number =>
    frameTop + TABLE.padding + TABLE.rowHeight * row + TABLE.rowHeight * 0.72;

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

/**
 * カラーコードの**期待値**の表。読み取り値の表と同じ体裁で真下に置く。
 *
 * 出すのは人手で確定した境界（`boundaries.json` の `verified: true`）だけ。
 * 番号は読み取り値の表とは独立で、**期待値の並び順**（左から右）。
 *
 * 4 行目は読み取り値の表と同じ**カラーコード上の意味**。色列は画像上の並びで
 * 読み取り方向を持たないので、`roleTextsFor` がデコードの成否で向きを決める。
 *
 * 見出しには**その色列が表す抵抗値**を添える（`decodedOhmsFor`）。MANIFEST の
 * 期待値ではなく色列から復号した値なので、食い違えばラベル自体の誤りが分かる。
 */
function buildExpectedTableSvg(
  labels: readonly BandInterval[],
  nameOf: (color: Band['color']) => string,
  title: string,
  top: number,
): string {
  if (labels.length === 0) return '';

  const ohms = decodedOhmsFor(labels.map((label) => label.color));
  const parts: string[] = [
    sectionTitleSvg(0, top, title, ohms === null ? '?' : formatOhms(ohms)),
  ];
  const frameTop = top + CHART.titleHeight;
  const width = tableWidthFor(labels.length);
  const height = expectedTableHeightFor(labels) - CHART.titleHeight;
  parts.push(
    `<rect x="0.5" y="${(frameTop + 0.5).toFixed(1)}" width="${width}" height="${height - 1}" ` +
      `fill="#ffffff" stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
  );

  const rowY = (row: number): number =>
    frameTop + TABLE.padding + TABLE.rowHeight * row + TABLE.rowHeight * 0.72;
  const roleTexts = roleTextsFor(labels.map((label) => label.color));

  labels.forEach((label, index) => {
    const cx = TABLE.padding + TABLE.columnWidth * index + TABLE.columnWidth / 2;

    // 1 行目: 番号（期待値の並び順）
    parts.push(textElement(cx, rowY(0), String(index + 1), TABLE.fontPx, LABEL_COLOR, 1));
    // 2 行目: 色名。色が分かっていないものは「?」
    parts.push(
      textElement(
        cx,
        rowY(1),
        label.color === null ? '?' : nameOf(label.color),
        TABLE.fontPx,
        '#111',
        1,
      ),
    );
    // 3 行目: 色玉
    const s = TABLE.swatch;
    parts.push(
      `<rect x="${(cx - s / 2).toFixed(1)}" y="${(rowY(2) - s * 0.78).toFixed(1)}" ` +
        `width="${s}" height="${s}" ` +
        `fill="${label.color === null ? '#ffffff' : bandColorCss(label.color)}" ` +
        `stroke="rgba(0,0,0,0.55)" stroke-width="1" />`,
    );
    // 4 行目: カラーコード上の意味（読み取り値の表と同じ）
    parts.push(
      textElement(
        cx,
        rowY(3),
        roleTexts[index] ?? '?',
        Math.round(TABLE.fontPx * 0.9),
        LABEL_COLOR,
        1,
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

  // 写真に重ねる注釈。キャプション帯のぶん下へずらすので、まとめて 1 つの群にする
  const onPhoto: string[] = [];
  const parts: string[] = [];
  const box = input.box;

  if (box !== null) {
    const fontPx = labelFontPx(box);
    const usedByIndex = new Map((input.usedRuns ?? []).map((used) => [used.runIndex, used]));
    const dropped = new Set(input.droppedRuns ?? []);
    // 注釈は水平な抵抗器なら下、垂直なら右に出す
    const side = labelSide(box);

    onPhoto.push(
      `<polygon points="${points(boxCorners(box))}" fill="none" stroke="${BOX_COLOR}" ` +
        `stroke-width="${Math.max(2, Math.round(box.thickness / 16))}" />`,
    );

    input.bands.forEach((band, index) => {
      const used = usedByIndex.get(index);
      const isDropped = dropped.has(index) || (input.usedRuns !== undefined && used === undefined);
      const opacity = isDropped ? 0.5 : 1;

      // バンドの占める範囲（塗らない。色帯そのものを隠さないため）
      onPhoto.push(
        `<polygon points="${points(bandCorners(box, input.rectify, band))}" ` +
          `fill="none" stroke="${isDropped ? DROPPED_COLOR : bandColorCss(band.color)}" ` +
          `stroke-width="2" ${isDropped ? 'stroke-dasharray="4 3"' : ''} />`,
      );

      // 番号はバンドのすぐ外側。色空間の面に出る番号と対応する
      const number = labelAnchor(box, input.rectify, band, numberOffset(fontPx), side);
      onPhoto.push(textElement(number.x, number.y, String(index + 1), fontPx, BOX_COLOR, opacity));

      // 色名と意味は写真に重ねず、下の一覧表に出す（詰まると重なって読めないため）
    });
  }

  const lines = captionLines(input.caption, input.width);
  const captionHeight = lines.length * CAPTION_LINE_HEIGHT;

  // 写真の注釈は帯のぶん下へ。写真そのものは合成側で同じだけ下に置く
  parts.push(`<g transform="translate(0,${captionHeight})">${onPhoto.join('')}</g>`);

  // キャプションは写真に重ねず、上の帯に独立した文字列として置く。
  // 幅に収まらなければ折り返す（切り詰めると期待値や確信度が読めなくなる）
  parts.push(
    `<rect x="0" y="0" width="${input.width}" height="${captionHeight}" fill="#f2f2f2" ` +
      `stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
  );
  lines.forEach((line, index) => {
    const y = index * CAPTION_LINE_HEIGHT + CAPTION_LINE_HEIGHT / 2;
    parts.push(
      `<text x="${CAPTION_PADDING}" y="${y.toFixed(1)}" font-family="monospace" ` +
        `font-size="${CAPTION_FONT_PX}" fill="#111" dominant-baseline="central">` +
        `${escapeXml(line)}</text>`,
    );
  });

  const pick = (title: { ja: string; en: string }): string => (japanese ? title.ja : title.en);
  const tableTop = captionHeight + input.height + (input.labelOverflow?.bottom ?? 0);
  parts.push(buildBandTableSvg(input, nameOf, pick(SECTION_TITLES.table), tableTop));

  // 期待値の表は読み取り値の表の真下（人手で確定した境界があるときだけ）
  const expectedTop = tableTop + tableHeightFor(input.bands.length);
  if (input.labels !== undefined && input.labels.length > 0) {
    parts.push(
      buildExpectedTableSvg(input.labels, nameOf, pick(SECTION_TITLES.expected), expectedTop),
    );
  }

  // グラフは表の下に、幅いっぱいの段として積む。X 軸は抵抗器の長さ方向なので
  // ラン境界が写真・表の番号と対応する
  const profile = input.profile;
  if (profile !== undefined && profile.samples.length > 0) {
    const samples = profile.samples;
    const derived = differentiate(samples);
    /** L* は左軸、a* と b* は右軸（値域が桁違いなので分ける）。 */
    const labSeries = (source: readonly ProfileSample[]): ChartSeries[] => [
      {
        label: 'L*',
        color: SERIES_COLOR.l,
        axis: 'left',
        values: source.map((s) => s.lab.l),
      },
      {
        label: 'a*',
        color: SERIES_COLOR.a,
        axis: 'right',
        values: source.map((s) => s.lab.a),
      },
      {
        label: 'b*',
        color: SERIES_COLOR.b,
        axis: 'right',
        values: source.map((s) => s.lab.b),
      },
    ];
    const data = {
      count: samples.length,
      extent: profile.extent,
      runs: profile.runs,
      dropped: new Set(input.droppedRuns ?? []),
      roiPadding: input.rectify.padding ?? 0,
      ...(input.labels === undefined ? {} : { labels: input.labels }),
    };
    const stripTop = expectedTop + expectedTableHeightFor(input.labels);
    const stripHeight = input.strip === undefined ? 0 : stripBlockHeight();
    if (input.strip !== undefined) {
      // 水平化・色補正した ROI。Lab グラフと X 軸を共有するので、グラフの
      // 0% / 100% の破線がそのまま画像上の本体の端になる
      parts.push(
        buildRoiStripSvg(
          input.strip,
          { left: 0, top: stripTop, width: input.width },
          { title: pick(SECTION_TITLES.strip) },
        ),
      );
    }

    const labTop = stripTop + stripHeight;
    const absTop = labTop + chartBlockHeight();
    parts.push(
      buildChartSvg(
        { ...data, series: labSeries(samples) },
        { left: 0, top: labTop, width: input.width },
        { title: pick(SECTION_TITLES.lab), showRunNumbers: true },
      ),
      // abs は 3 成分の絶対値の和。明度だけ・色みだけが動く境界のどちらも
      // 1 本で拾えるので、バンドの縁の強さをまとめて見るのに使う。
      // Lab 微分と重ねると値域が違って潰れるので、別のプレーンに分ける
      buildChartSvg(
        {
          ...data,
          series: [
            {
              label: 'abs',
              color: SERIES_COLOR.abs,
              axis: 'left' as const,
              values: absoluteSum(samples),
            },
          ],
        },
        { left: 0, top: absTop, width: input.width },
        { title: pick(SECTION_TITLES.abs), showRunNumbers: false, subtitle: ABS_FORMULA },
      ),
      // 微分は段差の位置に山が立つ。ラン境界が値のどの変化に対応するかを見る
      buildChartSvg(
        { ...data, series: labSeries(derived) },
        { left: 0, top: absTop + chartBlockHeight(), width: input.width },
        { title: pick(SECTION_TITLES.derivative), showRunNumbers: false },
      ),
    );
  }

  const panelTop = tableTop + blockHeightFor(input);
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
