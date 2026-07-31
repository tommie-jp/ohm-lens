import type { BandColor, LabColor, ProfileSample } from '../../types.js';
import type { OrientedBox } from '../locate.js';

/**
 * バンド境界の正解データ。
 *
 * 位置は**検出した箱の長手方向の %**（左端 0%、右端 100%）。ROI は本体の
 * 外側に余白を取って切り出すので、区間は 0% の手前や 100% の先にも出る。
 *
 * 単位を % にしたのは、焼き込み画像の X 軸がこの目盛りだから。グラフを見て
 * 読んだ数字をそのまま書き直せる。ただし % の基準である箱は検出器の推定なので、
 * **箱も一緒に記録する**。検出器を直したときに元画像座標へ戻して再投影できる。
 *
 * 境界点の羅列ではなく区間で持つ。色列と 1 対 1 になるので、本数の食い違いが
 * その場で分かり、区間の隙間が本体を表す。
 *
 * 設計の経緯は `docs/13-バンド境界の検出指標.md` §7。
 */

/** バンド 1 本の占める区間 [%]。 */
export interface BandInterval {
  /** 分かっていれば色。デコーダが捨てたランなどは null */
  readonly color: BandColor | null;
  readonly start: number;
  readonly end: number;
}

/** 1 枚ぶんの正解。 */
export interface BoundaryLabel {
  /** 人が確認したか。false のままの値は種（推定値）なので信用しない */
  readonly verified: boolean;
  /** % の基準にした検出ボックス */
  readonly box: OrientedBox;
  readonly bands: readonly BandInterval[];
}

/** ファイル名 → 正解。 */
export type BoundaryLabels = Record<string, BoundaryLabel>;

/**
 * サンプル添字を長手方向の % に写す。
 *
 * ROI は箱の長さの `padding` 倍を両側に足して切り出すので、添字 0 は
 * `-padding×100`%、最後の添字は `100 + padding×100`% にあたる。
 */
export function alongPercentAt(index: number, count: number, padding: number): number {
  if (count <= 1) return 0;
  return ((index / (count - 1)) * (1 + padding * 2) - padding) * 100;
}

/** {@link alongPercentAt} の逆。% を ROI 内の位置の割合 0..1 に戻す。 */
export function fractionAtPercent(percent: number, padding: number): number {
  return (percent / 100 + padding) / (1 + padding * 2);
}

/**
 * ランを % 区間に変換して種を作る。
 *
 * % は整数に丸める。ROI の列数は実測で 86〜250、X 軸が映すのは 156% ぶんなので
 * 1 サンプルが 0.6〜1.8% にあたる。小数まで持っても元データの分解能を超える。
 */
export function intervalsFromRuns(
  runs: readonly { readonly start: number; readonly end: number }[],
  count: number,
  padding: number,
  colors: readonly BandColor[],
): BandInterval[] {
  return runs.map((run, index) => ({
    color: colors[index] ?? null,
    start: Math.round(alongPercentAt(run.start, count, padding)),
    end: Math.round(alongPercentAt(run.end, count, padding)),
  }));
}

/**
 * 種を既存の正解に混ぜる。
 *
 * - `verified: true` は上書きしない（人が直した値を機械が壊さない）
 * - 種に無いエントリは消さない（検体を消しても、直した正解は残す）
 */
export function mergeSeeds(existing: BoundaryLabels, seeds: BoundaryLabels): BoundaryLabels {
  const merged: BoundaryLabels = { ...existing };
  for (const [file, seed] of Object.entries(seeds)) {
    const current = existing[file];
    if (current?.verified === true) continue;
    merged[file] = seed;
  }
  return merged;
}

/** 境界の一致の集計。 */
export interface BoundaryScore {
  /** 許容差の内側で対応が付いた境界の数 */
  readonly matched: number;
  /** 正解にあって検出に無い境界 */
  readonly missed: number;
  /** 検出にあって正解に無い境界 */
  readonly spurious: number;
  /** 対応が付いた境界の平均ずれ [%] */
  readonly meanError: number;
}

/** 区間の端を境界点の列にする（重複は残す。割れを余分として数えるため）。 */
function edgesOf(intervals: readonly BandInterval[]): number[] {
  return intervals.flatMap((interval) => [interval.start, interval.end]).sort((a, b) => a - b);
}

/**
 * 検出した境界と正解の一致を数える。
 *
 * 正解 1 本につき検出 1 本まで。近い順に取り合うのではなく、正解を順に見て
 * 「未使用でいちばん近い検出」を割り当てる貪欲法。細かく割れた検出が 1 本の
 * 正解に二重に当たらないようにするため。
 */
