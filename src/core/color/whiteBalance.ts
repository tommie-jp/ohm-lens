import type { LabColor } from '../../types.js';

/**
 * フレーム内の基準色（アンカー）を使った簡易色順応補正。
 *
 * Safari では whiteBalanceMode / exposureMode を manual に固定できないため、
 * 絶対 Lab 値との ΔE では環境光の色被りに耐えられない。抵抗器の本体色や
 * UI ガイド枠内の白基準など「毎フレーム確実に取れる色」をアンカーにして、
 * 観測値を基準環境へ写してから分類する。
 *
 * von Kries 型の考え方を Lab 上で簡略化したもの:
 * - L は比率で補正（露出のずれは乗算的）
 * - a, b は差分で補正（色被りは加算的）
 */

/** L の補正比率がこの値より小さいアンカーは信用できないとみなす。 */
const MIN_ANCHOR_LIGHTNESS = 1e-6;

export interface Adaptation {
  readonly lightnessScale: number;
  readonly aShift: number;
  readonly bShift: number;
}

/** 補正なし（アンカーが得られなかった場合に使う）。 */
export const IDENTITY_ADAPTATION: Adaptation = {
  lightnessScale: 1,
  aShift: 0,
  bShift: 0,
};

/**
 * 観測されたアンカー色を基準アンカー色へ写す補正を作る。
 *
 * @param observed このフレームで観測したアンカー色
 * @param reference 基準環境でのアンカー色
 */
export function buildAdaptation(observed: LabColor, reference: LabColor): Adaptation {
  const lightnessScale =
    Math.abs(observed.l) < MIN_ANCHOR_LIGHTNESS ? 1 : reference.l / observed.l;

  return {
    lightnessScale,
    aShift: reference.a - observed.a,
    bShift: reference.b - observed.b,
  };
}

/** 補正を 1 色に適用する。 */
export function adaptToAnchor(color: LabColor, adaptation: Adaptation): LabColor {
  return {
    l: color.l * adaptation.lightnessScale,
    a: color.a + adaptation.aShift,
    b: color.b + adaptation.bShift,
  };
}
