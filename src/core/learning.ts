import { BAND_REFERENCE_COLORS } from './color/colors.js';
import type { BandColor, LabColor } from '../types.js';
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
 * 観測から基準色の上書きを作る（各成分の中央値）。
 * 件数が足りない色と、既定値からかけ離れた色は上書きしない。
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
