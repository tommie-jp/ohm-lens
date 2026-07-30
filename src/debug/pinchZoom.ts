/**
 * 2 本指のピンチをデジタルズームの倍率に変換する。
 *
 * ブラウザ標準のピンチはページ全体を拡大してしまい、ガイド枠や操作
 * ボタンまで一緒に大きくなる。そこでピンチは自前で受け取り、**映像だけ**を
 * 拡大する（`setDigitalZoom` と video の CSS 拡大）。ガイドと操作バーは
 * 画面に固定されたままになる。
 *
 * 計算だけを切り出してテストする（DOM 側の配線は main.ts）。
 */

export const MIN_PINCH_ZOOM = 1;
export const MAX_PINCH_ZOOM = 8;

export interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/** 2 点間の距離。ピンチの開き具合。 */
export function touchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * ピンチ開始時の倍率と、指の開き具合の比から新しい倍率を出す。
 * 範囲外はクランプする。開始距離が 0（同じ点）なら倍率を変えない。
 */
export function pinchZoom(
  baseZoom: number,
  startDistance: number,
  currentDistance: number,
  maxZoom = MAX_PINCH_ZOOM,
): number {
  if (startDistance <= 0) return clampZoom(baseZoom, maxZoom);
  return clampZoom((baseZoom * currentDistance) / startDistance, maxZoom);
}

function clampZoom(zoom: number, maxZoom: number): number {
  return Math.min(Math.max(zoom, MIN_PINCH_ZOOM), maxZoom);
}
