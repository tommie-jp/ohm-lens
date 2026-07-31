import type { Band, LabColor, ProfileSample } from '../../types.js';
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
  /**
   * ランの平均から明度だけがこれ以上離れたら切れ目とみなす。
   * ΔE では切れない金・銀を拾うための第二の基準（`runs.ts` の `splitRuns`）。
   */
  readonly lightnessMargin?: number;
  /** 同じ色のランとみなす ΔE（本体ランをまとめるのに使う） */
  readonly clusterDeltaE?: number;
  /**
   * 本体クラスタでの明度の重み。1 で素の CIE76。
   * 円筒の陰影で暗くなった本体を本体として拾うために下げる。
   */
  readonly bodyLightnessWeight?: number;
  /**
   * 前後のランよりこれ以上明度が凹んでいれば、陰影ではなくバンドとみなす。
   * 明度の緩和（`bodyLightnessWeight`）が金・銀を本体へ吸い込むのを防ぐ。
   */
  readonly bodyExtremumMargin?: number;
  /**
   * 凹みと判定したランを本体に取り込むときの、しきい値の絞り込み（0..1）。
   * 0 で「凹みは決して本体にしない」。金の凹みは本体との距離が 4〜11 と
   * 近すぎるため、0.85 程度の絞りでは吸収を防げない。
   */
  readonly bodyExtremumTolerance?: number;
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
 * ラン抽出の途中経過。
 *
 * 本数が合わないとき、**どの段でランが消えたか**が分からないと打ち手を選べない。
 * 「分割で切れていない」のと「本体に吸収された」のと「端として落とした」のでは
 * 直す場所がまるで違う（`scripts/scoreBoundaries.ts` で正解と突き合わせる）。
 */
export interface BandRunStages {
  /** 本体の代表色。特定できなければ null。金属容疑の判定（jointDecode）に使う */
  readonly bodyLab: LabColor | null;
  /** 色の切れ目で分割した直後（本体も含む） */
  readonly split: readonly ColorRun[];
  /** 本体クラスタを除いたもの */
  readonly afterBody: readonly ColorRun[];
  /** 隣り合う同色をまとめたもの */
  readonly merged: readonly ColorRun[];
  /** 端に接するランを落としたもの（＝{@link bandRuns} の返り値） */
  readonly trimmed: readonly ColorRun[];
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
  return [...bandRunStages(profile, options).trimmed];
}

/**
 * {@link bandRuns} と同じ処理を、段階ごとの途中経過つきで返す。
 *
 * **診断が本番と違う道を通らないよう、`bandRuns` はこれを呼ぶ実装にしてある。**
 * 診断用に処理を書き写すと、片方だけ直したときに測っているものがずれる。
 */
export function bandRunStages(
  profile: readonly ProfileSample[],
  options: SegmentOptions = {},
): BandRunStages {
  const runs = splitRuns(profile, {
    ...(options.edgeDeltaE === undefined ? {} : { edgeDeltaE: options.edgeDeltaE }),
    ...(options.minBandWidth === undefined ? {} : { minRunLength: options.minBandWidth }),
    ...(options.lightnessMargin === undefined ? {} : { lightnessMargin: options.lightnessMargin }),
  });

  const body = identifyBody(
    runs,
    options.clusterDeltaE,
    options.bodyLightnessWeight,
    options.bodyExtremumMargin,
    options.bodyExtremumTolerance,
  );
  if (body === null) {
    return { bodyLab: null, split: runs, afterBody: [], merged: [], trimmed: [] };
  }

  // 端に接するランは捨てる。バンドの外側には必ず地の色があるので、
  // 解析範囲の端から始まるランは本体の肩の照り返しか、はみ出した背景。
  // 実測では先頭が「白」と読まれる誤りが 7 枚あり、その正体がこれだった。
  const bodyRuns = new Set(body.runIndices);
  const first = (runs[0] as ColorRun).start;
  const last = (runs[runs.length - 1] as ColorRun).end;
  const afterBody = runs.filter((_, index) => !bodyRuns.has(index));
  const merged = mergeAdjacent(afterBody, options.mergeDeltaE ?? DEFAULT_MERGE_DELTA_E);
  const trimmed = options.keepEdgeRuns === true ? merged : trimEdgeRuns(merged, first, last);
  return { bodyLab: body.lab, split: runs, afterBody, merged, trimmed };
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
  return toBands(bandRuns(profile, options), options.palette ?? DEFAULT_PALETTE);
}

/**
 * ランの列をバンドに分類する。
 *
 * `segmentBands` と分けてあるのは、拾い直し（`recoverToleranceRun`）を通した
 * あとのランから作る必要があるため。分割を 2 度走らせると本数がずれる。
 */
export function toBands(runs: readonly ColorRun[], palette: Palette): Band[] {
  return runs.map((run) => toBand(run, palette));
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