export function scoreBoundaries(
  detected: readonly BandInterval[],
  truth: readonly BandInterval[],
  tolerancePercent: number,
): BoundaryScore {
  const detectedEdges = edgesOf(detected);
  const truthEdges = edgesOf(truth);
  const used = new Set<number>();
  const errors: number[] = [];

  for (const edge of truthEdges) {
    let bestIndex = -1;
    let bestError = Number.POSITIVE_INFINITY;
    detectedEdges.forEach((candidate, index) => {
      if (used.has(index)) return;
      const error = Math.abs(candidate - edge);
      if (error < bestError) {
        bestError = error;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestError <= tolerancePercent) {
      used.add(bestIndex);
      errors.push(bestError);
    }
  }

  const matched = errors.length;
  return {
    matched,
    missed: truthEdges.length - matched,
    spurious: detectedEdges.length - matched,
    meanError:
      errors.length === 0 ? 0 : errors.reduce((sum, error) => sum + error, 0) / errors.length,
  };
}

/** バンド単位の一致の集計。 */
export interface BandScore {
  /** 正解と対応が付いた検出の数 */
  readonly matched: number;
  /** 正解にあって検出に無いバンド */
  readonly missed: number;
  /** 正解に対応しない検出 */
  readonly spurious: number;
}

/** 2 つの区間の重なり具合（IoU）。 */
export function intervalIou(
  a: { readonly start: number; readonly end: number },
  b: { readonly start: number; readonly end: number },
): number {
  const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union <= 0 ? 0 : intersection / union;
}

/**
 * 検出したバンドと正解を**本数で**突き合わせる。
 *
 * {@link scoreBoundaries} は境界「点」の近さで測るので、本体を丸ごと覆う 1 本の
 * 巨大なランでも、その端がたまたま正解の端に近ければ一致に数えてしまう。
 * ラン数が合っているかを見たいときは区間の重なり（IoU）で測る必要がある。
 *
 * 正解 1 本につき検出 1 本まで。いちばん重なる検出を割り当てるので、
 * 割れた検出が 1 本の正解に二重に当たらない。
 */
export function scoreBands(
  detected: readonly BandInterval[],
  truth: readonly BandInterval[],
  minIou: number,
): BandScore {
  const used = new Set<number>();

  for (const band of truth) {
    let bestIndex = -1;
    let bestIou = minIou;
    detected.forEach((candidate, index) => {
      if (used.has(index)) return;
      const overlap = intervalIou(candidate, band);
      if (overlap >= bestIou) {
        bestIou = overlap;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) used.add(bestIndex);
  }

  return {
    matched: used.size,
    missed: truth.length - used.size,
    spurious: detected.length - used.size,
  };
}

/**
 * 正解の区間から、その色の実測 Lab を取り出す。
 *
 * 較正はこれまで「このランはどの色か」を DP の対応付けで**推測**していた。
 * 推測が外れると誤った色が基準色に混ざる（金が本体に吸収されてランが無いのに
 * 割り当てられ、白背景のランが金として学習されていた例がある。`docs/09` §1）。
 * 位置が確定していれば推測が要らない。
 *
 * 区間の中の中央値を採る。平均だと縁のぼけを巻き込むため。
 *
 * @param profile ROI 全体の 1D プロファイル（色順応補正後）
 * @param bands 正解の区間 [%]
 * @param padding ROI が本体の外側に取っている余白の割合
 */
export function labelledSamples(
  profile: readonly ProfileSample[],
  bands: readonly BandInterval[],
  padding: number,
): { color: BandColor; lab: LabColor; width: number }[] {
  if (profile.length === 0) return [];

  const indexAt = (percent: number): number =>
    Math.round(fractionAtPercent(percent, padding) * (profile.length - 1));

  const samples: { color: BandColor; lab: LabColor; width: number }[] = [];
  for (const band of bands) {
    if (band.color === null) continue;
    const from = Math.max(0, indexAt(band.start));
    const to = Math.min(profile.length - 1, indexAt(band.end));
    if (to < from) continue;
    // 区間がまるごとプロファイルの外なら、切り詰められて端に潰れている
    if (indexAt(band.end) < 0 || indexAt(band.start) > profile.length - 1) continue;

    const inside = profile.slice(from, to + 1);
    if (inside.length === 0) continue;
    const pick = (get: (lab: LabColor) => number): number => {
      const values = inside.map((sample) => get(sample.lab)).sort((x, y) => x - y);
      return values[Math.floor((values.length - 1) / 2)] as number;
    };
    samples.push({
      color: band.color,
      lab: { l: pick((c) => c.l), a: pick((c) => c.a), b: pick((c) => c.b) },
      width: to - from + 1,
    });
  }
  return samples;
}

/** % の基準がずれていないとみなす許容差（箱の長さに対する割合）。 */
const BOX_TOLERANCE = 0.05;

/**
 * 正解を記録したときの箱と、今の箱が同じとみなせるか。
 *
 * % は箱の長さを 100% とした相対位置なので、箱が動くと同じ物理的な境界が
 * 別の % に移る。ずれていたら、その正解は今の検出には使えない。
 */
export function boxMatches(recorded: OrientedBox, current: OrientedBox): boolean {
  const scale = Math.max(1e-6, recorded.length);
  const shift = Math.hypot(current.centerX - recorded.centerX, current.centerY - recorded.centerY);
  const stretch = Math.abs(current.length - recorded.length);
  return shift / scale < BOX_TOLERANCE && stretch / scale < BOX_TOLERANCE;
}
