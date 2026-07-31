import type { Rect } from './viewMapping.js';

/**
 * ライブ表示のスクリーンショット。
 *
 * 「画面に見えているまま」を 1 枚に焼く。映像は `object-fit: cover` で
 * 切り取られ、デジタルズームでさらに中央だけを使っているので、**元の映像の
 * どこが見えているか**を逆算して切り出す。オーバーレイ（枠・バンド・値）は
 * 同じ範囲を重ねて描く。
 *
 * 解析フレームではなく video から切り出すので、解析用に落とした解像度では
 * なく撮影時の解像度で保存できる。
 */

/** 長辺がこれを超えないように縮める（1 枚が大きくなりすぎないように）。 */
const MAX_OUTPUT_PX = 2000;

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * 画面に見えている範囲を、元の映像（video の内在解像度）の座標で返す。
 *
 * @param video 映像の内在解像度
 * @param frame 解析フレームの大きさ（デジタルズームで切り出したあとの範囲に対応する）
 * @param visible 解析フレームのうち画面に出ている範囲
 * @param zoom デジタルズームの倍率
 */
export function visibleSourceRect(
  video: Size,
  frame: Size,
  visible: Rect,
  zoom: number,
): Rect {
  // デジタルズームで実際に使っている元映像の範囲（中央）
  const usedWidth = video.width / zoom;
  const usedHeight = video.height / zoom;
  const offsetX = (video.width - usedWidth) / 2;
  const offsetY = (video.height - usedHeight) / 2;

  // 解析フレーム 1px が元映像の何 px にあたるか
  const scale = frame.width > 0 ? usedWidth / frame.width : 1;

  return {
    x: offsetX + visible.x * scale,
    y: offsetY + visible.y * scale,
    width: visible.width * scale,
    height: visible.height * scale,
  };
}

/** 長辺を {@link MAX_OUTPUT_PX} に収める出力サイズ。 */
export function outputSize(source: Size, maxPx = MAX_OUTPUT_PX): Size {
  const longest = Math.max(source.width, source.height);
  const scale = longest > maxPx ? maxPx / longest : 1;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 保存するファイル名。`ohm-lens-2026-07-31-1903.jpg` の形。
 *
 * 拡張子が jpg なのは、ブラウザの canvas が書き出せる形式に HEIC が無いため
 * （読み込みは `heic-to` で対応しているが、書き出しはできない）。中身と
 * 合わない拡張子を付けない。
 */
export function screenshotFileName(now: Date): string {
  const stamp =
    `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `ohm-lens-${stamp}.jpg`;
}

export interface ComposeOptions {
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLCanvasElement;
  /** 解析フレームの大きさ（= オーバーレイの内在解像度）。 */
  readonly frame: Size;
  /** 解析フレームのうち画面に出ている範囲。 */
  readonly visible: Rect;
  readonly zoom: number;
}

/** 映像とオーバーレイを 1 枚に合成した canvas。 */
export function composeScreenshot(options: ComposeOptions): HTMLCanvasElement {
  const source = visibleSourceRect(
    { width: options.video.videoWidth, height: options.video.videoHeight },
    options.frame,
    options.visible,
    options.zoom,
  );
  const size = outputSize(source);

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2D コンテキストを取得できませんでした');

  context.drawImage(
    options.video,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    size.width,
    size.height,
  );
  // オーバーレイは解析フレーム座標。見えている範囲だけを同じ場所へ重ねる
  context.drawImage(
    options.overlay,
    options.visible.x,
    options.visible.y,
    options.visible.width,
    options.visible.height,
    0,
    0,
    size.width,
    size.height,
  );
  return canvas;
}
