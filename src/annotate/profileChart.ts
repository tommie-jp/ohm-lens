import type { ProfileSample } from '../types.js';
import { fractionAtPercent } from '../core/bands/boundaries.js';

/**
 * 中心線プロファイルのグラフ。
 *
 * ラン分割が実際に食べている値（色順応補正後の L*a*b*）をそのまま描く。
 * 「なぜこの本数になったか」を目で追うためのもの。
 *
 * 同じ描画を Lab そのものと、その微分の 2 枚に使う。微分は段差の位置に山が
 * 立つので、ラン境界が値のどの変化に対応しているかが読める。
 */

/** グラフ 1 枚の寸法。 */
export const CHART = {
  height: 176,
  /** 見出しの帯の高さ */
  titleHeight: 20,
  /** 目盛りラベルのぶん左右に空ける（左が L*、右が a* と b*） */
  axisWidth: 40,
  padding: 10,
  fontPx: 11,
  /** X 軸のラベルの大きさ。5% 刻みで並べるので本文より小さくする */
  xTickFontPx: 9,
  titleFontPx: 13,
  /** X 軸のラベル（% 表示）の高さ */
  xLabelHeight: 15,
  /** 凡例の高さ */
  legendHeight: 17,
  /**
   * 値域をプロット高のどこに収めるか。
   * 最大値を高さの 90%、最小値を 10% の位置に置き、上下に余白を残す。
   */
  topFraction: 0.1,
  bottomFraction: 0.9,
  /** これより細いと目盛りと折れ線が潰れるので描かない */
  minPlotWidth: 80,
  /** 格子の色（10% 刻み。実線で濃く） */
  gridColor: 'rgba(0,0,0,0.16)',
  /** 5% 刻みの格子の色（点線で薄く） */
  minorGridColor: 'rgba(0,0,0,0.07)',
  /** 5% 刻みの格子の破線 */
  minorGridDash: '2 3',
  /**
   * Y 軸のラベルを何 % 刻みで出すか。
   *
   * 格子は 5% 刻みで引くが、ラベルまで 5% ごとに出すと潰れる。値域を写す
   * プロット高は 100px 前後なので 10% 刻みでも 10px 間隔で、11px の文字が
   * 重なる。従来と同じ 5 本（20% 刻み）に留める。
   */
  labelStepPercent: 20,
} as const;

/** 格子の刻み [%]。10% は実線で濃く、5% は点線で薄く引く。 */
const GRID_STEP_PERCENT = 5;
const MAJOR_GRID_PERCENT = 10;

/** 単位（%）を添えるラベルの刻み [%]。 */
const LABELLED_UNIT_PERCENT = 25;

/** L* / a* / b* の線の色。a* は赤緑軸、b* は青黄軸なのでそれに寄せる。 */
export const SERIES_COLOR = {
  l: '#444444',
  a: '#d0021b',
  b: '#1f6fb2',
  /** 微分の絶対値の和。3 色のどれとも紛れない色にする */
  abs: '#8e44ad',
} as const;

/** ラン番号の色（写真・表と同じ赤）。 */
const RUN_NUMBER_COLOR = '#ff3b30';

/** 正解の境界の色。検出のラン境界（赤）と見分ける。 */
export const LABEL_COLOR = '#1a9850';

/**
 * X 軸のラベルの刻み [%]。
 *
 * 格子と同じ 5% 刻みで出す。プロット幅 700px に -25%〜125% の 31 本が乗るので
 * 間隔は約 22px。11px の文字では「-25%」が収まらないので、X 軸のラベルだけ
 * {@link CHART.xTickFontPx} に落とす。
 */
const PERCENT_STEP = 5;

/**
 * ROI ストリップ（水平化・色補正した画像）の寸法。
 * グラフの真上に置き、X 軸を共有する。
 */
export const STRIP = {
  /** 画像の高さ [px] */
  height: 44,
  /** 走査線を描く点線の書式 */
  scanDash: '3 3',
} as const;

