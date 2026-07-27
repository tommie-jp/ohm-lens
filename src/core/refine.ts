import type { RoiImage } from './bands/profile.js';
import { extractProfile } from './bands/profile.js';
import { bandLayoutScore, MIN_BAND_COUNT } from './bands/layout.js';
import { bandRuns, type SegmentOptions } from './bands/segment.js';
import type { OrientedBox } from './locate.js';
import { rectify, type RectifyOptions } from './rectify.js';
import { bodyColumns } from './roiMapping.js';

/**
 * 検出枠を、カラーコードの並びを手がかりに長軸方向へ広げ直す。
 *
 * 本体の一部が背景と同じ色だと、前景マスクが島に割れて枠が本体の半分しか
 * 覆えないことがある（07-10ohm-on-carpet）。色の情報だけでは埋められないが、
 * **カラーコードは 3〜7 本がほぼ等間隔・等幅に並ぶ**という規格がある。
 * 枠を少しずつ伸ばして、その並びが最も自然になる位置を選べばよい。
 *
 * 太さと角度は触らない。検出側の太さ・向きは実測でよく合っており、
 * 足りないのは長軸方向の広がりだけだったため。
 */

export interface RefineOptions {
  /** ROI の切り出し条件（解析と同じものを渡す） */
  readonly rectify?: RectifyOptions;
  /** バンド抽出の条件（解析と同じものを渡す） */
  readonly segment?: SegmentOptions;
}

/** 片側に伸ばす量の候補（元の長さに対する割合）。 */
const GROWTH_STEPS = [0, 0.15, 0.3, 0.5, 0.75, 1] as const;

/**
 * 伸ばした結果として許す細長さ（長さ ÷ 太さ）の範囲。
 *
 * 軸形抵抗器の本体は 1/8W で約 1.9、1/4W で約 2.7、1/2W で約 2.3。
 * 実測でも 2.5〜3.5 に収まる。これを外れる枠は本体ではなく背景を
 * 巻き込んでいる（実測では 02 と 04 が 5.5 まで伸びた）。
 */
const MIN_REFINED_ELONGATION = 1.8;
const MAX_REFINED_ELONGATION = 4.5;

/**
 * この細長さ以上の枠には手を出さない。
 *
 * 枠が本体をちゃんと捉えていれば細長さは 2.5 前後になる。それより短いのは
 * 本体の一部しか覆えていない兆候で、そこだけを直す。整っている枠まで
 * 動かすと、たまたま等間隔に見える背景を巻き込んで却って悪くなる。
 */
const MIN_TRUSTED_ELONGATION = 2.4;

/**
 * 伸ばしたぶんの減点（1 に対する割合）。
 *
 * 並びの良さが同点なら元の枠に近いほうを採る。これが無いと、背景の模様まで
 * 巻き込んだ大きな枠が「たまたま等間隔に見える」だけで選ばれてしまう。
 */
const GROWTH_PENALTY = 0.2;

/** 元の枠より明らかに良いときだけ差し替えるための下駄。 */
const IMPROVEMENT_MARGIN = 0.15;

/**
 * バンド 1 本あたりの重み（3 本を超えたぶん、乗算）。
 *
 * 3 本だと間隔が 2 つしか取れず、「等間隔」はまぐれでも成立する。実際、
 * 本体の一部しか覆っていない枠が背景の縞を拾って満点を出した。本数が多い
 * ほど制約が増えるので、そのぶん並びの評価を信用してよい。
 */
const BAND_COUNT_WEIGHT = 0.12;

const DEFAULT_RECTIFY: RectifyOptions = { padding: 0.28, targetHeight: 40 };

/** 長軸方向に前後へ伸ばした箱を作る（太さと角度はそのまま）。 */
function grown(box: OrientedBox, growStart: number, growEnd: number): OrientedBox {
  const startShift = box.length * growStart;
  const endShift = box.length * growEnd;
  const rad = (box.angleDeg * Math.PI) / 180;
  // 中心は伸ばした量の差の半分だけ動く
  const shift = (endShift - startShift) / 2;

  return {
    ...box,
    centerX: box.centerX + shift * Math.cos(rad),
    centerY: box.centerY + shift * Math.sin(rad),
    length: box.length + startShift + endShift,
  };
}

/** その箱で切り出したときのバンドの並びの良さ。取れなければ null。 */
function layoutOf(
  image: RoiImage,
  box: OrientedBox,
  rectifyOptions: RectifyOptions,
  segmentOptions: SegmentOptions,
): number | null {
  const roi = rectify(image, box, rectifyOptions);
  const body = bodyColumns(box, rectifyOptions);
  const profile = extractProfile(roi).slice(Math.round(body.start), Math.round(body.end));
  if (profile.length === 0) return null;

  const runs = bandRuns(profile, segmentOptions);
  const score = bandLayoutScore(runs);
  return score === null
    ? null
    : score * (1 + BAND_COUNT_WEIGHT * (runs.length - MIN_BAND_COUNT));
}

/**
 * バンドの並びが最も自然になるよう、枠を長軸方向へ広げ直す。
 * 良くならなければ元の枠をそのまま返す。
 */
export function refineBoxByBands(
  box: OrientedBox,
  image: RoiImage,
  options: RefineOptions = {},
): OrientedBox {
  const rectifyOptions = options.rectify ?? DEFAULT_RECTIFY;
  const segmentOptions = options.segment ?? {};
  if (box.length / box.thickness >= MIN_TRUSTED_ELONGATION) return box;

  const baseline = layoutOf(image, box, rectifyOptions, segmentOptions);
  let best = box;
  let bestScore = baseline === null ? -Infinity : baseline + IMPROVEMENT_MARGIN;

  for (const growStart of GROWTH_STEPS) {
    for (const growEnd of GROWTH_STEPS) {
      if (growStart === 0 && growEnd === 0) continue;
      const candidate = grown(box, growStart, growEnd);
      const elongation = candidate.length / candidate.thickness;
      if (elongation < MIN_REFINED_ELONGATION || elongation > MAX_REFINED_ELONGATION) continue;

      const score = layoutOf(image, candidate, rectifyOptions, segmentOptions);
      if (score === null) continue;

      const adjusted = score - GROWTH_PENALTY * (growStart + growEnd);
      if (adjusted > bestScore) {
        bestScore = adjusted;
        best = candidate;
      }
    }
  }

  return best;
}
