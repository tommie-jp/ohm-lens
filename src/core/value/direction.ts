import type { Band, ReadDirection } from '../../types.js';
import { MIN_BANDS } from './codeTable.js';

/** 方向判定の根拠。デバッグ表示と確信度の算出に使う。 */
export type DirectionReason = 'tolerance-band' | 'gap-ratio' | 'ambiguous';

export interface DirectionResult {
  readonly direction: ReadDirection;
  readonly reason: DirectionReason;
  /** 判定の確信度 0..1 */
  readonly confidence: number;
}

/** 許容差バンドにのみ使われ、数字バンドには使われない色。 */
const TOLERANCE_ONLY_COLORS = new Set(['gold', 'silver']);

/** 末尾側の間隔がこの比率以上に広ければ、そちらを末尾とみなす。 */
const GAP_RATIO_THRESHOLD = 1.5;

const CONFIDENCE = {
  toleranceBand: 0.95,
  gapRatio: 0.75,
  ambiguous: 0.5,
} as const;

/** バンドを ROI 長軸方向の位置でソートした新しい配列を返す。 */
export function sortBands(bands: readonly Band[]): Band[] {
  return [...bands].sort((a, b) => a.start - b.start);
}

/**
 * バンド列をどちらから読むかを判定する。
 *
 * 1. gold / silver は許容差バンドにしか使われないので、それがある側が末尾
 * 2. 判定できなければ、末尾側の間隔が広いという物理的性質で判定
 * 3. それでも決まらなければ ambiguous（呼び出し側で E系列適合により決める）
 *
 * @param bands 分類済みのバンド列（順不同でよい）
 * @param roiLength ROI の長軸方向の長さ
 */
export function determineDirection(bands: readonly Band[], roiLength: number): DirectionResult {
  if (bands.length < MIN_BANDS) {
    return { direction: 'ltr', reason: 'ambiguous', confidence: CONFIDENCE.ambiguous };
  }

  const sorted = sortBands(bands);
  const first = sorted[0] as Band;
  const last = sorted[sorted.length - 1] as Band;

  const firstIsTolerance = TOLERANCE_ONLY_COLORS.has(first.color);
  const lastIsTolerance = TOLERANCE_ONLY_COLORS.has(last.color);

  // 1. 許容差専用色による判定（両端にある場合は判定不能）
  if (lastIsTolerance !== firstIsTolerance) {
    return {
      direction: lastIsTolerance ? 'ltr' : 'rtl',
      reason: 'tolerance-band',
      confidence: CONFIDENCE.toleranceBand,
    };
  }

  // 2. 余白比率による判定。許容差バンドは他より間隔が空いている
  //    バンド間の間隔で決まらなければ、ROI 端までの余白でも判定する
  const leadingGap = (sorted[1] as Band).start - first.end;
  const trailingGap = last.start - (sorted[sorted.length - 2] as Band).end;
  const startMargin = first.start;
  const endMargin = roiLength - last.end;

  const verdicts: readonly (readonly [number, number, ReadDirection])[] = [
    [trailingGap, leadingGap, 'ltr'],
    [leadingGap, trailingGap, 'rtl'],
    [endMargin, startMargin, 'rtl'],
    [startMargin, endMargin, 'ltr'],
  ];

  for (const [wider, narrower, direction] of verdicts) {
    if (wider > narrower * GAP_RATIO_THRESHOLD) {
      return { direction, reason: 'gap-ratio', confidence: CONFIDENCE.gapRatio };
    }
  }

  return { direction: 'ltr', reason: 'ambiguous', confidence: CONFIDENCE.ambiguous };
}
