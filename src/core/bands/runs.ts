import type { LabColor, ProfileSample } from '../../types.js';
import { deltaE76 } from '../color/colorSpace.js';

/**
 * 1D カラープロファイルを「色が続く区間（ラン）」に分割する。
 *
 * **分類より先にランを切る**のが要点。画素ごとに最近傍色へ分類してから
 * 同じ色をまとめると、茶/赤のような紛らわしい色でバンド内の分類が揺れ、
 * 1 本のバンドが細切れになって消えてしまう。色差だけで切れ目を決めれば、
 * 分類の曖昧さはランの中に閉じ込められる。
 *
 * 切れ目の判定は「隣接サンプルとの差」ではなく「**いま伸ばしているランの
 * 平均色との差**」で行う。バンドの境界はぼけているため、隣接差分では
 * どのステップも閾値に届かず、境界をまたいで 1 本に融合してしまう。
 * ラン平均と比べれば、ぼけの途中で累積のずれが閾値を超えて切れる。
 *
 * 本体色も「基準テーブルとの絶対距離」ではなく「最も面積の大きいラン群」
 * として決めるので、ベージュでも水色でも緑でも同じ仕組みで扱える。
 *
 * 距離は **CIE76（Lab のユークリッド距離）** を使う。ΔE2000 は高彩度域の
 * 差を圧縮するため、本体ベージュと金バンドのように彩度だけが違う組を
 * 「同じ色」と判定してしまい、バンドが本体に吸収されてしまう。
 */

export interface ColorRun {
  /** 開始インデックス（含む） */
  readonly start: number;
  /** 終了インデックス（含まない） */
  readonly end: number;
  /** 構成サンプルの Lab 中央値 */
  readonly lab: LabColor;
  /**
   * 位置からの推測で中間に挿入したラン（`bands/recover.ts` の
   * `recoverFromGap`）。デコーダは金・銀に限って解釈する。
   *
   * 本体ランに飲み込まれるほど本体色に近かったものなので、金・銀か肩の
   * 照り返し以外ではありえない。数字として読ませると桁が直接壊れる。
   */
  readonly metallicOnly?: boolean;
}

export interface SplitRunsOptions {
  /** 隣接サンプルの ΔE がこれを超えたら切れ目とみなす */
  readonly edgeDeltaE?: number;
  /** これ未満の長さのランはノイズとして捨てる */
  readonly minRunLength?: number;
  /**
   * ランの平均から**明度だけ**がこれ以上離れたら切れ目とみなす。
   *
   * 金・銀のバンドは本体と色相が同じで明度だけ違うため、ΔE の切れ目には
   * かからない。本体との ΔE76 は実測 4〜11 で `edgeDeltaE` の 20 に遠く届かず、
   * **ランとして切られないまま本体に溶けていた**（人手で確定した 21 枚・
   * バンド 89 本で、失われた 15 本のうち 14 本が分割の段階で消え、13 本が金）。
   *
   * **既定は無効。有効にすると分割は直るが誤答が増える**（`docs/13` §11）。
   * 掃引で使う値は `core/settings.ts` が渡す。
   */
  readonly lightnessMargin?: number;
}

export interface BodyIdentification {
  /** 本体とみなしたランの添字 */
  readonly runIndices: readonly number[];
  /** 本体の代表色 */
  readonly lab: LabColor;
  /** 本体が占める範囲（最初と最後の本体ランの外端） */
  readonly extent: { readonly start: number; readonly end: number };
}

const DEFAULT_EDGE_DELTA_E = 9;
const DEFAULT_MIN_RUN_LENGTH = 2;

/** 明度による切れ目の既定。無効（実測で決めた値は `core/settings.ts` が渡す）。 */
const DEFAULT_LIGHTNESS_MARGIN = Number.POSITIVE_INFINITY;

/** 同じ色のランとみなす ΔE。本体ランをまとめるのに使う。 */
const DEFAULT_CLUSTER_DELTA_E = 18;

