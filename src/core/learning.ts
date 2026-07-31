import { BAND_REFERENCE_COLORS } from './color/colors.js';
import type { BandColor, LabColor, ProfileSample } from '../types.js';
import { alignRunsToBands } from './bands/align.js';
import { DEFAULT_PALETTE, type Palette } from './color/palette.js';

/**
 * 正解値からの学習。
 *
 * 「カメラに映した抵抗の値を人間がタイプする」だけで基準色を較正できる
 * ようにする。値と許容差からあり得るバンド列を逆算し、検出したランに
 * DP アライメントで対応付けて、色ごとの実写 Lab を蓄積する。
 * バンドを 1 本ずつ修正するより速く、色名を知らなくても学習に貢献できる。
 */

const DIGIT_COLORS: readonly BandColor[] = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white',
];

const MULTIPLIER_BY_EXPONENT: Record<number, BandColor> = {
  [-2]: 'silver', [-1]: 'gold', 0: 'black', 1: 'brown', 2: 'red', 3: 'orange',
  4: 'yellow', 5: 'green', 6: 'blue', 7: 'violet', 8: 'grey', 9: 'white',
};

const TOLERANCE_COLOR: Record<number, BandColor> = {
  0.1: 'violet', 0.25: 'blue', 0.5: 'green', 1: 'brown', 2: 'red', 5: 'gold', 10: 'silver',
};

/** 対応付けで飛ばしてよいランの最大数。 */
const MAX_SKIPS = 4;

/** 色ごとに保存する観測の上限。localStorage の肥大化を防ぐ。 */
const MAX_OBSERVATIONS_PER_COLOR = 100;

/** 上書きに採用する最低観測数の既定値。 */
const DEFAULT_MIN_SAMPLES = 3;

/**
 * 抵抗値と許容差から、あり得るバンド列を列挙する。
 * 2 桁（4 バンド系）と 3 桁（5 バンド系）の両方を試す。
 * E 系列で表せない値（有効数字が合わない）は空配列。
 */
export function expectedSequences(ohms: number, tolerance: number | null): BandColor[][] {
  const sequences: BandColor[][] = [];

  for (const digits of [2, 3]) {
    for (let exponent = -2; exponent <= 9; exponent += 1) {
      const significand = ohms / 10 ** exponent;
      if (Math.abs(significand - Math.round(significand)) > 1e-9) continue;
      const rounded = Math.round(significand);
      if (rounded < 10 ** (digits - 1) || rounded >= 10 ** digits) continue;
      const multiplier = MULTIPLIER_BY_EXPONENT[exponent];
      if (multiplier === undefined) continue;

      const sequence = [...String(rounded)].map(
        (digit) => DIGIT_COLORS[Number(digit)] as BandColor,
      );
      sequence.push(multiplier);
      if (tolerance !== null) {
        const toleranceColor = TOLERANCE_COLOR[tolerance];
        if (toleranceColor === undefined) continue;
        sequence.push(toleranceColor);
      }
      sequences.push(sequence);
    }
  }
  return sequences;
}

export interface LearnRun {
  readonly lab: LabColor;
  readonly start: number;
  readonly end: number;
}

export interface Assignment {
  readonly color: BandColor;
  readonly lab: LabColor;
}

export interface ValueMatch {
  /** ランに割り当てた色（学習に使う） */
  readonly assignments: readonly Assignment[];
  /** 採用したバンド列（物理的な並び順） */
  readonly sequence: readonly BandColor[];
  /** バンド 1 本あたりの平均 ΔE 相当。小さいほど確からしい。 */
  readonly cost: number;
  /**
   * 許容差バンドまで対応付けられたか。
   * 金バンドは本体ベージュに近く、検出から消えることが多い。その場合は
   * 数字・倍率バンドだけで学習する（false になる）。
   */
  readonly toleranceObserved: boolean;
}

/**
 * 検出したランを、正解値から逆算したバンド列に対応付ける。
 * 余分なラン（反射・ぼけ）は飛ばす。対応付けられなければ null。
 */
