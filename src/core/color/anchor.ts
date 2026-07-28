import type { LabColor, ProfileSample } from '../../types.js';
import { deltaE2000Prepared, prepareLab } from './colorSpace.js';
import { BODY_ENTRIES } from './colors.js';
import { medianInPlace } from '../math.js';
import { buildAdaptation, IDENTITY_ADAPTATION, type Adaptation } from './whiteBalance.js';

/**
 * 色順応補正のアンカー推定。
 *
 * WB ロックできない環境（Safari）では、フレーム内で確実に取れる色を
 * 基準にして観測値を基準環境へ写す必要がある。抵抗器の本体色は ROI の
 * 大半を占めるので、これをアンカーに使う。
 */

/**
 * プロファイルから本体色のアンカーを推定する。
 *
 * Lab 各成分の中央値を取ると、少数派であるバンドに引っ張られずに
 * 本体色が得られる。
 *
 * 注意: ROI に背景（机など）が大きく写り込んでいると中央値が背景色に
 * なる。呼び出し側は ROI を抵抗器本体に寄せて渡すこと。
 */
export function estimateBodyAnchor(profile: readonly ProfileSample[]): LabColor | null {
  if (profile.length === 0) return null;

  const lightness = new Float64Array(profile.length);
  const aAxis = new Float64Array(profile.length);
  const bAxis = new Float64Array(profile.length);

  profile.forEach((sample, index) => {
    lightness[index] = sample.lab.l;
    aAxis[index] = sample.lab.a;
    bAxis[index] = sample.lab.b;
  });

  return {
    l: medianInPlace(lightness),
    a: medianInPlace(aAxis),
    b: medianInPlace(bAxis),
  };
}

/**
 * 観測アンカーに最も近い本体色の基準 Lab を選ぶ。
 *
 * **色み（a\*b\*）だけで比べ、明度は見ない。** 観測アンカーの明度は露出で
 * いくらでも動く。39 枚の実測では基準への倍率が 1.10〜3.75 倍に散らばり、
 * しかも**全枚数で 1 より大きい**（撮影されたボディは基準より必ず暗い）。
 * 明度を判断に混ぜると、比較しているのは色ではなく露出になる。
 *
 * 実害が出ていた。`39-10Mohm`（青メタルフィルム、アンカー L20 a-7 b-5）は
 * lightblue との明度差 59 が効いて **beige** に写され、b\* に +29 が加算されて
 * いた。黒バンドが L20 a12 **b30** と読まれて茶に倒れていたのはこれが原因。
 */
export function nearestBodyReference(anchor: LabColor): LabColor {
  // 明度を基準側にそろえてから比べる。ΔE2000 の色相・彩度の重み付けは
  // 使いたいので、指標そのものは変えない
  let best = (BODY_ENTRIES[0] as (typeof BODY_ENTRIES)[number]).lab;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of BODY_ENTRIES) {
    const prepared = prepareLab({ l: entry.lab.l, a: anchor.a, b: anchor.b });
    const delta = deltaE2000Prepared(prepared, entry.prepared);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry.lab;
    }
  }
  return best;
}

/**
 * プロファイルから本体色アンカーを推定し、色順応補正を組み立てる。
 * アンカーが取れなければ補正なし（恒等変換）を返す。
 */
export function buildBodyAnchorAdaptation(profile: readonly ProfileSample[]): {
  readonly adaptation: Adaptation;
  readonly anchor: LabColor | null;
} {
  const anchor = estimateBodyAnchor(profile);
  if (anchor === null) return { adaptation: IDENTITY_ADAPTATION, anchor: null };

  return { adaptation: buildAdaptation(anchor, nearestBodyReference(anchor)), anchor };
}
