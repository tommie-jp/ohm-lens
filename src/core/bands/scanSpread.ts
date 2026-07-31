import type { LabColor, ProfileSample } from '../../types.js';
import { deltaE2000 } from '../color/colorSpace.js';
import { medianInPlace } from '../math.js';
import type { ColorRun } from './runs.js';

/**
 * バンド色の行方向のばらつき。
 *
 * バンドは本体の全高にわたる縦縞なので、**どの走査線も同じ色を見ているはず**。
 * 見ていなければ、鏡面反射で潰れているか、OBB の残留回転でバンドの列位置が
 * 行ごとにずれているか、そもそもバンドではないものを見ている。
 *
 * これは色の近さ（ΔE）とも次点とのマージンとも独立した情報で、確信度の
 * 材料になりうる。**値の決定には使わない** — 解釈を選び直しても直らない
 * 性質のものなので、`isGeometryNatural` と同じく確信度側に効かせる。
 */

/** バンド幅の両端をどれだけ捨てるか（片側あたりの割合）。 */
const DEFAULT_SHRINK = 0.2;

export interface SpreadOptions {
  /**
   * バンド幅の両端をどれだけ捨てるか（片側あたりの割合）。
   *
   * 残留回転（OBB の角度のずれ）への保険。角度が 1〜2° 外れていると上端と
   * 下端の走査線でバンドの列位置が数 px ずれ、縁で隣のバンドの色が混ざる。
   */
  readonly shrink?: number;
}

/**
 * ランごとの、走査線をまたいだ色のばらつき（ΔE2000）。
 *
 * 走査線が区間を覆っていないランは `null`。走査線が 2 本未満なら空配列。
 *
 * @param runs 対象のラン（`start`/`end` は ROI の絶対列番号）
 * @param scans 走査線ごとのプロファイル（ROI 全幅ぶん、切らずに渡すこと）
 */
export function runScanSpreads(
  runs: readonly ColorRun[],
  scans: readonly (readonly ProfileSample[])[],
  options: SpreadOptions = {},
): (number | null)[] {
  if (runs.length === 0 || scans.length < 2) return [];

  const shrink = options.shrink ?? DEFAULT_SHRINK;
  return runs.map((run) => {
    const observed = scans
      .map((scan) => runColor(scan, run, shrink))
      .filter((lab): lab is LabColor => lab !== null);
    if (observed.length < 2) return null;

    const consensus = medianLab(observed);
    return medianInPlace(
      Float64Array.from(observed, (lab) => deltaE2000(lab, consensus)),
    );
  });
}

/**
 * ばらつきの最大値（最も揃っていないバンド）。測れなければ null。
 *
 * 最大を採るのは、1 本でもバンドに見えないものが混じっていれば読み全体が
 * 疑わしいため。中央値では 1 本の異常が薄まる。
 */
export function maxScanSpread(
  runs: readonly ColorRun[],
  scans: readonly (readonly ProfileSample[])[],
  options: SpreadOptions = {},
): number | null {
  const spreads = runScanSpreads(runs, scans, options).filter(
    (value): value is number => value !== null,
  );
  return spreads.length === 0 ? null : Math.max(...spreads);
}

/** 1 本の走査線から見た 1 ランの色。走査線が区間を覆っていなければ null。 */
function runColor(
  scan: readonly ProfileSample[],
  run: ColorRun,
  shrink: number,
): LabColor | null {
  const width = run.end - run.start;
  if (width <= 0) return null;

  const inset = Math.floor(width * shrink);
  // 縮めすぎて空になるなら縮めない（細いバンドを消さない）
  const shrinkable = width - inset * 2 >= 1;
  const from = shrinkable ? run.start + inset : run.start;
  const to = shrinkable ? run.end - inset : run.end;
  if (from < 0 || to > scan.length) return null;

  const samples: LabColor[] = [];
  for (let x = from; x < to; x += 1) samples.push((scan[x] as ProfileSample).lab);
  return samples.length === 0 ? null : medianLab(samples);
}

/** Lab の成分ごとの中央値。 */
function medianLab(colors: readonly LabColor[]): LabColor {
  return {
    l: medianInPlace(Float64Array.from(colors, (color) => color.l)),
    a: medianInPlace(Float64Array.from(colors, (color) => color.a)),
    b: medianInPlace(Float64Array.from(colors, (color) => color.b)),
  };
}