export function matchRunsToValue(
  runs: readonly LearnRun[],
  ohms: number,
  tolerance: number | null,
  palette: Palette = DEFAULT_PALETTE,
): ValueMatch | null {
  const alignRuns = runs.map((run) => ({ lab: run.lab, width: run.end - run.start }));

  const tryMatch = (
    sequences: readonly BandColor[][],
    toleranceObserved: boolean,
  ): ValueMatch | null => {
    let best: ValueMatch | null = null;
    for (const sequence of sequences) {
      for (const oriented of [sequence, [...sequence].reverse()]) {
        const aligned = alignRunsToBands(alignRuns, oriented, { maxSkips: MAX_SKIPS, palette });
        if (aligned === null) continue;
        if (best !== null && aligned.cost >= best.cost) continue;

        best = {
          assignments: aligned.assignments.map(({ runIndex, color }) => ({
            color,
            lab: (runs[runIndex] as LearnRun).lab,
          })),
          sequence: oriented,
          cost: aligned.cost,
          toleranceObserved,
        };
      }
    }
    return best;
  };

  // まず許容差バンド込みの列で試す
  const full = tryMatch(expectedSequences(ohms, tolerance), true);
  if (full !== null) return full;

  // 許容差バンドが検出から消えている場合（金は本体ベージュに近い）、
  // 数字・倍率バンドだけでも学習できるようにフォールバックする
  if (tolerance !== null) return tryMatch(expectedSequences(ohms, null), false);
  return null;
}

/** バンドが占める列の範囲（`Band` をそのまま渡せる形）。 */
export interface BandRange {
  readonly start: number;
  readonly end: number;
}

/** 1 本のバンドから取る観測の数。 */
const CALIBRATION_SAMPLES = 3;

/**
 * 並びを {@link CALIBRATION_SAMPLES} 個の区間に割る。
 *
 * 幅が足りず空になる区間には、その位置にいちばん近い 1 サンプルを充てる。
 * **細いバンドでも必ず同じ数の観測を返す**ようにして、「校正したのに
 * 件数が足りず採用されない」を起こさないため。
 */
function thirds(samples: readonly ProfileSample[]): ProfileSample[][] {
  const total = samples.length;
  return Array.from({ length: CALIBRATION_SAMPLES }, (_unused, index) => {
    const from = Math.floor((index * total) / CALIBRATION_SAMPLES);
    const to = Math.floor(((index + 1) * total) / CALIBRATION_SAMPLES);
    if (to > from) return samples.slice(from, to);
    const nearest = Math.min(from, total - 1);
    return samples.slice(nearest, nearest + 1);
  });
}

/** サンプル群の代表色（各成分の中央値）。 */
function medianLab(samples: readonly ProfileSample[]): LabColor {
  return {
    l: medianOf(samples.map((one) => one.lab.l)),
    a: medianOf(samples.map((one) => one.lab.a)),
    b: medianOf(samples.map((one) => one.lab.b)),
  };
}

/**
 * 人が選んだ正解色を、その場の実写 Lab と結びつけて観測にする（色校正）。
 *
 * 値からの逆算（{@link matchRunsToValue}）と違い、**色名を直接教える**経路。
 * 値が分からない抵抗でも較正でき、対応付けの当たり外れも挟まらない。
 *
 * 1 本につき **{@link CALIBRATION_SAMPLES} 点**取る。バンドを前・中・後に
 * 割って区間ごとの中央値を拾うので、端の混色や照明の勾配といった実写の
 * ばらつきが観測に入る（同じ値を 3 つ複製するのとは違う）。1 回の校正で
 * {@link DEFAULT_MIN_SAMPLES} に届くため、校正した色はその場で効く。
 *
 * **プロファイルは色順応補正後のものを渡すこと**（`AnalysisResult.profile`）。
 * 分類が比較しているのと同じ色空間でないと、学んだ基準色が実際の観測と
 * 対応しなくなる（「変換と palette は密結合」）。
 *
 * 金・銀もそのまま観測にする。採用しないのは {@link paletteOverrides} の
 * 役目で、保存の段階で分けると値からの学習と挙動がずれる。
 *
 * @param profile 補正後の 1D プロファイル（ROI 全体ぶん）
 * @param bands 分類済みバンドの範囲。列番号は ROI 基準
 * @param colors 人が選んだ正解色。`bands` と同じ並び・同じ本数
 */
