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

/**
 * 中間への挿入を試すランの本数の下限。
 *
 * 「他より広い」を言うには比べる相手が要る。ラン 3 本では間隔が 2 つしかなく、
 * 中央値が最大値と一致してしまって比較にならない。4 本＝間隔 3 つが下限。
 */
const GAP_MIN_RUNS = 4;

/**
 * 中間への挿入を試すランの本数の上限。
 *
 * 軸形抵抗器のバンドは最大 6 本。すでに 6 本以上出ているなら、症状は
 * 「不足」ではなく「過分割」で、足すのは筋が違う（実測 `07-10Ω` は
 * カーペットの模様を拾って 8 本に割れており、挿入は雑音を増やすだけだった）。
 */
const GAP_MAX_RUNS = 5;

/** 最大の間隔が他の間隔の中央値のこの倍率を超えたら「異常に広い」とみなす。 */
const GAP_RATIO = 1.8;

/**
 * 挿入するランの幅の上限（既存のランの幅の中央値に対する倍率）。
 *
 * バンドは隣のバンドと同じくらいの太さで印刷される。それより極端に太い区間は
 * 本体の陰か肩の照り返しで、バンドではない。実測でも本物の挿入は中央値の
 * 0.33〜0.50 倍だったのに対し、誤った挿入（`09-82Ω`）は 3.00 倍だった。
 */
const GAP_WIDTH_RATIO = 1.5;

/**
 * 間隔の内側を探す割合。
 *
 * 両隣のバンドの縁は必ずぼけていて、本体色から大きく外れる。端まで探すと
 * その縁を拾ってしまうので、間隔の中央だけを見る。
 */
const GAP_WINDOW = 0.6;

/**
 * 間隔の中で本体色から離れているとみなす差（CIE76）。
 *
 * 平坦な本体の上を探す他の 2 つ（`core/settings.ts` が実効値 **3** を渡す）
 * より**高く**する。バンドに挟まれた間隔はぼけの傾斜が残っていて、低い
 * しきい値では傾斜そのものが連続区間として出てしまい、幅が本物のバンドより
 * 広くなる。しきい値の性質が違うので `RecoverOptions.deltaE` とは分ける。
 */
const GAP_DELTA_E = 9;

export interface RecoverOptions {
  /**
   * 本体色との差のしきい値（CIE76）。
   *
   * 効くのは平坦な本体の上を探す {@link recoverToleranceRun} と
   * {@link recoverFromPair} だけで、{@link recoverFromGap} は
   * {@link GAP_DELTA_E} を使う（探す場所の性質が違うため）。
   */
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

  const body = bodyColorOutside(profile, runs);
  if (body === null) return runs;

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

/**
 * 隣接する間隔が 1 つだけ異常に広いとき、そこに見落としたバンドがあるとみて
 * 拾い直す。
 *
 * `recoverToleranceRun` は末尾にしか足さないので値が変わらないが、こちらは
 * **数字・倍率の位置に挿入する**ので値が直接変わる。位置からの推測を格子に
 * 一般化して内挿する案は正解 27 → 25 に落ちた（`docs/11` §3.5.1）。同じ刃を
 * 持つ施策なので、次の 2 段で縛る。
 *
 * 1. **発火を絞る** — 他の間隔の中央値の {@link GAP_RATIO} 倍を超える間隔が
 *    1 つだけあり、かつその中央に本体色から離れた区間が実在するときだけ
 * 2. **数字に化けさせない** — 挿入したランに `metallicOnly` の印をつける。
 *    デコーダはこれを金・銀に限り、タダで捨てられる扱いにする
 *    （`value/jointDecode.ts`）。本体ランに飲み込まれるほど本体に近かった
 *    以上、金・銀か肩の照り返し以外ではありえない
 *
 * 実測の対象は `01-1ohm`（5 本帯の倍率の銀が本体に溶けて 4 本になり、
 * 間隔が 23.5 / 12 / 11.5 と最初だけ 2 倍開いていた）。
 *
 * しきい値は外から差せない。`RecoverOptions.deltaE` は平坦な本体の上を探す
 * 前提で決めた値で、ぼけの傾斜が残る間隔の内側にはそのまま使えないため。
 *
 * @param profile 解析範囲の 1D プロファイル（色順応補正済み）
 * @param runs バンド候補のラン（位置順）
 */
export function recoverFromGap(
  profile: readonly ProfileSample[],
  runs: readonly ColorRun[],
): readonly ColorRun[] {
  if (runs.length < GAP_MIN_RUNS || runs.length > GAP_MAX_RUNS || profile.length === 0) {
    return runs;
  }

  const centers = runs.map(centerOf);
  const gaps = centers.slice(1).map((center, index) => center - (centers[index] as number));
  const widest = gaps.indexOf(Math.max(...gaps));

  // 最大を除いた間隔の中央値と比べる。最大自身を含めると比が鈍る
  const others = gaps.filter((_, index) => index !== widest);
  const median = medianInPlace(Float64Array.from(others));
  if (median <= 0) return runs;
  if ((gaps[widest] as number) / median < GAP_RATIO) return runs;

  const before = runs[widest] as ColorRun;
  const after = runs[widest + 1] as ColorRun;
  const inner = after.start - before.end;
  if (inner <= 0) return runs;

  const body = bodyColorOutside(profile, runs);
  if (body === null) return runs;

  const middle = (before.end + after.start) / 2;
  const half = (inner * GAP_WINDOW) / 2;
  const found = scanForRun(profile, body, middle - half, middle + half, GAP_DELTA_E);
  if (found === null) return runs;

  // バンドは隣のバンドと同じくらいの太さ。極端に太ければ本体か肩の照り返し
  const widthMedian = medianInPlace(Float64Array.from(runs, (run) => run.end - run.start));
  if (found.end - found.start > widthMedian * GAP_WIDTH_RATIO) return runs;

  return [
    ...runs.slice(0, widest + 1),
    { ...found, metallicOnly: true },
    ...runs.slice(widest + 1),
  ];
}

/**
 * 3 つの拾い直しを本番の順序で通す。
 *
 * **合成をここに置くのは、経路が分かれるのを構造で防ぐため。** 解析
 * （`core/pipeline.ts`）と較正（`tests/fixtures/calibrate.test.ts`）が
 * それぞれ手で合成していた時期があり、片方に関数が足されたときにもう片方が
 * 取り残された。順序と組み合わせは 1 か所にしか書かない。
 *
 * 中間への挿入（{@link recoverFromGap}）を**先頭に置く**のが要点。後ろに
 * 回すと、末尾に足した許容差バンドの広い間隔を「異常」と読んで、推測の上に
 * 推測を積む。3 者は本数の条件（4〜5 / 3 / 2）で互いに排他なので、順に
 * 通せばどれか 1 つだけが働く。
 *
 * @param profile 解析範囲の 1D プロファイル（色順応補正済み）
 * @param runs バンド候補のラン（位置順）
 */
export function recoverRuns(
  profile: readonly ProfileSample[],
  runs: readonly ColorRun[],
  options: RecoverOptions = {},
): readonly ColorRun[] {
  const withGap = recoverFromGap(profile, runs);
  const withTolerance = recoverToleranceRun(profile, withGap, options);
  return recoverFromPair(profile, withTolerance, options);
}
