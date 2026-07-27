import type { ProfileSample } from '../../types.js';
import { isBodyColor } from './classify.js';

/**
 * プロファイルから抵抗器本体が占める範囲を求める。
 *
 * ROI には本体の外側（机や背景、リード線）が必ず少し入り込む。それを
 * バンドとして拾うと、たとえば「白い机」が白バンドになって本数が狂う。
 * 本体色が最初に現れる位置から最後に現れる位置までを本体とみなし、
 * その外側は解析対象から外す。
 *
 * バンドは必ず本体の内側にあるので、この範囲で切っても取りこぼさない。
 */

export interface BodyExtentOptions {
  /** 本体色とみなす ΔE の閾値 */
  readonly bodyDeltaE?: number;
  /** 本体色の連続がこの長さ未満なら、ノイズとみなして無視する */
  readonly minRunLength?: number;
}

export interface BodyExtent {
  /** 開始インデックス（含む） */
  readonly start: number;
  /** 終了インデックス（含まない） */
  readonly end: number;
}

const DEFAULT_MIN_RUN_LENGTH = 1;

/**
 * 本体の範囲を返す。本体色が見つからなければ null。
 *
 * @param profile 1D カラープロファイル（色順応補正の適用後）
 */
export function bodyExtent(
  profile: readonly ProfileSample[],
  options: BodyExtentOptions = {},
): BodyExtent | null {
  const minRunLength = options.minRunLength ?? DEFAULT_MIN_RUN_LENGTH;

  const isBody = profile.map((sample) => isBodyColor(sample.lab, options.bodyDeltaE));

  let first = -1;
  let last = -1;
  let runStart = -1;

  for (let index = 0; index <= isBody.length; index += 1) {
    if (index < isBody.length && isBody[index] === true) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart >= 0) {
      if (index - runStart >= minRunLength) {
        if (first < 0) first = runStart;
        last = index;
      }
      runStart = -1;
    }
  }

  if (first < 0) return null;
  return { start: first, end: last };
}