export function calibrationAssignments(
  profile: readonly ProfileSample[],
  bands: readonly BandRange[],
  colors: readonly BandColor[],
): Assignment[] {
  // 本数が食い違うなら、どの色がどのバンドか決められない。黙って一部だけ
  // 学習すると取り違えたまま蓄積されるので、何もしない
  if (bands.length !== colors.length) return [];

  const assignments: Assignment[] = [];
  bands.forEach((band, index) => {
    const color = colors[index];
    if (color === undefined) return;

    const samples = profile.filter((one) => one.x >= band.start && one.x < band.end);
    if (samples.length === 0) return;

    for (const part of thirds(samples)) {
      assignments.push({ color, lab: medianLab(part) });
    }
  });
  return assignments;
}

/** 色ごとの実写 Lab の蓄積。 */
export type Observations = Partial<Record<BandColor, readonly LabColor[]>>;

/** 対応付け結果を観測に追加した新しいオブジェクトを返す。 */
export function addObservations(
  observations: Observations,
  assignments: readonly Assignment[],
): Observations {
  const next: Partial<Record<BandColor, readonly LabColor[]>> = { ...observations };
  for (const { color, lab } of assignments) {
    const merged = [...(next[color] ?? []), lab];
    next[color] = merged.slice(-MAX_OBSERVATIONS_PER_COLOR);
  }
  return next;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * 学習結果が既定の基準色からこれ以上離れていたら採用しない。
 *
 * 既定値は見た目からの推定なので実写とは 30〜50 ずれる（青や紫は基準が
 * 彩度過剰なため 50 近い）。それを超えるずれは学習ではなく誤対応の結果。
 * 実測では金が「L126 のほぼ白」（ずれ 78）として 15 件も学習され、金は
 * 4 本帯の許容差バンドなので読み取り全体を壊していた。
 */
const MAX_REFERENCE_DRIFT = 60;

/**
 * 学習の対象にしない色（金属色）。
 *
 * 金・銀の見え方は色順応補正のアンカー（本体色）に依存して**二峰性**になる。
 * 人手で確定した境界から実測すると、銀は青ボディで L\*81 b\*+17（温色）、
 * ベージュボディで L\*134 b\*-16（寒色）に写った。絶対 Lab の 1 点では
 * どちらかにしか合わず、実際に学習させると:
 *
 * - 金だけ学習: 学んだ金 L\*75 a\*5 b\*29 が既定の銀 L\*78 a\*0 b\*0 の隣に来て、
 *   `05-7.5ohm` の銀が金と読まれ ×10 ずれ（7.5Ω → 75Ω）
 * - 対でそろえて学習: 学んだ銀 L\*110 b\*-11 が実写の白 L\*104 b\*-11 に重なり、
 *   `15-339ohm` の白が銀と読まれ ×100 ずれ（339Ω → 330mΩ）。05 も直らない
 *
 * どちらも誤答が増えるだけで得るものが無い（43 枚で 誤答 0 → 2）。
 * 金属色の分類を直すなら、絶対値ではなく**本体色との相対**でやること。
 */
export const UNLEARNABLE_COLORS: readonly BandColor[] = ['gold', 'silver'];

/**
 * 観測から基準色の上書きを作る（各成分の中央値）。
 *
 * 上書きしないもの:
 *
 * - 件数が足りない色
 * - 既定値からかけ離れた色（{@link MAX_REFERENCE_DRIFT}）
 * - 金属色（{@link UNLEARNABLE_COLORS}）
 */
export function paletteOverrides(
  observations: Observations,
  minSamples = DEFAULT_MIN_SAMPLES,
): Partial<Record<BandColor, LabColor>> {
  const overrides: Partial<Record<BandColor, LabColor>> = {};
  for (const [color, samples] of Object.entries(observations) as [
    BandColor,
    readonly LabColor[],
  ][]) {
    if (UNLEARNABLE_COLORS.includes(color)) continue;
    if (samples.length < minSamples) continue;
    const learned = {
      l: medianOf(samples.map((lab) => lab.l)),
      a: medianOf(samples.map((lab) => lab.a)),
      b: medianOf(samples.map((lab) => lab.b)),
    };
    if (referenceDrift(learned, BAND_REFERENCE_COLORS[color]) > MAX_REFERENCE_DRIFT) continue;
    overrides[color] = learned;
  }
  return overrides;
}

/** 既定の基準色からのずれ（CIE76）。 */
function referenceDrift(learned: LabColor, reference: LabColor): number {
  return Math.hypot(
    learned.l - reference.l,
    learned.a - reference.a,
    learned.b - reference.b,
  );
}
