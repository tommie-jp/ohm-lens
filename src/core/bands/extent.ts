import type { ProfileSample } from '../../types.js';
import { identifyBody, splitRuns } from './runs.js';

/**
 * プロファイルから抵抗器本体が占める範囲を求める。
 *
 * ROI には本体の外側（机や背景、リード線）が必ず少し入り込む。それを
 * バンドとして拾うと、たとえば「白い机」が白バンドになって本数が狂う。
 * 本体ランの外端から外端までを本体とみなし、その外側は解析対象から外す。
 *
 * バンドは必ず本体の内側にあるので、この範囲で切っても取りこぼさない。
 */

export interface BodyExtentOptions {
  /** 隣接サンプルの ΔE がこれを超えたら切れ目とみなす */
  readonly edgeDeltaE?: number;
  /** これ未満の長さのランはノイズとして無視する */
  readonly minRunLength?: number;
  /** 同じ色のランとみなす ΔE */
  readonly clusterDeltaE?: number;
}

export interface BodyExtent {
  /** 開始インデックス（含む） */
  readonly start: number;
  /** 終了インデックス（含まない） */
  readonly end: number;
}

/**
 * 本体の範囲を返す。ランが取れなければ null。
 *
 * @param profile 1D カラープロファイル（色順応補正の適用後）
 */
export function bodyExtent(
  profile: readonly ProfileSample[],
  options: BodyExtentOptions = {},
): BodyExtent | null {
  const runs = splitRuns(profile, {
    ...(options.edgeDeltaE === undefined ? {} : { edgeDeltaE: options.edgeDeltaE }),
    ...(options.minRunLength === undefined ? {} : { minRunLength: options.minRunLength }),
  });

  return identifyBody(runs, options.clusterDeltaE)?.extent ?? null;
}