/** 本体クラスタでの明度の重み。1 なら素の CIE76。 */
const DEFAULT_BODY_LIGHTNESS_WEIGHT = 1;

/**
 * 前後のランに対してこれ以上明度が凹んで（盛り上がって）いれば、
 * 陰影ではなくバンドとみなす。実測で決めた値は `core/settings.ts` が渡す。
 */
const DEFAULT_LIGHTNESS_EXTREMUM_MARGIN = 12;

/**
 * 凹凸のあるランを本体に取り込むときの、しきい値の絞り込み。
 *
 * 0.85 では**絞りが足りない**。金の凹みは本体との距離が 4〜11 しかなく、
 * 0.85 × clusterΔE24 = 20.4 より依然近いため吸収されたままだった
 * （凹みとして検出できても本数が 1 本も増えなかった理由）。
 * 実測で決めた値は `core/settings.ts` が渡す。
 */
const DEFAULT_EXTREMUM_CLUSTER_TOLERANCE = 0.85;

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
  const lightnessMargin = options.lightnessMargin ?? DEFAULT_LIGHTNESS_MARGIN;
  if (profile.length === 0) return [];

  const runs: ColorRun[] = [];
  let current: ProfileSample[] = [];
  // 伸ばしているランの平均色。逐次更新して切れ目の判定に使う。
  let sum = { l: 0, a: 0, b: 0 };

  const mean = (): LabColor => ({
    l: sum.l / current.length,
    a: sum.a / current.length,
    b: sum.b / current.length,
  });

  const push = (sample: ProfileSample): void => {
    current.push(sample);
    sum = { l: sum.l + sample.lab.l, a: sum.a + sample.lab.a, b: sum.b + sample.lab.b };
  };

  const flush = (): void => {
    if (current.length >= minRunLength) {
      runs.push({
        start: (current[0] as ProfileSample).x,
        end: (current[current.length - 1] as ProfileSample).x + 1,
        lab: medianLab(current),
      });
    }
    current = [];
    sum = { l: 0, a: 0, b: 0 };
  };

  for (const sample of profile) {
    if (current.length > 0) {
      const reference = mean();
      // 色が変わったか、明度だけが離れたか。金・銀は後者でしか捕まらない。
      const cut =
        deltaE76(sample.lab, reference) > edgeDeltaE ||
        Math.abs(sample.lab.l - reference.l) > lightnessMargin;
      if (cut) flush();
    }
    push(sample);
  }
  flush();

  return runs;
}

/**
 * 本体クラスタの距離。明度の重みを下げた CIE76。
 *
 * 抵抗器は円筒なので、同じ地の色でも端に向かって暗くなる。実写 39 枚では
 * 本体ランの L\* が中央値で 15、最大 25 ばらついていた。素の CIE76 だと
 * その陰の部分が別クラスタになり、バンドとして数えられて本数が狂う。
 * 色相・彩度は陰でもほとんど変わらないので、明度だけ効きを弱める。
 */
function bodyDistance(a: LabColor, b: LabColor, lightnessWeight: number): number {
  return Math.hypot((a.l - b.l) * lightnessWeight, a.a - b.a, a.b - b.b);
}

/** 色度（a\*b\*）だけの距離。明度を無視して「同じ色みか」を見る。 */
function chromaDistance(a: LabColor, b: LabColor): number {
  return Math.hypot(a.a - b.a, a.b - b.b);
}

/**
 * 本体色の連なりの中で、明度だけが凹んでいる（盛り上がっている）ランか。
 *
 * 金・銀のバンドは本体と**色相が同じで明度だけ違う**。円筒の陰影も同じなので、
 * 色だけでは分けられない（02 では本体 L68 a13 b22 に対し金 L51 a14 b20）。
 * 違いは形で、陰影は端へ向かって単調に変わるのに対し、バンドは局所的に凹む。
 *
 * ただし**前後が本体色であること**を条件にする。これが無いと、色バンドに
 * 挟まれた本体（茶・本体・茶）まで「盛り上がり」とみなして外してしまう。
 */
