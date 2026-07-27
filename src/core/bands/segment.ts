import type { Band, ProfileSample } from '../../types.js';
import { classifyBandColor } from './classify.js';
import { identifyBody, splitRuns, type ColorRun } from './runs.js';

export interface SegmentOptions {
  /** 隣接サンプルの ΔE がこれを超えたら切れ目とみなす */
  readonly edgeDeltaE?: number;
  /** これ未満の幅のランはノイズとして捨てる */
  readonly minBandWidth?: number;
  /** 同じ色のランとみなす ΔE（本体ランをまとめるのに使う） */
  readonly clusterDeltaE?: number;
}

/**
 * 1D カラープロファイルからバンドを抽出する。
 *
 * 1. 色の切れ目でランに分割する（この時点では分類しない）
 * 2. 最も面積の大きいラン群を本体とみなす
 * 3. 本体以外のランを、ラン単位で 1 回だけ分類する
 *
 * 画素ごとに分類してから束ねる方式では、茶/赤のような紛らわしい色で
 * バンド内の分類が揺れて 1 本のバンドが細切れになる。先にランを切って
 * から分類することで、分類の曖昧さがバンドの本数に波及しなくなる。
 */
export function segmentBands(
  profile: readonly ProfileSample[],
  options: SegmentOptions = {},
): Band[] {
  const runs = splitRuns(profile, {
    ...(options.edgeDeltaE === undefined ? {} : { edgeDeltaE: options.edgeDeltaE }),
    ...(options.minBandWidth === undefined ? {} : { minRunLength: options.minBandWidth }),
  });

  const body = identifyBody(runs, options.clusterDeltaE);
  if (body === null) return [];

  const bodyRuns = new Set(body.runIndices);

  return runs
    .map((run, index) => ({ run, index }))
    .filter(({ index }) => !bodyRuns.has(index))
    .map(({ run }) => toBand(run));
}

function toBand(run: ColorRun): Band {
  const classification = classifyBandColor(run.lab);
  return {
    color: classification.color,
    start: run.start,
    end: run.end,
    confidence: classification.confidence,
  };
}
