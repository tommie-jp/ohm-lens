import type { BandColor, BodyColor, LabColor } from '../../types.js';
import { prepareLab, srgb255ToLab, type PreparedLab } from './colorSpace.js';

/** 0..255 の sRGB 三つ組。基準色テーブルの生の定義値。 */
export type Srgb255 = readonly [number, number, number];

/**
 * 抵抗カラーコードの基準色テーブル。
 *
 * 印刷インクの実測ではなく、一般的な抵抗器の見えに近い sRGB 値から
 * Lab を導出している。実画像フィクスチャでの較正（Step 0-7）で
 * 更新する前提の初期値。**合成サンプルやテストもこの値を参照すること**
 * （較正時に定義がずれないようにするため）。
 *
 * 紛らわしい組み合わせ:
 * - 茶 / 赤 / 橙
 * - 金 / 黄
 * - 灰 / 銀 / 白
 */
export const BAND_SRGB: Record<BandColor, Srgb255> = {
  black: [30, 30, 30],
  brown: [102, 51, 12],
  red: [200, 30, 30],
  orange: [240, 130, 20],
  yellow: [235, 210, 50],
  green: [30, 140, 60],
  blue: [40, 70, 180],
  violet: [120, 70, 160],
  grey: [130, 130, 130],
  white: [245, 245, 245],
  gold: [200, 160, 50],
  silver: [192, 192, 192],
};

/**
 * 抵抗器の本体色。バンドではなく背景として除去する対象であり、
 * 同時に色順応補正のアンカーにもなる。
 */
export const BODY_SRGB: Record<BodyColor, Srgb255> = {
  beige: [210, 180, 140],
  lightblue: [168, 200, 216],
  // セメント抵抗に多い灰白。beige と lightblue しか無いと無彩色のボディが
  // 無理にどちらかへ寄せられ、b* が ±18 動く（03-1.6ohm）
  greywhite: [200, 200, 196],
  // 金属皮膜・精密抵抗に多いオリーブ。灰白に寄せると誤読になる（21-2.26kohm）
  olive: [150, 152, 120],
};

function toLabTable<K extends string>(table: Record<K, Srgb255>): Record<K, LabColor> {
  const entries = Object.entries(table) as [K, Srgb255][];
  return Object.fromEntries(
    entries.map(([key, [r, g, b]]) => [key, srgb255ToLab(r, g, b)]),
  ) as Record<K, LabColor>;
}

/** バンド色の基準 Lab。 */
export const BAND_REFERENCE_COLORS: Record<BandColor, LabColor> = toLabTable(BAND_SRGB);

/** 本体色の基準 Lab。 */
export const BODY_REFERENCE_COLORS: Record<BodyColor, LabColor> = toLabTable(BODY_SRGB);

/** 基準色と参照キーの組。色差計算用に前処理済み。 */
export interface ReferenceEntry<K extends string> {
  readonly key: K;
  readonly lab: LabColor;
  readonly prepared: PreparedLab;
}

function toEntries<K extends string>(table: Record<K, LabColor>): ReferenceEntry<K>[] {
  return (Object.entries(table) as [K, LabColor][]).map(([key, lab]) => ({
    key,
    lab,
    prepared: prepareLab(lab),
  }));
}

/** バンド色の基準（前処理済み）。ホットパスで毎回作らないようここで固定する。 */
export const BAND_ENTRIES: readonly ReferenceEntry<BandColor>[] = toEntries(BAND_REFERENCE_COLORS);

/** 本体色の基準（前処理済み）。 */
export const BODY_ENTRIES: readonly ReferenceEntry<BodyColor>[] = toEntries(BODY_REFERENCE_COLORS);

/** バンド色の日本語 1 文字表記。写真への焼き込み表示に使う。 */
export const BAND_COLOR_JA: Record<BandColor, string> = {
  black: '黒',
  brown: '茶',
  red: '赤',
  orange: '橙',
  yellow: '黄',
  green: '緑',
  blue: '青',
  violet: '紫',
  grey: '灰',
  white: '白',
  gold: '金',
  silver: '銀',
};

/** 焼き込み表示のフォールバック（日本語フォントが無い環境向け）。 */
export const BAND_COLOR_ABBR: Record<BandColor, string> = {
  black: 'BLK',
  brown: 'BRN',
  red: 'RED',
  orange: 'ORG',
  yellow: 'YEL',
  green: 'GRN',
  blue: 'BLU',
  violet: 'VIO',
  grey: 'GRY',
  white: 'WHT',
  gold: 'GLD',
  silver: 'SLV',
};

/** CSS で使える色文字列（スウォッチ描画用）。 */
export function bandColorCss(color: BandColor): string {
  const [r, g, b] = BAND_SRGB[color];
  return `rgb(${r} ${g} ${b})`;
}