/**
 * 折れ線を描く領域の X 範囲。
 *
 * **ROI ストリップとグラフでこれを共有する。** 別々に計算すると、画像と
 * X 軸（%）の対応がずれて「グラフの 50% が画像のどこか」が読めなくなる。
 * 収まらない幅のときは null。
 */
export function plotGeometry(
  layout: ChartLayout,
): { readonly left: number; readonly width: number } | null {
  const frameWidth = layout.width - CHART.padding * 2;
  const width = frameWidth - CHART.axisWidth * 2;
  if (width < CHART.minPlotWidth) return null;
  return { left: layout.left + CHART.padding + CHART.axisWidth, width };
}

/** ROI ストリップ 1 枚が縦に占める高さ [px]（見出しと X 軸ラベルを含む）。 */
export function stripBlockHeight(): number {
  return CHART.titleHeight + STRIP.height + CHART.xLabelHeight + CHART.padding;
}

/** グラフ 1 枚が縦に占める高さ [px]（見出しを含む）。 */
export function chartBlockHeight(): number {
  return CHART.titleHeight + CHART.height;
}

/** 折れ線を描く領域の高さ [px]。 */
export function chartPlotHeight(): number {
  return CHART.height - CHART.padding * 2 - CHART.xLabelHeight - CHART.legendHeight;
}

/**
 * 中心線プロファイルを微分する（中心差分）。
 *
 * 端は片側差分では傾きが 2 倍になって山が立ってしまうので、隣との差を
 * そのまま使う。x はもとのサンプルの位置を保つ（ラン境界と重ねるため）。
 *
 * サンプルが 1 点以下なら微分は定義できないので空を返す。
 */
export function differentiate(samples: readonly ProfileSample[]): ProfileSample[] {
  if (samples.length < 2) return [];

  const at = (index: number): ProfileSample =>
    samples[Math.min(samples.length - 1, Math.max(0, index))] as ProfileSample;

  return samples.map((sample, index) => {
    const prev = at(index - 1);
    const next = at(index + 1);
    // 端は片側だけなので幅が 1、内側は中心差分なので幅が 2
    const span = Math.max(1, Math.min(samples.length - 1, index + 1) - Math.max(0, index - 1));
    return {
      x: sample.x,
      lab: {
        l: (next.lab.l - prev.lab.l) / span,
        a: (next.lab.a - prev.lab.a) / span,
        b: (next.lab.b - prev.lab.b) / span,
      },
    };
  });
}

/**
 * 微分の絶対値の和 abs = |dL/dx| + |da/dx| + |db/dx|。
 *
 * 明度だけ・色みだけが動く境界のどちらも 1 本で拾えるので、バンドの縁の
 * 強さをまとめて見るのに使う。符号が打ち消し合わないよう絶対値で足す。
 */
export function absoluteSum(samples: readonly ProfileSample[]): number[] {
  return differentiate(samples).map(
    (sample) => Math.abs(sample.lab.l) + Math.abs(sample.lab.a) + Math.abs(sample.lab.b),
  );
}

/**
 * X 軸に出す目盛りの値 [%]。ROI に映っている範囲だけを 5% 刻みで返す。
 *
 * **格子とラベルで同じ列を使う**（ずれると読めない）。10% の倍数は実線で濃く、
 * その間は破線で薄く引き、ラベルの色も同じ濃さに揃える。
 */
export function percentTickValues(padding: number): number[] {
  const min = -padding * 100;
  const max = 100 + padding * 100;
  const values: number[] = [];
  const first = Math.ceil(min / PERCENT_STEP) * PERCENT_STEP;
  // -0 を混ぜない（ラベルが「-0%」になる）
  for (let value = first; value <= max + 1e-9; value += PERCENT_STEP)
    values.push(value === 0 ? 0 : value);
  return values;
}

/**
 * X 軸のラベルの文字。
 *
 * 5% 刻みで並べると間隔は約 22px しかない。「-25%」は 4 文字で入らないので、
 * **単位は 25% の倍数にだけ付ける**（その位置は左右 112px 空いている）。
 * 残りは数字だけにすると 3 文字に収まり、隣と重ならない。
 */
