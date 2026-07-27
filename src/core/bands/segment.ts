import type { Band, ProfileSample } from '../../types.js';
import { classifyBandColor } from './classify.js';
import { DEFAULT_PALETTE, type Palette } from '../color/palette.js';
import { identifyBody, splitRuns, type ColorRun } from './runs.js';

export interface SegmentOptions {
  /** 隣接サンプルの ΔE がこれを超えたら切れ目とみなす */
  readonly edgeDeltaE?: number;
  /** これ未満の幅のランはノイズとして捨てる */
  readonly minBandWidth?: number;
  /** 同じ色のランとみなす ΔE（本体ランをまとめるのに使う） */
  readonly clusterDeltaE?: number;
  /** バンド色の基準テーブル。較正結果を差し替えられる。 */
  readonly palette?: Palette;
}

/**
 * 本体を除いた「バンド候補」のランを取り出す（分類はしない）。
 *
 * 1. 色の切れ目でランに分割する
 * 2. 最も面積の大きいラン群を本体とみなす
 * 3. 本体以外のランを返す
 *
 * 分類まで済ませた Band が欲しい場合は {@link segmentBands}、
 * 色候補を残したまま同時デコードに回す場合はこちらを使う。
 */
export function bandRuns(
  profile: readonly ProfileSample[],
  options: SegmentOptions = {},
): ColorRun[] {
  const runs = splitRuns(profile, {
    ...(options.edgeDeltaE === undefined ? {} : { edgeDeltaE: options.edgeDeltaE }),
    ...(options.minBandWidth === undefined ? {} : { minRunLength: options.minBandWidth }),
  });

  const body = identifyBody(runs, options.clusterDeltaE);
  if (body === null) return [];

  const bodyRuns = new Set(body.runIndices);
  return runs.filter((_, index) => !bodyRuns.has(index));
}

/**
 * 1D カラープロファイルからバンドを抽出する。
 *
 * 画素ごとに分類してから束ねる方式では、茶/赤のような紛らわしい色で
 * バンド内の分類が揺れて 1 本のバンドが細切れになる。先にランを切って
 * から分類することで、分類の曖昧さがバンドの本数に波及しなくなる。
 */
export function segmentBands(
  profile: readonly ProfileSample[],
  options: SegmentOptions = {},
): Band[] {
  return bandRuns(profile, options).map((run) => toBand(run, options.palette ?? DEFAULT_PALETTE));
}

function toBand(run: ColorRun, palette: Palette): Band {
  const classification = classifyBandColor(run.lab, palette);
  return {
    color: classification.color,
    start: run.start,
    end: run.end,
    confidence: classification.confidence,
  };
}
