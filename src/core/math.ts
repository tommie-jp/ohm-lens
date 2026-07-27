/**
 * 数値ユーティリティ。
 * 色・バンド・値の各モジュールから共通で使う。
 */

/** value を [min, max] に収める。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** value を [0, 1] に収める。 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * 中央値。**引数を破壊的にソートする**ので、呼び出し側は再利用しない
 * バッファを渡すこと。外れ値（鏡面反射による白飛びなど）に強い代表値が
 * 欲しい場面で使う。
 */
export function medianInPlace(values: Uint8ClampedArray | Float64Array): number {
  if (values.length === 0) return Number.NaN;

  values.sort();
  const mid = values.length >> 1;
  if (values.length % 2 === 1) return values[mid] as number;
  return ((values[mid - 1] as number) + (values[mid] as number)) / 2;
}

/**
 * 上位 2 件の差を 0..1 に正規化したマージン。
 * 1 に近いほど「1 位が明確に優れている」、0 に近いほど紛らわしい。
 *
 * 色分類（茶/赤の取り違え）と読み取り方向の判定で同じ尺度を使う。
 */
export function normalizedMargin(best: number, second: number): number {
  const total = Math.abs(best) + Math.abs(second);
  return total === 0 ? 0 : Math.abs(second - best) / total;
}