export function formatPercentTick(percent: number): string {
  return percent % LABELLED_UNIT_PERCENT === 0 ? `${percent}%` : `${percent}`;
}

/** 1 本の折れ線。左右どちらの軸に乗せるかを持つ。 */
export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly axis: 'left' | 'right';
  readonly values: readonly number[];
}

export interface ChartData {
  readonly series: readonly ChartSeries[];
  /** サンプル数（X 軸の目盛りと折れ線で共有する） */
  readonly count: number;
  /** 本体と判定された範囲。特定できなければ null */
  readonly extent: { readonly start: number; readonly end: number } | null;
  /** バンド候補のランの境界（縦線で重ねる） */
  readonly runs: readonly { readonly start: number; readonly end: number }[];
  /** 捨てられたランの添字 */
  readonly dropped: ReadonlySet<number>;
  /** ROI が本体の外側に取っている余白の割合（X 軸を % にするため） */
  readonly roiPadding: number;
  /** 人手の正解区間 [%]。あればプロットの下端に重ねる */
  readonly labels?: readonly { readonly start: number; readonly end: number }[];
}

export interface ChartLayout {
  readonly left: number;
  readonly top: number;
  /** 見出しと枠を含めた幅 */
  readonly width: number;
}

export interface ChartStyle {
  readonly title: string;
  /** ランの通し番号を重ねるか（2 枚に出すと煩いので Lab 側だけ） */
  readonly showRunNumbers: boolean;
  /** 見出しの脇に添える補足（abs の式など） */
  readonly subtitle?: string;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** 白フチ + 塗り。どんな背景でも読めるようにする。 */
function outlinedText(
  x: number,
  y: number,
  content: string,
  fontPx: number,
  fill: string,
  opacity: number,
): string {
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="sans-serif" ` +
    `font-size="${fontPx}" font-weight="700" text-anchor="middle" ` +
    `dominant-baseline="central" opacity="${opacity}" ` +
    `stroke="rgba(255,255,255,0.94)" stroke-width="${(fontPx * 0.26).toFixed(1)}" ` +
    `paint-order="stroke" fill="${fill}">${escapeXml(content)}</text>`
  );
}

/** 見出しと添え字の間隔 [px]。 */
const SUBTITLE_GAP = 16;

/**
 * 段の見出し。表とグラフで同じ体裁にする。
 *
 * @param subtitle 見出しの右に添える補足（計算式・抵抗値など）。太字にせず薄く出す
 */
export function sectionTitleSvg(
  x: number,
  top: number,
  text: string,
  subtitle?: string,
): string {
  const y = top + CHART.titleHeight / 2;
  const title =
    `<text x="${(x + 2).toFixed(1)}" y="${y.toFixed(1)}" ` +
    `font-family="sans-serif" font-size="${CHART.titleFontPx}" font-weight="700" ` +
    `fill="#111" dominant-baseline="central">${escapeXml(text)}</text>`;
  if (subtitle === undefined) return title;

  // 見出しの実寸は測れないので、文字数からの見積もりで右へずらす。
  // 全角の見出し（「カラーコード読み取り値」）では見積もりがほぼ実寸に一致して
  // 添え字が見出しに接するので、間隔は文字幅とは別に確保する
  const offset = x + SUBTITLE_GAP + text.length * CHART.titleFontPx * 0.95;
  return (
    title +
    `<text x="${offset.toFixed(1)}" y="${y.toFixed(1)}" font-family="monospace" ` +
    `font-size="${CHART.fontPx}" fill="#555" dominant-baseline="central">` +
    `${escapeXml(subtitle)}</text>`
  );
}

/** 目盛りの文字。 */
function tickText(
  x: number,
  y: number,
  content: string,
  anchor: 'start' | 'end' | 'middle',
  fill: string,
  fontPx: number = CHART.fontPx,
): string {
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="sans-serif" ` +
    `font-size="${fontPx}" fill="${fill}" text-anchor="${anchor}" ` +
    `dominant-baseline="central">${escapeXml(content)}</text>`
  );
}

