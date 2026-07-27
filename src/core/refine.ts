import type { LabColor, ProfileSample } from '../types.js';
import type { RoiImage } from './bands/profile.js';
import { extractProfile } from './bands/profile.js';
import { hasPlausibleBandCount } from './bands/layout.js';
import { bandRuns, type SegmentOptions } from './bands/segment.js';
import { estimateBackground, type OrientedBox } from './locate.js';
import { rectify, type RectifyOptions } from './rectify.js';
import { bodyColumns } from './roiMapping.js';

/**
 * 検出枠を長軸方向へ伸ばし直す。
 *
 * 本体の一部が背景と色が近いと前景マスクが島に割れ、枠が本体の半分しか
 * 覆えないことがある（07-10ohm-on-carpet では赤いボディと茶色いカーペットの
 * ΔE2000 が 10 を切る画素が混じる）。
 *
 * 鍵は**画素ごとのマスクではなく断面の中央値（1D プロファイル）で判断する**
 * こと。`extractProfile` は ROI の中央 50% の行の中央値を取るので、
 * カーペットのざらつきが平均化されて SNR が桁違いに良くなる。07 で実測すると、
 * 画素単位では背景差が 10〜27 とばらつく領域が、断面で見ると
 *
 * | 位置 | L\* | a\* |
 * | ------ | ----- | ----- |
 * | 赤いボディ | 26〜53 | 20〜39 |
 * | カーペット | 16〜29 | 5〜12 |
 * | 金属リード線 | 48〜59 | −3〜7 |
 *
 * と分かれる。背景から本体へ向かう a\*b\* の方向へ射影すれば、本体だけが
 * 大きな値になる。バンドは短い途切れとして跨ぎ、リード線は長く続くので止まる。
 *
 * 太さと角度は触らない。検出側の太さ・向きは実測でよく合っており、
 * 足りないのは長軸方向の広がりだけだったため。
 */

export interface RefineOptions {
  /** ROI の切り出し条件（解析と同じものを渡す） */
  readonly rectify?: RectifyOptions;
  /** バンド抽出の条件（伸ばした結果の検算に使う） */
  readonly segment?: SegmentOptions;
}

/** 探索のために枠を何倍まで広げて見るか。 */
const SEARCH_SPAN = 3;

/** 探索用 ROI の高さ [px]。断面の中央値を取るのでこの程度で足りる。 */
const SEARCH_HEIGHT = 40;

/**
 * 本体とみなす射影の下限（背景→本体ベクトルの長さに対する割合）。
 * 07 の実測ではボディ 1.6、カーペット 0〜0.46、リード線 0〜0.16 だった。
 */
const BODY_PROJECTION_RATIO = 0.6;

/**
 * 背景と本体の色差がこれ未満なら伸ばさない。
 * 色で追えないので、無理に伸ばすと背景を飲み込む。
 */
const MIN_BODY_CONTRAST = 6;

/**
 * 途切れとして跨ぐ長さの上限（探索用 ROI の高さに対する割合）。
 * バンドは本体の太さの 0.2 倍ほど。リード線は途切れずに続くのでそこで止まる。
 */
const MAX_BAND_GAP_RATIO = 0.4;

/** 伸ばした結果として許す細長さ（長さ ÷ 太さ）の範囲。 */
const MIN_REFINED_ELONGATION = 1.8;
const MAX_REFINED_ELONGATION = 4.5;

/**
 * この細長さ以上の枠には手を出さない。
 *
 * 枠が本体をちゃんと捉えていれば細長さは 2.5 前後になる。それより短いのは
 * 本体の一部しか覆えていない兆候で、そこだけを直す。
 */
const MIN_TRUSTED_ELONGATION = 2.4;

const DEFAULT_RECTIFY: RectifyOptions = { padding: 0.28, targetHeight: 40 };

function medianLab(samples: readonly ProfileSample[]): LabColor {
  const pick = (select: (sample: ProfileSample) => number): number => {
    const values = samples.map(select).sort((a, b) => a - b);
    return values[values.length >> 1] as number;
  };
  return { l: pick((s) => s.lab.l), a: pick((s) => s.lab.a), b: pick((s) => s.lab.b) };
}

/** 長軸方向の範囲（探索用 ROI の列）。 */
interface Extent {
  readonly start: number;
  readonly end: number;
}

/**
 * 背景 → 本体の方向へ射影して、本体らしい列を判定しながら外へ歩く。
 *
 * @param seed 元の枠が占める列の範囲
 */
