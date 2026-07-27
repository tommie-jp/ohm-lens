import type { ProfileSample } from '../../types.js';
import { medianInPlace } from '../math.js';

/**
 * プロファイルの明度から、円筒形ボディの陰影勾配を取り除く。
 *
 * 抵抗器は円筒なので、長軸方向に沿って明るさが変化する（端に向かって
 * 暗くなる、光源側が明るいなど）。この緩やかな勾配があると、隣接サンプル
 * 間の ΔE でランを切るときに本体の途中で余計な切れ目が入る。
 *
 * 幅の広い**移動中央値**をベースラインとして引き算する。中央値なので
 * 少数派であるバンドには引きずられず、本体の陰影だけを拾う。バンドの
 * 明暗差はベースラインからのずれとして保たれる。
 *
 * 色度（a*, b*）は触らない。陰影は主に明度に出るうえ、色度を触ると
 * 分類の手がかりを壊してしまうため。
 */

export interface NormalizeOptions {
  /**
   * ベースラインを取る窓幅（プロファイル長に対する割合）。
   * バンド 1 本より十分広く取らないと、バンド自身がベースラインを
   * 押し下げて落ち込みが消える。
   */
  readonly windowFraction?: number;
}

const DEFAULT_WINDOW_FRACTION = 0.35;
const MIN_WINDOW = 5;

/** 移動中央値によるベースラインを引き、全体の明度水準を戻す。 */
export function normalizeLightness(
  profile: readonly ProfileSample[],
  options: NormalizeOptions = {},
): ProfileSample[] {
  if (profile.length === 0) return [];

  const fraction = options.windowFraction ?? DEFAULT_WINDOW_FRACTION;
  const window = Math.max(MIN_WINDOW, Math.round(profile.length * fraction));
  if (profile.length <= MIN_WINDOW) return profile.map((sample) => ({ ...sample }));

  const half = Math.floor(window / 2);
  const scratch = new Float64Array(window);

  let baselineSum = 0;
  const baselines = profile.map((_, index) => {
    const start = Math.max(0, Math.min(index - half, profile.length - window));
    const end = Math.min(profile.length, start + window);
    const count = end - start;
    for (let i = 0; i < count; i += 1) {
      scratch[i] = (profile[start + i] as ProfileSample).lab.l;
    }
    const baseline = medianInPlace(scratch.subarray(0, count));
    baselineSum += baseline;
    return baseline;
  });

  // 引き算で失われる全体の明度水準を戻す
  const meanBaseline = baselineSum / baselines.length;

  return profile.map((sample, index) => ({
    x: sample.x,
    lab: {
      l: sample.lab.l - (baselines[index] as number) + meanBaseline,
      a: sample.lab.a,
      b: sample.lab.b,
    },
  }));
}
