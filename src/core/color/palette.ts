import type { BandColor, LabColor } from '../../types.js';
import { prepareLab, type PreparedLab } from './colorSpace.js';
import { BAND_REFERENCE_COLORS } from './colors.js';

/**
 * バンド色の基準テーブル（パレット）。
 *
 * 既定値は見た目からの推定で、実写とはずれる。実写真に人手で正解ラベルを
 * 付けて集計した結果で差し替えられるよう、値として持ち回せる形にしている。
 * （較正のたびにソースを書き換えるのを避けるため）
 */

export interface Palette {
  readonly colors: Record<BandColor, LabColor>;
  /** 色差計算用に前処理したもの。ホットパスで毎回作らない。 */
  readonly entries: readonly { readonly key: BandColor; readonly prepared: PreparedLab }[];
}

/** Lab のテーブルからパレットを作る。 */
export function createPalette(colors: Record<BandColor, LabColor>): Palette {
  const entries = (Object.entries(colors) as [BandColor, LabColor][]).map(([key, lab]) => ({
    key,
    prepared: prepareLab(lab),
  }));
  return { colors, entries };
}

/**
 * 一部の色だけ差し替えたパレットを作る。
 * 較正でデータが取れなかった色は既定値のまま残したいので、部分適用にする。
 */
export function withOverrides(
  base: Palette,
  overrides: Partial<Record<BandColor, LabColor>>,
): Palette {
  return createPalette({ ...base.colors, ...overrides });
}

/** 見た目からの推定にもとづく既定パレット。 */
export const DEFAULT_PALETTE: Palette = createPalette(BAND_REFERENCE_COLORS);