function walkBody(
  profile: readonly ProfileSample[],
  seed: Extent,
  background: LabColor,
  body: LabColor,
  maxGap: number,
): Extent | null {
  const directionA = body.a - background.a;
  const directionB = body.b - background.b;
  const contrast = Math.hypot(directionA, directionB);
  if (contrast < MIN_BODY_CONTRAST) return null;

  const threshold = contrast * BODY_PROJECTION_RATIO;
  const isBody = (sample: ProfileSample): boolean => {
    const projection =
      ((sample.lab.a - background.a) * directionA + (sample.lab.b - background.b) * directionB) /
      contrast;
    return projection >= threshold;
  };

  /** step 方向へ歩き、途切れが続きすぎたら止まる。最後に本体だった位置を返す。 */
  const walk = (from: number, step: number): number => {
    let last = from;
    let gap = 0;
    for (let at = from + step; at >= 0 && at < profile.length; at += step) {
      if (isBody(profile[at] as ProfileSample)) {
        last = at;
        gap = 0;
        continue;
      }
      gap += 1;
      if (gap > maxGap) break;
    }
    return last;
  };

  return { start: walk(seed.start, -1), end: walk(seed.end - 1, 1) + 1 };
}

/** 探索用 ROI の列範囲を、元画像上の箱に戻す。 */
function boxFromExtent(
  box: OrientedBox,
  extent: Extent,
  roiWidth: number,
): OrientedBox {
  const scale = (box.length * SEARCH_SPAN) / roiWidth;
  const alongCenter = ((extent.start + extent.end) / 2 - roiWidth / 2) * scale;
  const rad = (box.angleDeg * Math.PI) / 180;

  return {
    ...box,
    centerX: box.centerX + alongCenter * Math.cos(rad),
    centerY: box.centerY + alongCenter * Math.sin(rad),
    length: (extent.end - extent.start) * scale,
  };
}

/** その箱で切り出したバンドが、本数の上でカラーコードとして成立するか。 */
function readsAsColorCode(
  image: RoiImage,
  box: OrientedBox,
  rectifyOptions: RectifyOptions,
  segmentOptions: SegmentOptions,
): boolean {
  const roi = rectify(image, box, rectifyOptions);
  const body = bodyColumns(box, rectifyOptions);
  const profile = extractProfile(roi).slice(Math.round(body.start), Math.round(body.end));
  if (profile.length === 0) return false;

  return hasPlausibleBandCount(bandRuns(profile, segmentOptions));
}

/**
 * 本体色をたどって枠を長軸方向へ伸ばし直す。伸ばせなければ元の枠を返す。
 *
 * 伸ばした結果は「バンドが 3〜7 本になるか」で検算する。色でたどれても
 * 本数がカラーコードとして成立しないなら、それは本体ではない。
 */
export function refineBoxExtent(
  box: OrientedBox,
  image: RoiImage,
  options: RefineOptions = {},
): OrientedBox {
  const rectifyOptions = options.rectify ?? DEFAULT_RECTIFY;
  const segmentOptions = options.segment ?? {};
  if (box.length / box.thickness >= MIN_TRUSTED_ELONGATION) return box;

  // 元の枠を中央に置いたまま、前後へ広げた ROI を作って外を覗く
  const wide: OrientedBox = { ...box, length: box.length * SEARCH_SPAN };
  const roi = rectify(image, wide, { padding: 0, targetHeight: SEARCH_HEIGHT });
  const profile = extractProfile(roi);
  if (profile.length === 0) return box;

  const seedWidth = roi.width / SEARCH_SPAN;
  const seed: Extent = {
    start: Math.round((roi.width - seedWidth) / 2),
    end: Math.round((roi.width + seedWidth) / 2),
  };
  const extent = walkBody(
    profile,
    seed,
    estimateBackground(image),
    medianLab(profile.slice(seed.start, seed.end)),
    SEARCH_HEIGHT * MAX_BAND_GAP_RATIO,
  );
  if (extent === null || extent.end - extent.start <= seed.end - seed.start) return box;

  const refined = boxFromExtent(box, extent, roi.width);
  const elongation = refined.length / refined.thickness;
  if (elongation < MIN_REFINED_ELONGATION || elongation > MAX_REFINED_ELONGATION) return box;
  if (!readsAsColorCode(image, refined, rectifyOptions, segmentOptions)) return box;

  return refined;
}
