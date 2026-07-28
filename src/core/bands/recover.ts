import type { LabColor, ProfileSample } from '../../types.js';
import { deltaE76 } from '../color/colorSpace.js';
import { medianInPlace } from '../math.js';
import type { ColorRun } from './runs.js';

/**
 * 見つからなかった許容差バンド（4 本目）を、位置を絞って拾い直す。
 *
 * 実測では金・銀の許容差バンドが**規則的に消える**。人手ラベルのある 35 枚のうち
 * 31 枚が「ラン 3 本 / バンド 4 本」で、不足はきっかり 1 本だった
 * （`docs/11-金銀バンドが読めない理由.md`）。金は本体と色相が同じで明度しか
 * 違わないため、全体に効く `edgeΔE` を下げて拾おうとすると、他の写真で
 * 陰影を拾って過分割になる。
 *
 * **どこを探すか分かっていれば、全体より弱い基準を使ってよい。** 3 本しか
 * 見つからず、その 3 本目が本体のほぼ中央にあるなら、残りは進行方向の先にある。
 * 等間隔性から距離も絞れる。そこだけを本体色との差で走査する。
 */

/** 3 本目が本体のこの範囲にあるときだけ 4 本目を探す（本体長に対する割合）。 */
const CENTER_MIN = 0.4;
const CENTER_MAX = 0.6;

/**
 * 3 本目からどれだけ先を探すか（バンド間隔に対する倍率）。
 * 許容差バンドは他より離して印刷されるので 1 倍より先に来る。
 */
const SEARCH_FROM = 1;
const SEARCH_TO = 2;

/**
 * 本体色との差がこれを超えたらバンドの一部とみなす（CIE76）。
 *
 * 全体のラン分割（既定 20）より**意図的に低い**。位置を絞ったうえでの
 * 判定なので、緩めても他の写真を壊さない。
 */
const RECOVER_DELTA_E = 9;

/** 拾い直したランの最小幅。これ未満はノイズとして捨てる。 */
const MIN_WIDTH = 2;

/** 2 本しか出なかったときに、刻みの何倍先まで探すか。 */
const PAIR_STEPS = [1, 2] as const;

/** 予測位置のまわりを探す窓の半幅（刻みに対する割合）。 */
const PAIR_WINDOW = 0.5;

export interface RecoverOptions {
  /** 本体色との差のしきい値（CIE76）。 */
  readonly deltaE?: number;
}

/** サンプル群の Lab 成分別中央値。 */
function medianLab(samples: readonly ProfileSample[]): LabColor {
  const l = Float64Array.from(samples, (s) => s.lab.l);
  const a = Float64Array.from(samples, (s) => s.lab.a);
  const b = Float64Array.from(samples, (s) => s.lab.b);
  return { l: medianInPlace(l), a: medianInPlace(a), b: medianInPlace(b) };
}

/** ランの中心位置。 */
function centerOf(run: ColorRun): number {
  return (run.start + run.end) / 2;
}

/**
 * 3 本しか見つからなかったとき、4 本目（許容差バンド）を探して足す。
 *
 * 条件を満たさなければ入力をそのまま返す。**見つからなければ何もしない**のが
 * 正しい振る舞いで、無理に 4 本目を作ると誤読を増やす。
 *
 * @param profile 解析範囲の 1D プロファイル（色順応補正済み）
 * @param runs バンド候補のラン（位置順）
 */
export function recoverToleranceRun(
  profile: readonly ProfileSample[],
  runs: readonly ColorRun[],
  options: RecoverOptions = {},
): readonly ColorRun[] {
  if (runs.length !== 3 || profile.length === 0) return runs;

  const first = runs[0] as ColorRun;
  const third = runs[2] as ColorRun;
  const start = (profile[0] as ProfileSample).x;
  const end = (profile[profile.length - 1] as ProfileSample).x + 1;
  const length = end - start;
  if (length <= 0) return runs;

  // 3 本目が本体のほぼ中央にあるときだけ（＝先にまだ場所が残っているとき）
  const position = (centerOf(third) - start) / length;
  if (position < CENTER_MIN || position > CENTER_MAX) return runs;

  // 1 本目から 3 本目までの平均間隔。許容差バンドはこの 1〜2 倍先にある
  const pitch = (centerOf(third) - centerOf(first)) / 2;
  if (pitch <= 0) return runs;

  const from = centerOf(third) + pitch * SEARCH_FROM;
  const to = centerOf(third) + pitch * SEARCH_TO;

  // 本体色は「どのランにも属さない列」の中央値
  const covered = new Set<number>();
  for (const run of runs) for (let x = run.start; x < run.end; x += 1) covered.add(x);
  const bodySamples = profile.filter((sample) => !covered.has(sample.x));
  if (bodySamples.length === 0) return runs;
  const body = medianLab(bodySamples);

  const found = scanForRun(profile, body, from, to, options.deltaE ?? RECOVER_DELTA_E);
  if (found === null) return runs;

  return [...runs, found];
}

