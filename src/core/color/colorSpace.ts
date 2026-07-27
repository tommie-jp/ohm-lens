import { converter, differenceCiede2000, modeLab65, modeRgb, useMode } from 'culori/fn';
import type { LabColor } from '../../types.js';
import { clamp01 } from '../math.js';

/**
 * 色空間変換と色差計算の薄いラッパ。
 * culori/fn（tree-shaking 版）を使い、必要なモードだけ登録する。
 * culori のモード登録はグローバルなので、**色変換はすべてこのモジュール経由**にする。
 *
 * Lab は D65 光源版（lab65）を使う。sRGB の白色点が D65 なので、
 * カメラ画像を扱う本用途では D50 版より素直。
 */

useMode(modeRgb);
useMode(modeLab65);

const toLab65 = converter('lab65');
const toRgb = converter('rgb');
const difference = differenceCiede2000();

/** 0..1 に正規化された sRGB。 */
export interface UnitRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * culori に渡せる形に前処理した Lab。
 * 同じ色と何度も色差を取る場合（基準色テーブルなど）は、あらかじめ
 * これに変換しておくと呼び出しごとのオブジェクト生成を避けられる。
 */
export interface PreparedLab {
  readonly mode: 'lab65';
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** Lab を色差計算用に前処理する。 */
export function prepareLab(lab: LabColor): PreparedLab {
  return { mode: 'lab65', l: lab.l, a: lab.a, b: lab.b };
}

/** 0..1 の sRGB を CIELAB (D65) に変換する。 */
export function rgbToLab(rgb: UnitRgb): LabColor {
  const lab = toLab65({ mode: 'rgb', r: rgb.r, g: rgb.g, b: rgb.b });
  return { l: lab.l, a: lab.a, b: lab.b };
}

/** 0..255 の sRGB バイト値を CIELAB (D65) に変換する。 */
export function srgb255ToLab(r: number, g: number, b: number): LabColor {
  return rgbToLab({ r: r / 255, g: g / 255, b: b / 255 });
}

/** CIELAB (D65) を 0..1 の sRGB に戻す（色域外はクランプする）。 */
export function labToRgb(lab: LabColor): UnitRgb {
  const rgb = toRgb(prepareLab(lab));
  return { r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b) };
}

/** CIELAB (D65) を CSS の rgb() 文字列にする。可視化用。 */
export function labToCss(lab: LabColor): string {
  const { r, g, b } = labToRgb(lab);
  const to255 = (value: number): number => Math.round(value * 255);
  return `rgb(${to255(r)} ${to255(g)} ${to255(b)})`;
}

/** CIEDE2000 (ΔE00) 色差。 */
export function deltaE2000(a: LabColor, b: LabColor): number {
  return difference(prepareLab(a), prepareLab(b));
}

/**
 * CIE76 色差（Lab 空間のユークリッド距離）。
 *
 * ΔE2000 は「知覚的に同じ色に見えるか」を測る指標で、**高彩度域の差を
 * 大きく圧縮する**。そのため「本体ベージュと金バンド」のように彩度だけが
 * 違う組を近いと判定してしまい、バンドが本体に吸収される。
 *
 * 「同じ色の区間か、別の色か」を切り分ける用途では圧縮しない CIE76 が適する。
 * 分類（どの基準色に最も近いか）には知覚的に均一な ΔE2000 を使う。
 */
export function deltaE76(a: LabColor, b: LabColor): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** 前処理済みの色どうしの CIEDE2000 色差。ホットパス用。 */
export function deltaE2000Prepared(a: PreparedLab, b: PreparedLab): number {
  return difference(a, b);
}
