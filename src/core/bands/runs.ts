import type { LabColor, ProfileSample } from '../../types.js';
import { deltaE2000 } from '../color/colorSpace.js';

/**
 * 1D カラープロファイルを「色が続く区間（ラン）」に分割する。
 *
 * **分類より先にランを切る**のが要点。画素ごとに最近傍色へ分類してから
 * 同じ色をまとめると、茶/赤のような紛らわしい色でバンド内の分類が揺れ、
 * 1 本のバンドが細切れになって消えてしまう。隣接サンプル間の色差だけで
 * 切れ目を決めれば、分類の曖昧さはランの中に閉じ込められる。
 *
 * 本体色も「基準テーブルとの絶対距離」ではなく「最も面積の大きいラン群」
 * として決めるので、ベージュでも水色でも緑でも同じ仕組みで扱える。
 */

export interface ColorRun {
  /** 開始インデックス（含む） */
  readonly start: number;
  /** 終了インデックス（含まない） */
  readonly end: number;
  /** 構成サンプルの Lab 中央値 */
  readonly lab: LabColor;
}

export interface SplitRunsOptions {
  /** 隣接サンプルの ΔE がこれを超えたら切れ目とみなす */
  readonly edgeDeltaE?: number;
  /** これ未満の長さのランはノイズとして捨てる */
  readonly minRunLength?: number;
}

export interface BodyIdentification {
  /** 本体とみなしたランの添字 */
  readonly runIndices: readonly number[];
  /** 本体の代表色 */
  readonly lab: LabColor;
  /** 本体が占める範囲（最初と最後の本体ランの外端） */
  readonly extent: { readonly start: number; readonly end: number };
}

const DEFAULT_EDGE_DELTA_E = 6;
const DEFAULT_MIN_RUN_LENGTH = 2;

/** 同じ色のランとみなす ΔE。本体ランをまとめるのに使う。 */
const DEFAULT_CLUSTER_DELTA_E = 8;

function medianLab(samples: readonly ProfileSample[]): LabColor {
  const pick = (select: (sample: ProfileSample) => number): number => {
    const values = samples.map(select).sort((a, b) => a - b);
    const mid = values.length >> 1;
    if (values.length % 2 === 1) return values[mid] as number;
    return ((values[mid - 1] as number) + (values[mid] as number)) / 2;
  };
  return { l: pick((s) => s.lab.l), a: pick((s) => s.lab.a), b: pick((s) => s.lab.b) };
}

/** プロファイルを色の切れ目でランに分割する。 */
export function splitRuns(
  profile: readonly ProfileSample[],
  options: SplitRunsOptions = {},
): ColorRun[] {
  const edgeDeltaE = options.edgeDeltaE ?? DEFAULT_EDGE_DELTA_E;
  const minRunLength = options.minRunLength ?? DEFAULT_MIN_RUN_LENGTH;
  if (profile.length === 0) return [];

  const runs: ColorRun[] = [];
  let current: ProfileSample[] = [profile[0] as ProfileSample];

  const flush = (): void => {
    if (current.length < minRunLength) {
      current = [];
      return;
    }
    runs.push({
      start: (current[0] as ProfileSample).x,
      end: (current[current.length - 1] as ProfileSample).x + 1,
      lab: medianLab(current),
    });
    current = [];
  };

  for (let index = 1; index < profile.length; index += 1) {
    const previous = profile[index - 1] as ProfileSample;
    const sample = profile[index] as ProfileSample;
    if (deltaE2000(previous.lab, sample.lab) > edgeDeltaE) flush();
    current.push(sample);
  }
  flush();

  return runs;
}

/**
 * ランの中から本体（背景ではなく抵抗器の地の色）を特定する。
 *
 * 本体は ROI の中で最も広い面積を占めるので、色が近いラン同士をまとめて
 * 合計幅が最大のグループを本体とする。基準色テーブルには依存しない。
 */
export function identifyBody(
  runs: readonly ColorRun[],
  clusterDeltaE = DEFAULT_CLUSTER_DELTA_E,
): BodyIdentification | null {
  if (runs.length === 0) return null;

  // 近い色のラン同士をまとめる（貪欲クラスタリング）
  const clusters: number[][] = [];
  runs.forEach((run, index) => {
    const match = clusters.find((cluster) =>
      deltaE2000(run.lab, (runs[cluster[0] as number] as ColorRun).lab) <= clusterDeltaE,
    );
    if (match === undefined) clusters.push([index]);
    else match.push(index);
  });

  const widthOf = (cluster: readonly number[]): number =>
    cluster.reduce((sum, index) => {
      const run = runs[index] as ColorRun;
      return sum + (run.end - run.start);
    }, 0);

  // 面積が同じなら ROI 中央に近い方を採る。水平化済みの ROI では
  // 抵抗器が中央に来るので、端に寄っているのは背景と考えてよい。
  const profileStart = (runs[0] as ColorRun).start;
  const profileEnd = (runs[runs.length - 1] as ColorRun).end;
  const middle = (profileStart + profileEnd) / 2;
  const distanceToMiddle = (cluster: readonly number[]): number =>
    Math.min(
      ...cluster.map((index) => {
        const run = runs[index] as ColorRun;
        return Math.abs((run.start + run.end) / 2 - middle);
      }),
    );

  const body = clusters.reduce((best, cluster) => {
    const gain = widthOf(cluster) - widthOf(best);
    if (gain !== 0) return gain > 0 ? cluster : best;
    return distanceToMiddle(cluster) < distanceToMiddle(best) ? cluster : best;
  });

  const first = runs[body[0] as number] as ColorRun;
  const last = runs[body[body.length - 1] as number] as ColorRun;

  return {
    runIndices: body,
    lab: medianLab(body.map((index) => ({ x: 0, lab: (runs[index] as ColorRun).lab }))),
    extent: { start: first.start, end: last.end },
  };
}
