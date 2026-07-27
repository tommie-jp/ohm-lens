import type { BandColor, LabColor } from '../../types.js';
import { deltaE2000 } from '../color/colorSpace.js';
import { DEFAULT_PALETTE, type Palette } from '../color/palette.js';

/**
 * 抽出したランを、既知のバンド列に対応付ける。
 *
 * 較正では「正解の抵抗値」から期待されるバンド列が分かる。ところが実写真から
 * 取れるランには、鏡面反射・端のぼけ・背景の残りといった余分なものが混ざり、
 * 本数がぴったり一致することは少ない。本数一致を要求すると較正のサンプルが
 * ほとんど集まらないので、**余分なランを飛ばしながら**順序を保って対応付ける。
 *
 * 動的計画法で「全バンドを使い切る対応付け」のうち総コスト最小のものを選ぶ。
 * コストは基準色との ΔE で、幅の広いランほど割り引く（細いランは
 * ぼけや反射である可能性が高いため）。
 */

export interface AlignRun {
  readonly lab: LabColor;
  /** ランの幅。広いほど信用する。 */
  readonly width: number;
}

export interface AlignOptions {
  /** 飛ばしてよいランの最大数。既定は制限なし。 */
  readonly maxSkips?: number;
  readonly palette?: Palette;
}

export interface Assignment {
  readonly runIndex: number;
  readonly color: BandColor;
}

export interface AlignResult {
  readonly assignments: readonly Assignment[];
  /** 総コスト（バンド 1 本あたりの平均 ΔE 相当）。小さいほど確からしい。 */
  readonly cost: number;
}

/** 幅がこの値を超えたら、それ以上は割引しない。 */
const WIDTH_SATURATION = 8;

/** 細いランに与える割増（コストを最大この倍率まで増やす）。 */
const NARROW_PENALTY = 2;

function matchCost(run: AlignRun, color: BandColor, palette: Palette): number {
  const delta = deltaE2000(run.lab, palette.colors[color]);
  const widthFactor = Math.min(1, Math.max(0, run.width) / WIDTH_SATURATION);
  // 幅が 0 に近いほどコストを NARROW_PENALTY 倍まで持ち上げる
  return delta * (NARROW_PENALTY - (NARROW_PENALTY - 1) * widthFactor);
}

/**
 * ランをバンド列に対応付ける。対応付けられなければ null。
 *
 * @param runs 抽出したラン（位置順に並んでいること）
 * @param bands 期待されるバンド色の列
 */
export function alignRunsToBands(
  runs: readonly AlignRun[],
  bands: readonly BandColor[],
  options: AlignOptions = {},
): AlignResult | null {
  if (runs.length === 0 || bands.length === 0) return null;
  if (runs.length < bands.length) return null;

  const maxSkips = options.maxSkips ?? runs.length;
  if (runs.length - bands.length > maxSkips) return null;

  const palette = options.palette ?? DEFAULT_PALETTE;

  // best[i][j] = 先頭 i 本のランで、先頭 j 本のバンドを埋めたときの最小コスト
  const infinity = Number.POSITIVE_INFINITY;
  const best: number[][] = Array.from({ length: runs.length + 1 }, () =>
    new Array<number>(bands.length + 1).fill(infinity),
  );
  const cameFromMatch: boolean[][] = Array.from({ length: runs.length + 1 }, () =>
    new Array<boolean>(bands.length + 1).fill(false),
  );

  for (let i = 0; i <= runs.length; i += 1) (best[i] as number[])[0] = 0;

  for (let i = 1; i <= runs.length; i += 1) {
    for (let j = 1; j <= Math.min(i, bands.length); j += 1) {
      const skip = (best[i - 1] as number[])[j] as number;
      const matched = (best[i - 1] as number[])[j - 1] as number;
      const withMatch =
        matched === infinity
          ? infinity
          : matched + matchCost(runs[i - 1] as AlignRun, bands[j - 1] as BandColor, palette);

      if (withMatch <= skip) {
        (best[i] as number[])[j] = withMatch;
        (cameFromMatch[i] as boolean[])[j] = true;
      } else {
        (best[i] as number[])[j] = skip;
      }
    }
  }

  const total = (best[runs.length] as number[])[bands.length] as number;
  if (!Number.isFinite(total)) return null;

  // 経路を復元する
  const assignments: Assignment[] = [];
  let i = runs.length;
  let j = bands.length;
  while (j > 0) {
    if ((cameFromMatch[i] as boolean[])[j] === true) {
      assignments.push({ runIndex: i - 1, color: bands[j - 1] as BandColor });
      i -= 1;
      j -= 1;
    } else {
      i -= 1;
    }
  }
  assignments.reverse();

  return { assignments, cost: total / bands.length };
}
