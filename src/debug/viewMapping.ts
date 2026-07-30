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