function isBodyLightnessExtremum(
  runs: readonly ColorRun[],
  index: number,
  seedLab: LabColor,
  clusterDeltaE: number,
  extremumMargin: number,
): boolean {
  const previous = runs[index - 1];
  const next = runs[index + 1];
  // 端のランは前後が揃わないので判定しない（陰影として扱う）
  if (previous === undefined || next === undefined) return false;
  if (
    chromaDistance(previous.lab, seedLab) > clusterDeltaE ||
    chromaDistance(next.lab, seedLab) > clusterDeltaE
  ) {
    return false;
  }

  const fromPrevious = (runs[index] as ColorRun).lab.l - previous.lab.l;
  const fromNext = (runs[index] as ColorRun).lab.l - next.lab.l;
  return (
    (fromPrevious < -extremumMargin && fromNext < -extremumMargin) ||
    (fromPrevious > extremumMargin && fromNext > extremumMargin)
  );
}

/**
 * ランの中から本体（背景ではなく抵抗器の地の色）を特定する。
 *
 * 本体は ROI の中で最も広い面積を占めるので、色が近いラン同士をまとめて
 * 合計幅が最大のグループを本体とする。基準色テーブルには依存しない。
 *
 * @param lightnessWeight 本体クラスタでの明度の重み。1 で従来どおり。
 * @param extremumMargin 前後よりこれ以上明度が凹んでいればバンドとみなす
 */
export function identifyBody(
  runs: readonly ColorRun[],
  clusterDeltaE = DEFAULT_CLUSTER_DELTA_E,
  lightnessWeight = DEFAULT_BODY_LIGHTNESS_WEIGHT,
  extremumMargin = DEFAULT_LIGHTNESS_EXTREMUM_MARGIN,
  extremumTolerance = DEFAULT_EXTREMUM_CLUSTER_TOLERANCE,
): BodyIdentification | null {
  if (runs.length === 0) return null;

  // 近い色のラン同士をまとめる（貪欲クラスタリング）
  const clusters: number[][] = [];
  runs.forEach((run, index) => {
    const match = clusters.find(
      (cluster) =>
        bodyDistance(run.lab, (runs[cluster[0] as number] as ColorRun).lab, lightnessWeight) <=
        clusterDeltaE,
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

  const seed = clusters.reduce((best, cluster) => {
    const gain = widthOf(cluster) - widthOf(best);
    if (gain !== 0) return gain > 0 ? cluster : best;
    return distanceToMiddle(cluster) < distanceToMiddle(best) ? cluster : best;
  });

  // 代表色を決めてから取り込み直す。貪欲クラスタリングはクラスタの先頭と
  // 比べるので、明るい端から暗い端へ段階的に変わる本体を取りこぼす。
  // 代表色と比べれば、どちらの端からでも同じ結果になる。
  const seedLab = medianLab(seed.map((index) => ({ x: 0, lab: (runs[index] as ColorRun).lab })));
  const body = runs
    .map((_, index) => index)
    .filter((index) => {
      // 明度が局所的に凹んでいるランは陰影ではないので、明度の緩和を効かせない
      const extremum = isBodyLightnessExtremum(runs, index, seedLab, clusterDeltaE, extremumMargin);
      return (
        bodyDistance((runs[index] as ColorRun).lab, seedLab, extremum ? 1 : lightnessWeight) <=
        clusterDeltaE * (extremum ? extremumTolerance : 1)
      );
    });

  const first = runs[body[0] as number] as ColorRun;
  const last = runs[body[body.length - 1] as number] as ColorRun;

  return {
    runIndices: body,
    lab: medianLab(body.map((index) => ({ x: 0, lab: (runs[index] as ColorRun).lab }))),
    extent: { start: first.start, end: last.end },
  };
}