/**
 * 探索窓のなかで、本体色から最も長く離れている連続区間をランとして返す。
 * 見つからなければ null。
 */
function scanForRun(
  profile: readonly ProfileSample[],
  body: LabColor,
  from: number,
  to: number,
  threshold: number,
): ColorRun | null {
  const window = profile.filter((sample) => sample.x >= from && sample.x <= to);
  if (window.length === 0) return null;

  let best: { start: number; end: number } | null = null;
  let current: { start: number; end: number } | null = null;
  for (const sample of window) {
    if (deltaE76(sample.lab, body) >= threshold) {
      current =
        current === null
          ? { start: sample.x, end: sample.x + 1 }
          : { start: current.start, end: sample.x + 1 };
      const span = current.end - current.start;
      if (best === null || span > best.end - best.start) best = current;
    } else {
      current = null;
    }
  }

  if (best === null || best.end - best.start < MIN_WIDTH) return null;

  const span = best;
  const samples = profile.filter((sample) => sample.x >= span.start && sample.x < span.end);
  if (samples.length === 0) return null;

  return { start: span.start, end: span.end, lab: medianLab(samples) };
}

/** どのランにも属さない列の中央値を本体色とみなす。 */
function bodyColorOutside(
  profile: readonly ProfileSample[],
  runs: readonly ColorRun[],
): LabColor | null {
  const covered = new Set<number>();
  for (const run of runs) for (let x = run.start; x < run.end; x += 1) covered.add(x);
  const outside = profile.filter((sample) => !covered.has(sample.x));
  return outside.length === 0 ? null : medianLab(outside);
}

/**
 * ランが 2 本しか出なかったとき、その先を刻みで探して足す。
 *
 * `recoverToleranceRun` は「足しても値が変わらない位置」＝許容差バンドに
 * 限って拾い直す。位置からの推測を格子に一般化すると、数字・倍率バンドを
 * 挿入して値が直接変わるため悪化する（`docs/11` §3.5.1）。
 *
 * **2 本のときだけは、その制約が当てはまらない。** 2 本では `MIN_BANDS` に
 * 届かず読み取り不能なので、既に正しく読めている写真を壊しようがない。
 * 増えるのは「読取不可 → 値が出る」だけで、下振れは確信度で止められる。
 *
 * 実測では 02-1.5Ω と 04-4.7Ω がこれに当たる。どちらも金が**倍率**バンドで、
 * 本体との CIE76 が 18 前後 — 全体のラン分割のしきい値 20 に届かず、
 * 本体ランに飲み込まれている。位置を絞れば弱い基準で拾える。
 *
 * @param profile 解析範囲の 1D プロファイル（色順応補正済み）
 * @param runs バンド候補のラン（位置順、2 本のときだけ働く）
 */
export function recoverFromPair(
  profile: readonly ProfileSample[],
  runs: readonly ColorRun[],
  options: RecoverOptions = {},
): readonly ColorRun[] {
  if (runs.length !== 2 || profile.length === 0) return runs;

  const first = runs[0] as ColorRun;
  const second = runs[1] as ColorRun;
  const pitch = centerOf(second) - centerOf(first);
  if (pitch <= 0) return runs;

  const end = (profile[profile.length - 1] as ProfileSample).x + 1;
  // 刻み 1 つぶんの余地が先に無ければ、そもそも探す場所が無い
  if (centerOf(second) + pitch >= end) return runs;

  const body = bodyColorOutside(profile, runs);
  if (body === null) return runs;

  const threshold = options.deltaE ?? RECOVER_DELTA_E;
  const half = pitch * PAIR_WINDOW;
  const added: ColorRun[] = [];
  for (const step of PAIR_STEPS) {
    const center = centerOf(second) + pitch * step;
    const found = scanForRun(profile, body, center - half, center + half, threshold);
    // 直前に拾ったランと重なるものは同じバンドなので採らない
    const previous = added[added.length - 1];
    if (found === null || (previous !== undefined && found.start < previous.end)) continue;
    added.push(found);
  }

  return added.length === 0 ? runs : [...runs, ...added];
}
