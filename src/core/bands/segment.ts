import type { Band, ProfileSample } from '../../types.js';
import { classifyBandColor } from './classify.js';
import { DEFAULT_PALETTE, type Palette } from '../color/palette.js';
import { identifyBody, splitRuns, type ColorRun } from './runs.js';
import { deltaE76 } from '../color/colorSpace.js';

/**
 * 隣り合うランをまとめる ΔE の既定値。
 * 15 以上で頭打ち（15/20/26 いずれも 23 枚）なので、下限の 15 を採る。
 */
const DEFAULT_MERGE_DELTA_E = 20;

/** 読み取りに必要な最小バンド数。これを割ってまで端のランを落とさない。 */
const MIN_BANDS = 3;

export interface SegmentOptions {
  /** 隣接サンプルの ΔE がこれを超えたら切れ目とみなす */
  readonly edgeDeltaE?: number;
  /** これ未満の幅のランはノイズとして捨てる */
  readonly minBandWidth?: number;
  /** 同じ色のランとみなす ΔE（本体ランをまとめるのに使う） */
  readonly clusterDeltaE?: number;
  /**
   * 本体クラスタでの明度の重み。1 で素の CIE76。
   * 円筒の陰影で暗くなった本体を本体として拾うために下げる。
   */
  readonly bodyLightnessWeight?: number;
  /** バンド色の基準テーブル。較正結果を差し替えられる。 */
  readonly palette?: Palette;
  /**
   * 解析範囲の端に接するランも残すか。
   *
   * 読み取りでは捨てるのが正しい（本体の肩の照り返しを拾うため）。
   * ただし較正では逆で、余分なランは DP アライメントが飛ばせるが、
   * 落としたランは戻せない。取りこぼしを避けたい側だけ true にする。
   */
  readonly keepEdgeRuns?: boolean;
  /**
   * 隣り合うランをこの ΔE 未満ならまとめる。
   * バンドの縁のぼけや濃淡で 1 本のバンドが 2 本に割れるのを戻す。
   */
  readonly mergeDeltaE?: number;
}

/**
 * 本体を除いた「バンド候補」のランを取り出す（分類はしない）。
 *
 * 1. 色の切れ目でランに分割する
 * 2. 最も面積の大きいラン群を本体とみなす
 * 3. 本体以外のランを返す。ただし
 *    - 解析範囲の**端に接するランは捨てる**（下記）
 *    - 隣り合う同色のランはまとめる（下記）
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

  const body = identifyBody(runs, options.clusterDeltaE, options.bodyLightnessWeight);
  if (body === null) return [];

  // 端に接するランは捨てる。バンドの外側には必ず地の色があるので、
  // 解析範囲の端から始まるランは本体の肩の照り返しか、はみ出した背景。
  // 実測では先頭が「白」と読まれる誤りが 7 枚あり、その正体がこれだった。
  const bodyRuns = new Set(body.runIndices);
  const first = (runs[0] as ColorRun).start;
  const last = (runs[runs.length - 1] as ColorRun).end;
  const candidates = runs.filter((_, index) => !bodyRuns.has(index));
  const merged = mergeAdjacent(candidates, options.mergeDeltaE ?? DEFAULT_MERGE_DELTA_E);
  return options.keepEdgeRuns === true ? merged : trimEdgeRuns(merged, first, last);
}

/**
 * 解析範囲の端に接するランを落とす。
 *
 * バンドの外側には必ず地の色があるので、範囲の端から始まるランは本体の肩の
 * 照り返しか、はみ出した背景。実測では先頭が「白」と読まれる誤りが 7 枚あり、
 * その正体がこれだった。
 *
 * ただし**落とした結果 3 本を切るなら落とさない**。3 本は読み取りに必要な
 * 最小本数で、それを割ると読めなくなる。端に接していても本物のバンドで
 * あることはある（検出枠が本体にぴったりだと端のバンドが縁に触れる）。
 */
function trimEdgeRuns(runs: readonly ColorRun[], first: number, last: number): ColorRun[] {
  const trimmed = [...runs];
  while (trimmed.length > MIN_BANDS && (trimmed[0] as ColorRun).start <= first) trimmed.shift();
  while (
    trimmed.length > MIN_BANDS &&
    (trimmed[trimmed.length - 1] as ColorRun).end >= last
  ) {
    trimmed.pop();
  }
  return trimmed;
}

/**
 * 隣り合う同色のランをまとめる。
 *
 * 太いバンドは中で濃淡が出るため、ラン分割で 2 本に割れることがある
 * （37-10Mohm の茶バンドが L33 と L21 に割れていた）。割れたままだと
 * 本数が合わず、同時デコードが別の解釈に流れる。
 */
function mergeAdjacent(runs: readonly ColorRun[], mergeDeltaE: number): ColorRun[] {
  const merged: ColorRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      run.start - previous.end <= 1 &&
      deltaE76(run.lab, previous.lab) < mergeDeltaE
    ) {
      const total = previous.end - previous.start + (run.end - run.start);
      const wPrev = (previous.end - previous.start) / total;
      const wRun = 1 - wPrev;
      merged[merged.length - 1] = {
        start: previous.start,
        end: run.end,
        lab: {
          l: previous.lab.l * wPrev + run.lab.l * wRun,
          a: previous.lab.a * wPrev + run.lab.a * wRun,
          b: previous.lab.b * wPrev + run.lab.b * wRun,
        },
      };
      continue;
    }
    merged.push(run);
  }
  return merged;
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
