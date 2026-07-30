import type { Band } from '../types.js';
import type { OrientedBox } from '../core/locate.js';
import type { RectifyOptions } from '../core/rectify.js';
import { bandCorners, labelAnchor, labelDirection, labelSide } from '../core/roiMapping.js';
import { BAND_COLOR_JA, bandColorCss } from '../core/color/colors.js';

/**
 * 検出結果を元の写真に焼き込む。
 *
 * 「検出が外れているのか」「バンド分割が外れているのか」「分類が外れて
 * いるのか」を写真 1 枚で切り分けられるようにするのが目的。座標計算は
 * すべて `core/roiMapping` に寄せてあるので、ここは描画だけを担う。
 */

/** 検出ボックスの枠色。赤。 */
const BOX_COLOR = '#ff3b30';

/** バンド帯の塗り。写真と紛れないよう白の半透明にする。 */

/** ラベルを箱の縁からどれだけ離すか（箱の太さに対する割合）。 */
const LABEL_OFFSET_RATIO = 0.55;

/** ラベル文字の大きさ（箱の太さに対する割合）。 */
const LABEL_SIZE_RATIO = 0.5;

const MIN_LABEL_PX = 11;
const MAX_LABEL_PX = 42;

/** 確信度がこれ未満のラベルは薄く描く（誤分類を見分けるため）。 */
const LOW_CONFIDENCE = 0.35;

export interface OverlayOptions {
  /** ROI を切り出したときと同じ設定。座標を正しく逆変換するために必要。 */
  readonly rectify: RectifyOptions;
  /** 色名を日本語 1 文字で出す（既定）。false なら英字 3 文字。 */
  readonly japanese?: boolean;
}

function drawPolygon(
  context: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
): void {
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
}

/**
 * 抵抗器を囲む赤い回転ボックス。
 *
 * ROI にはパディングが乗っているので、囲むのは padding を含まない
 * 「検出した箱そのもの」。ここだけ素の寸法から四隅を出す。
 */
export function drawDetectionBox(context: CanvasRenderingContext2D, box: OrientedBox): void {
  const rad = (box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfLength = box.length / 2;
  const halfThickness = box.thickness / 2;

  const points = (
    [
      [-halfLength, -halfThickness],
      [halfLength, -halfThickness],
      [halfLength, halfThickness],
      [-halfLength, halfThickness],
    ] as const
  ).map(([along, across]) => ({
    x: box.centerX + along * cos - across * sin,
    y: box.centerY + along * sin + across * cos,
  }));

  context.save();
  context.strokeStyle = BOX_COLOR;
  context.lineWidth = Math.max(2, Math.round(box.thickness / 14));
  drawPolygon(context, points);
  context.stroke();
  context.restore();
}

/** 各バンドの範囲を帯で塗り、色名を縁の外側に添える。 */
export function drawBandLabels(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  bands: readonly Band[],
  options: OverlayOptions,
): void {
  if (bands.length === 0) return;

  const fontPx = Math.round(
    Math.min(MAX_LABEL_PX, Math.max(MIN_LABEL_PX, box.thickness * LABEL_SIZE_RATIO)),
  );
  const baseOffset = box.thickness * LABEL_OFFSET_RATIO;
  // 注釈は水平な抵抗器なら下、垂直なら右に出す
  const side = labelSide(box);

  context.save();
  context.font = `700 ${fontPx}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  bands.forEach((band, index) => {
    // 帯: バンドの占める範囲を示す（塗らない。色帯そのものを隠さないため）
    drawPolygon(context, bandCorners(box, options.rectify, band));
    context.strokeStyle = bandColorCss(band.color);
    context.lineWidth = Math.max(1, Math.round(box.thickness / 22));
    context.stroke();

    context.globalAlpha = band.confidence < LOW_CONFIDENCE ? 0.55 : 1;

    // 番号: バンドのすぐ外側。色空間の面に出る番号と対応する
    const numberAt = labelAnchor(box, options.rectify, band, fontPx * 0.8, side);
    context.lineWidth = Math.max(2, fontPx * 0.22);
    context.strokeStyle = 'rgb(255 255 255 / 0.92)';
    context.strokeText(String(index + 1), numberAt.x, numberAt.y);
    context.fillStyle = BOX_COLOR;
    context.fillText(String(index + 1), numberAt.x, numberAt.y);

    // ラベル: 番号の直下（右横）。詰まって重なるので 1 本ごとに段違いにする
    const stagger = index % 2 === 0 ? 0 : fontPx * 1.15;
    const anchor = labelAnchor(box, options.rectify, band, baseOffset + stagger + fontPx * 0.8, side);
    const text = (options.japanese ?? true) ? BAND_COLOR_JA[band.color] : band.color;

    // 色玉（金/黄、灰/銀の取り違えを目で確かめられるように）
    const dot = fontPx * 0.32;
    context.beginPath();
    context.arc(anchor.x - fontPx * 0.72, anchor.y, dot, 0, Math.PI * 2);
    context.fillStyle = bandColorCss(band.color);
    context.fill();
    context.strokeStyle = 'rgb(0 0 0 / 0.5)';
    context.lineWidth = 1;
    context.stroke();

    // 文字: どんな背景でも読めるよう白フチ + 黒文字
    context.lineWidth = Math.max(2, fontPx * 0.22);
    context.strokeStyle = 'rgb(255 255 255 / 0.92)';
    context.strokeText(text, anchor.x + fontPx * 0.22, anchor.y);
    context.fillStyle = '#111';
    context.fillText(text, anchor.x + fontPx * 0.22, anchor.y);
    context.globalAlpha = 1;
  });

  context.restore();
}

/** 推定値の文字の大きさ（箱の太さに対する割合）。バンドラベルより大きく。 */
const READING_SIZE_RATIO = 0.75;

const MIN_READING_PX = 14;
const MAX_READING_PX = 56;

/**
 * 推定した抵抗値を箱のそばに描く（ライブ表示用）。
 *
 * バンドラベルは {@link labelDirection} の向き（水平なら下、垂直なら右）に
 * 出るので、値はその**反対側**に出して重なりを避ける。渡す文字列は
 * `formatReading()` の戻り値をそのまま使うこと — 確信度が閾値未満のとき
 * 「?」になる規約を format 側が担保している。
 */
export function drawReadingLabel(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  text: string,
): void {
  const fontPx = Math.round(
    Math.min(MAX_READING_PX, Math.max(MIN_READING_PX, box.thickness * READING_SIZE_RATIO)),
  );
  const direction = labelDirection(box);
  const offset = box.thickness / 2 + fontPx;
  const x = box.centerX - direction.x * offset;
  const y = box.centerY - direction.y * offset;

  context.save();
  context.font = `700 ${fontPx}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineWidth = Math.max(3, fontPx * 0.22);
  context.strokeStyle = 'rgb(255 255 255 / 0.92)';
  context.strokeText(text, x, y);
  context.fillStyle = '#111';
  context.fillText(text, x, y);
  context.restore();
}

/** 箱とバンドをまとめて描く。 */
export function drawDetectionOverlay(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  bands: readonly Band[],
  options: OverlayOptions,
): void {
  drawDetectionBox(context, box);
  drawBandLabels(context, box, bands, options);
}
