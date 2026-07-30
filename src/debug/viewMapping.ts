import { clamp } from '../core/math.js';

/**
 * 表示座標（CSS px）と内在解像度の変換。
 *
 * CLAUDE.md の「映像座標と Canvas 座標の変換関数は一箇所にまとめる」に従い、
 * ポインタ座標の逆変換はすべてここを通す。純粋な計算とDOM 依存の薄い
 * ラッパを分け、計算部分だけ単体テストする。
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface DisplayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface IntrinsicSize {
  readonly width: number;
  readonly height: number;
}

/**
 * クライアント座標を要素の内在解像度の座標へ変換する。
 * 結果は内在解像度の範囲内にクランプする。
 */
export function clientToIntrinsic(
  rect: DisplayRect,
  size: IntrinsicSize,
  clientX: number,
  clientY: number,
): Point {
  const scaleX = rect.width > 0 ? size.width / rect.width : 0;
  const scaleY = rect.height > 0 ? size.height / rect.height : 0;
  return {
    x: clamp((clientX - rect.left) * scaleX, 0, size.width),
    y: clamp((clientY - rect.top) * scaleY, 0, size.height),
  };
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `object-fit: cover` で表示したときに、実際に画面へ出ている範囲
 * （内在解像度の座標）を返す。
 *
 * cover は縦横比を保ったまま表示領域を埋めるので、はみ出した側が
 * 左右または上下で均等に切り落とされる。ガイド枠のように「必ず見えて
 * いなければ意味がない」ものは、フレーム全体ではなくこの範囲に収める。
 */
export function coverVisibleRect(
  frame: IntrinsicSize,
  display: { readonly width: number; readonly height: number },
): Rect {
  const scale = Math.max(display.width / frame.width, display.height / frame.height);
  // 表示サイズが取れない（幅 0 など）ときはフレーム全体を可視とみなす
  if (!Number.isFinite(scale) || scale <= 0) {
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  }
  const width = Math.min(frame.width, display.width / scale);
  const height = Math.min(frame.height, display.height / scale);
  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
}

/** canvas 上のポインタ座標を canvas の内在解像度に変換する。 */
export function pointerToCanvas(canvas: HTMLCanvasElement, event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return clientToIntrinsic(
    rect,
    { width: canvas.width, height: canvas.height },
    event.clientX,
    event.clientY,
  );
}