/** 桁が小さいほど細かく出す（微分は 1 未満の刻みになることがある）。 */
function formatTick(value: number, span: number): string {
  if (span >= 20) return String(Math.round(value));
  if (span >= 2) return value.toFixed(1);
  return value.toFixed(2);
}

/** 系列の値域。空なら 0..1 の当たり障りのない範囲にする。 */
function rangeOf(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 1 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * グラフを 1 枚描く。系列を重ね、ラン境界を縦線で示す。
 *
 * X 軸は抵抗器の長手方向で、目盛りは検出した四角形の長さに対する %。
 * Y 軸は左が L* 系（微分では abs も）、右が a* と b*。値域が違う（L* は
 * 0〜100 超、a* と b* は概ね -60〜80）ので、同じ軸には乗せない。
 * 格子は左軸の目盛りに合わせて引き、右軸のラベルは同じ高さの値を出す。
 */
export function buildChartSvg(data: ChartData, layout: ChartLayout, style: ChartStyle): string {
  if (data.count === 0 || data.series.length === 0) return '';

  const geometry = plotGeometry(layout);
  if (geometry === null) return '';

  const frameWidth = layout.width - CHART.padding * 2;
  const plotWidth = geometry.width;
  const frameLeft = layout.left + CHART.padding;
  const frameTop = layout.top + CHART.titleHeight;
  const plotLeft = geometry.left;
  const plotTop = frameTop + CHART.padding;
  const plotHeight = chartPlotHeight();
  const plotBottom = plotTop + plotHeight;

  const leftRange = rangeOf(
    data.series.filter((series) => series.axis === 'left').flatMap((series) => [...series.values]),
  );
  const rightRange = rangeOf(
    data.series.filter((series) => series.axis === 'right').flatMap((series) => [...series.values]),
  );
  // 右軸に乗る系列が無いなら右の目盛りは出さない（abs だけのプレーンで
  // 意味のない 0.00〜1.00 が並ぶのを防ぐ）
  const hasRightAxis = data.series.some((series) => series.axis === 'right');

  /** 最大値をプロット高の 10%、最小値を 90% の位置に写す。 */
  const scaleOf = (range: { min: number; max: number }): ((value: number) => number) => {
    const span = Math.max(1e-6, range.max - range.min);
    return (value: number): number =>
      plotTop +
      (CHART.topFraction +
        (CHART.bottomFraction - CHART.topFraction) * ((range.max - value) / span)) *
        plotHeight;
  };
  /** 高さから値に戻す（右軸のラベルを左軸の格子に合わせるため）。 */
  const valueAt = (range: { min: number; max: number }, y: number): number => {
    const span = Math.max(1e-6, range.max - range.min);
    const fraction =
      ((y - plotTop) / plotHeight - CHART.topFraction) / (CHART.bottomFraction - CHART.topFraction);
    return range.max - fraction * span;
  };

  const toLeftY = scaleOf(leftRange);
  const toRightY = scaleOf(rightRange);
  const yOf = (series: ChartSeries, value: number): number =>
    series.axis === 'left' ? toLeftY(value) : toRightY(value);

  const toX = (index: number): number =>
    plotLeft + (data.count <= 1 ? 0 : (index / (data.count - 1)) * plotWidth);
  const xAtPercent = (percent: number): number =>
    plotLeft + fractionAtPercent(percent, data.roiPadding) * plotWidth;

  const parts: string[] = [
    sectionTitleSvg(frameLeft, layout.top, style.title, style.subtitle),
    `<rect x="${frameLeft.toFixed(1)}" y="${frameTop.toFixed(1)}" width="${frameWidth.toFixed(1)}" ` +
      `height="${CHART.height}" fill="#ffffff" stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
  ];

  // 本体範囲の外は薄く塗る（ここのランはバンドにしない）
  if (data.extent !== null) {
    const shade = (from: number, to: number): void => {
      if (to <= from) return;
      parts.push(
        `<rect x="${toX(from).toFixed(1)}" y="${plotTop.toFixed(1)}" ` +
          `width="${(toX(to) - toX(from)).toFixed(1)}" height="${plotHeight.toFixed(1)}" ` +
          `fill="rgba(0,0,0,0.06)" />`,
      );
    };
    shade(0, data.extent.start);
    shade(data.extent.end, data.count - 1);
  }

  // 格子と目盛り。折れ線より先に描いて下に敷く
  const gridLine = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    isMajor: boolean,
  ): string =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" ` +
    `y2="${y2.toFixed(1)}" stroke="${isMajor ? CHART.gridColor : CHART.minorGridColor}" ` +
    `stroke-width="1"${isMajor ? '' : ` stroke-dasharray="${CHART.minorGridDash}"`} />`;

  // Y 軸: 値域の 0〜100% を 5% 刻みで引く。10% の倍数は実線で濃く、
  // その間は点線で薄く。ラベルは潰れるので 20% 刻みだけに出す
  const leftSpan = leftRange.max - leftRange.min;
  const rightSpan = rightRange.max - rightRange.min;
  for (let percent = 0; percent <= 100; percent += GRID_STEP_PERCENT) {
    const y =
      plotTop +
      (CHART.topFraction + (CHART.bottomFraction - CHART.topFraction) * (percent / 100)) *
        plotHeight;
    const isMajor = percent % MAJOR_GRID_PERCENT === 0;
    parts.push(gridLine(plotLeft, y, plotLeft + plotWidth, y, isMajor));

    if (percent % CHART.labelStepPercent !== 0) continue;
    parts.push(
      tickText(plotLeft - 4, y, formatTick(valueAt(leftRange, y), leftSpan), 'end', SERIES_COLOR.l),
    );
    if (hasRightAxis) {
      parts.push(
        tickText(
          plotLeft + plotWidth + 4,
          y,
          formatTick(valueAt(rightRange, y), rightSpan),
          'start',
          '#666',
        ),
      );
    }
  }

  // X 軸: 抵抗器の長手方向の %（0% が赤い四角形の左端、100% が右端）。
  // 格子は Y 軸と同じ 5%／10% の刻み。ラベルは 25% 刻みだけに出す
  for (const percent of percentTickValues(data.roiPadding)) {
    const x = xAtPercent(percent);
    // 0% と 100% は本体の端なので、いちばん濃く引く
    if (percent === 0 || percent === 100) {
      parts.push(
        `<line x1="${x.toFixed(1)}" y1="${plotTop.toFixed(1)}" x2="${x.toFixed(1)}" ` +
          `y2="${plotBottom.toFixed(1)}" stroke="rgba(0,0,0,0.35)" stroke-width="1" ` +
          `stroke-dasharray="4 3" />`,
      );
    } else {
      parts.push(gridLine(x, plotTop, x, plotBottom, percent % MAJOR_GRID_PERCENT === 0));
    }
  }
  for (const percent of percentTickValues(data.roiPadding)) {
    // 10% の倍数は濃く、その間は薄く（格子の濃さと揃える）
    parts.push(
      tickText(
        xAtPercent(percent),
        plotBottom + CHART.xLabelHeight / 2,
        formatPercentTick(percent),
        'middle',
        percent % MAJOR_GRID_PERCENT === 0 ? '#555' : '#999',
        CHART.xTickFontPx,
      ),
    );
  }

  // 0 の水平線（符号が読めるように。右軸のスケール）
  if (hasRightAxis && rightRange.min < 0 && rightRange.max > 0) {
    parts.push(
      `<line x1="${plotLeft.toFixed(1)}" y1="${toRightY(0).toFixed(1)}" ` +
        `x2="${(plotLeft + plotWidth).toFixed(1)}" y2="${toRightY(0).toFixed(1)}" ` +
        `stroke="rgba(0,0,0,0.25)" stroke-width="1" stroke-dasharray="3 3" />`,
    );
  }

  // ラン境界（本数判定の理由が見えるように）
  data.runs.forEach((run, index) => {
    const isDropped = data.dropped.has(index);
    for (const edge of [run.start, run.end]) {
      parts.push(
        `<line x1="${toX(edge).toFixed(1)}" y1="${plotTop.toFixed(1)}" ` +
          `x2="${toX(edge).toFixed(1)}" y2="${plotBottom.toFixed(1)}" ` +
          `stroke="rgba(255,59,48,${isDropped ? 0.28 : 0.55})" stroke-width="1" />`,
      );
    }
  });

  for (const series of data.series) {
    const points = series.values
      .map((value, index) => `${toX(index).toFixed(1)},${yOf(series, value).toFixed(1)}`)
      .join(' ');
    parts.push(
      `<polyline points="${points}" fill="none" stroke="${series.color}" ` +
        `stroke-width="1.5" stroke-linejoin="round" />`,
    );
  }

  // 人手の正解区間。プロットの下端に帯として置き、検出のラン境界（赤い縦線）と
  // 見比べられるようにする
  for (const label of data.labels ?? []) {
    const left = xAtPercent(label.start);
    const width = Math.max(1, xAtPercent(label.end) - left);
    parts.push(
      `<rect x="${left.toFixed(1)}" y="${(plotBottom - 6).toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="6" fill="${LABEL_COLOR}" opacity="0.55" />`,
    );
  }

  // ランの通し番号。写真に焼いた番号・一覧表の番号と対応する。
  // 折れ線より後に描いて線に隠れないようにする
  if (style.showRunNumbers) {
    data.runs.forEach((run, index) => {
      parts.push(
        outlinedText(
          toX((run.start + run.end) / 2),
          plotTop + CHART.fontPx,
          String(index + 1),
          CHART.fontPx + 1,
          RUN_NUMBER_COLOR,
          data.dropped.has(index) ? 0.45 : 1,
        ),
      );
    });
  }

  // 凡例。左軸か右軸かを書く（上端に置くと目盛りと重なるため下に出す）
  const legendY = plotBottom + CHART.xLabelHeight + CHART.legendHeight / 2;
  const legendStep = Math.min(90, Math.max(58, plotWidth / data.series.length));
  data.series.forEach((series, index) => {
    const x = plotLeft + index * legendStep;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${legendY.toFixed(1)}" x2="${(x + 14).toFixed(1)}" ` +
        `y2="${legendY.toFixed(1)}" stroke="${series.color}" stroke-width="2" />`,
      `<text x="${(x + 18).toFixed(1)}" y="${legendY.toFixed(1)}" font-family="sans-serif" ` +
        `font-size="${CHART.fontPx}" fill="#333" dominant-baseline="central">` +
        `${escapeXml(series.label)}${hasRightAxis ? (series.axis === 'left' ? '(左)' : '(右)') : ''}` +
        `</text>`,
    );
  });

  return parts.join('');
}

/** ROI ストリップの入力。 */
export interface StripData {
  /** 水平化・色補正した ROI の PNG（data URI） */
  readonly href: string;
  /** ROI の画素数（走査線の位置を割合に直すため） */
  readonly roiHeight: number;
  /** 走査線が見ている行範囲（`scanRowRanges` の結果） */
  readonly scanRows: readonly { readonly start: number; readonly end: number }[];
  /** ROI の列数（ラン境界の位置を割合に直すため） */
  readonly roiWidth: number;
  /** バンド候補のランの境界（赤い縦線で重ねる） */
  readonly runs: readonly { readonly start: number; readonly end: number }[];
  /** 捨てられたランの添字（薄く描く） */
  readonly dropped: ReadonlySet<number>;
  /** ROI が本体の外側に取っている余白の割合（X 軸を % にするため） */
  readonly roiPadding: number;
}

/**
 * 水平化・色補正した ROI を、グラフの X 軸に合わせて 1 枚描く。
 *
 * **X 方向はグラフのプロット領域とぴったり同じ**（`plotGeometry` を共有）。
 * ROI の全幅が「-余白%〜100+余白%」に対応するので、グラフの 0% / 100% の
 * 破線がそのまま画像上の本体の端になる。
 *
 * 走査線は**白の点線**で重ねる。解析がどの行を見ているかを、グラフの山と
 * 同じ画面で確かめられるようにするため。
 */
export function buildRoiStripSvg(
  data: StripData,
  layout: ChartLayout,
  style: { readonly title: string },
): string {
  const geometry = plotGeometry(layout);
  if (geometry === null || data.roiHeight <= 0) return '';

  const top = layout.top + CHART.titleHeight;
  const bottom = top + STRIP.height;
  const { left, width } = geometry;
  const toY = (row: number): number => top + (row / data.roiHeight) * STRIP.height;
  const toX = (column: number): number =>
    left + (data.roiWidth <= 1 ? 0 : (column / (data.roiWidth - 1)) * width);

  const parts: string[] = [
    sectionTitleSvg(layout.left + CHART.padding, layout.top, style.title),
    `<image x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" ` +
      `height="${STRIP.height}" href="${data.href}" preserveAspectRatio="none" ` +
      `image-rendering="pixelated" />`,
    `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" ` +
      `height="${STRIP.height}" fill="none" stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
  ];

  // 走査線。中心に白の点線を引き、見ている行の幅ぶんを薄く塗る
  for (const rows of data.scanRows) {
    const y = toY((rows.start + rows.end) / 2);
    const height = Math.max(1, toY(rows.end) - toY(rows.start));
    parts.push(
      `<rect x="${left.toFixed(1)}" y="${toY(rows.start).toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="${height.toFixed(1)}" ` +
        `fill="rgba(255,255,255,0.14)" />`,
      `<line x1="${left.toFixed(1)}" y1="${y.toFixed(1)}" ` +
        `x2="${(left + width).toFixed(1)}" y2="${y.toFixed(1)}" ` +
        `stroke="#ffffff" stroke-width="1" stroke-dasharray="${STRIP.scanDash}" ` +
        `opacity="0.9" />`,
    );
  }

  // ラン境界。グラフの赤い縦線と同じ位置・同じ濃さにする
  data.runs.forEach((run, index) => {
    const opacity = data.dropped.has(index) ? 0.35 : 0.7;
    for (const edge of [run.start, run.end]) {
      parts.push(
        `<line x1="${toX(edge).toFixed(1)}" y1="${top.toFixed(1)}" ` +
          `x2="${toX(edge).toFixed(1)}" y2="${bottom.toFixed(1)}" ` +
          `stroke="rgba(255,59,48,${opacity})" stroke-width="1" />`,
      );
    }
  });

  // X 軸。グラフと同じ % 目盛りを出す（画像だけ見ても位置が読める）
  const xAtPercent = (percent: number): number =>
    left + fractionAtPercent(percent, data.roiPadding) * width;
  for (const percent of percentTickValues(data.roiPadding)) {
    const x = xAtPercent(percent);
    const isEdge = percent === 0 || percent === 100;
    const tickHeight = isEdge ? 6 : percent % 10 === 0 ? 4 : 2;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${bottom.toFixed(1)}" x2="${x.toFixed(1)}" ` +
        `y2="${(bottom + tickHeight).toFixed(1)}" ` +
        `stroke="${isEdge ? 'rgba(0,0,0,0.55)' : CHART.gridColor}" stroke-width="1" />`,
    );
  }
  for (const percent of percentTickValues(data.roiPadding)) {
    parts.push(
      tickText(
        xAtPercent(percent),
        bottom + CHART.xLabelHeight / 2 + 3,
        formatPercentTick(percent),
        'middle',
        percent % MAJOR_GRID_PERCENT === 0 ? '#555' : '#999',
        CHART.xTickFontPx,
      ),
    );
  }

  return parts.join('');
}
