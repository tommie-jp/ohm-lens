import type { BandColor } from '../../types.js';

/**
 * IEC 60062 の抵抗カラーコード表。
 * 各バンド位置で使える色が異なるため、位置ごとに別テーブルとして持つ。
 * 使えない色に対しては null を返し、呼び出し側で誤読として棄却する。
 */

/** 値を読むのに最低限必要なバンド数（数字 2 桁 + 倍率）。 */
export const MIN_BANDS = 3;

/** 最大バンド数（数字 3 桁 + 倍率 + 許容差 + 温度係数）。 */
export const MAX_BANDS = 6;

const DIGITS: Partial<Record<BandColor, number>> = {
  black: 0,
  brown: 1,
  red: 2,
  orange: 3,
  yellow: 4,
  green: 5,
  blue: 6,
  violet: 7,
  grey: 8,
  white: 9,
};

/** 全 12 色に定義があるので Partial ではない。 */
const MULTIPLIERS: Record<BandColor, number> = {
  black: 1,
  brown: 10,
  red: 100,
  orange: 1_000,
  yellow: 10_000,
  green: 100_000,
  blue: 1_000_000,
  violet: 10_000_000,
  grey: 100_000_000,
  white: 1_000_000_000,
  gold: 0.1,
  silver: 0.01,
};

const TOLERANCES: Partial<Record<BandColor, number>> = {
  brown: 1,
  red: 2,
  green: 0.5,
  blue: 0.25,
  violet: 0.1,
  grey: 0.05,
  gold: 5,
  silver: 10,
};

const TEMP_COEFFICIENTS: Partial<Record<BandColor, number>> = {
  black: 250,
  brown: 100,
  red: 50,
  orange: 15,
  yellow: 25,
  green: 20,
  blue: 10,
  violet: 5,
  grey: 1,
};

/** 数字バンドとしての値。gold / silver は数字になれないので null。 */
export function digitOf(color: BandColor): number | null {
  return DIGITS[color] ?? null;
}

/** 倍率バンドとしての値。全色に定義があるので null にならない。 */
export function multiplierOf(color: BandColor): number {
  return MULTIPLIERS[color];
}

/** 許容差バンドとしての値 [%]。black / orange / yellow / white は null。 */
export function toleranceOf(color: BandColor): number | null {
  return TOLERANCES[color] ?? null;
}

/** 温度係数バンドとしての値 [ppm/K]。white / gold / silver は null。 */
export function tempCoefficientOf(color: BandColor): number | null {
  return TEMP_COEFFICIENTS[color] ?? null;
}
