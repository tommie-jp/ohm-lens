import { context2d } from './canvas.js';
import { HISTORY_LENGTH } from './threadLoad.js';

/**
 * スレッド占有率の折れ線グラフ。
 *
 * 映像に重ねるので、目盛りや軸ラベルは持たせない（0〜100% の固定スケールと
 * 50% の目安線だけ）。数値は凡例側が受け持つ。
 */

const CANVAS_WIDTH = HISTORY_LENGTH * 3;
const CANVAS_HEIGHT = 48;

/** 中間の目安線。 */
const HALF_LINE_DASH: readonly number[] = [3, 3];

/**
 * 縦軸の上限の段。
 *
 * 常に 100% 目盛りだと、実測の数 %〜十数 % が底に貼り付いて読めない。
 * かといって毎回最大値に合わせると目盛りが揺れて比較にならないので、
 * 段で持つ。上限は canvas に描いて、絶対値が読めるようにする。
 */
const SCALE_STEPS: readonly number[] = [0.25, 0.5, 1];

export interface LoadSeries {
  /** 占有率の履歴（古い順、0..1）。 */
  readonly history: readonly number[];
  /** 線の色。 */
  readonly color: string;
  /** 面の塗り色。 */
  readonly fill: string;
}

/** 履歴の山がちょうど収まる段を選ぶ。 */
export function scaleFor(series: readonly LoadSeries[]): number {
  const peak = Math.max(0, ...series.flatMap((one) => [...one.history]));
  return SCALE_STEPS.find((step) => peak <= step) ?? 1;
}

export function drawThreadLoad(
  canvas: HTMLCanvasElement,
  series: readonly LoadSeries[],
): void {
  if (canvas.width !== CANVAS_WIDTH) canvas.width = CANVAS_WIDTH;
  if (canvas.height !== CANVAS_HEIGHT) canvas.height = CANVAS_HEIGHT;

  const context = context2d(canvas);
  context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const scale = scaleFor(series);
  drawHalfLine(context);
  for (const one of series) drawSeries(context, one, scale);
  drawScaleLabel(context, scale);
}

function drawHalfLine(context: CanvasRenderingContext2D): void {
  context.save();
  context.strokeStyle = 'rgb(255 255 255 / 0.3)';
  context.lineWidth = 1;
  context.setLineDash([...HALF_LINE_DASH]);
  context.beginPath();
  context.moveTo(0, CANVAS_HEIGHT / 2);
  context.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT / 2);
  context.stroke();
  context.restore();
}

/** 縦軸の上限。段が変わったことに気づけるよう左上に出す。 */
function drawScaleLabel(context: CanvasRenderingContext2D, scale: number): void {
  context.save();
  context.font = '10px system-ui, sans-serif';
  context.textBaseline = 'top';
  context.fillStyle = 'rgb(255 255 255 / 0.75)';
  context.fillText(formatLoad(scale), 3, 2);
  context.restore();
}

/**
 * 履歴は右端が最新。点が足りないうちは右へ寄せて描く
 * （左から伸びると、始めたばかりなのに落ち込んで見える）。
 */
function pointAt(
  index: number,
  count: number,
  load: number,
  scale: number,
): { x: number; y: number } {
  const step = CANVAS_WIDTH / Math.max(1, HISTORY_LENGTH - 1);
  return {
    x: CANVAS_WIDTH - (count - 1 - index) * step,
    y: CANVAS_HEIGHT - Math.min(1, load / scale) * CANVAS_HEIGHT,
  };
}

function drawSeries(
  context: CanvasRenderingContext2D,
  series: LoadSeries,
  scale: number,
): void {
  const { history } = series;
  if (history.length === 0) return;

  const points = history.map((load, index) => pointAt(index, history.length, load, scale));
  const first = points[0] as { x: number; y: number };
  const last = points[points.length - 1] as { x: number; y: number };

  // 面
  context.beginPath();
  context.moveTo(first.x, CANVAS_HEIGHT);
  for (const point of points) context.lineTo(point.x, point.y);
  context.lineTo(last.x, CANVAS_HEIGHT);
  context.closePath();
  context.fillStyle = series.fill;
  context.fill();

  // 線
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = series.color;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.stroke();
}

/** 凡例に出す表記。 */
export function formatLoad(load: number): string {
  return `${Math.round(load * 100)}%`;
}
