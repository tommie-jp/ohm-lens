/** canvas 操作の共通ヘルパー。デバッグページ専用（core/ は DOM 非依存を保つ）。 */

export interface Context2dOptions {
  /** getImageData を繰り返す canvas では true にする */
  readonly willReadFrequently?: boolean;
}

/**
 * 2D コンテキストを取得する。取得できない環境は想定していないので例外にする。
 *
 * @throws {Error} 2D コンテキストを取得できない場合
 */
export function context2d(
  canvas: HTMLCanvasElement,
  options: Context2dOptions = {},
): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', {
    willReadFrequently: options.willReadFrequently ?? false,
  });
  if (context === null) throw new Error('2D コンテキストを取得できませんでした');
  return context;
}
