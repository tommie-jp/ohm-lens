/**
 * 解析の負荷を実測して、間引き間隔と解析解像度を自動調整する。
 *
 * スマホの CPU は端末差が大きく、事前に「何 fps で何 px なら回る」と決め打ち
 * できない。処理時間を測って、間に合わなければ落とし、余裕が出たら戻す。
 *
 * 落とす順序は **fps を先、解像度を後**。解像度は色帯の分離能力に直結する
 * （設計メモ §2 [3] の「解析は元解像度で」）ので、なるべく最後まで守る。
 * 戻すときは逆順で、解像度を先に回復させる。
 */

/** 解析に使う長辺の画素数。上から順に試す。 */
export const ANALYSIS_SCALES: readonly number[] = [800, 600, 440, 320];

/** 平均を取るフレーム数。短すぎると単発のもたつきで揺れる。 */
const WINDOW = 12;

/** 目標 fps の下限。これ以下には落とさない。 */
const MIN_FPS = 1;

/** 予算に対してこの倍率を超えたら劣化させる。 */
const DEGRADE_RATIO = 1.2;

/** 予算に対してこの倍率を下回れば回復を試す。 */
const RECOVER_RATIO = 0.5;

/** 判断に必要な最小サンプル数。 */
const MIN_SAMPLES = 6;

/** 変更後、次の判断までに空けるフレーム数（振動を防ぐ）。 */
const COOLDOWN = WINDOW;

export interface BudgetState {
  /** 直近の処理時間 [ms] */
  readonly samples: readonly number[];
  readonly targetFps: number;
  /** {@link ANALYSIS_SCALES} の添字 */
  readonly scaleIndex: number;
  /** 目標 fps の上限（初期値）。回復時にここまで戻す。 */
  readonly maxFps: number;
  /** 直前の変更からの経過フレーム数 */
  readonly sinceChange: number;
}

export interface FrameStats {
  /** 直近の平均処理時間 [ms] */
  readonly meanMs: number;
  /** 実効 fps（処理時間と間引き上限のうち厳しい方） */
  readonly fps: number;
}

export function createBudget(targetFps: number): BudgetState {
  return { samples: [], targetFps, scaleIndex: 0, maxFps: targetFps, sinceChange: 0 };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 直近の計測から平均処理時間と実効 fps を出す。計測前は null。 */
export function frameStats(state: BudgetState): FrameStats | null {
  if (state.samples.length === 0) return null;

  const meanMs = mean(state.samples);
  const byDuration = meanMs > 0 ? 1000 / meanMs : Number.POSITIVE_INFINITY;
  return { meanMs, fps: Math.min(state.targetFps, byDuration) };
}

/** 現在の解析解像度（長辺の画素数）。 */
export function analysisSize(state: BudgetState): number {
  return ANALYSIS_SCALES[state.scaleIndex] as number;
}

/**
 * 1 フレームの処理時間を記録し、必要なら設定を調整した新しい状態を返す。
 *
 * @param durationMs 解析にかかった時間
 */
export function recordFrame(state: BudgetState, durationMs: number): BudgetState {
  const samples = [...state.samples, durationMs].slice(-WINDOW);
  const next: BudgetState = { ...state, samples, sinceChange: state.sinceChange + 1 };

  if (samples.length < MIN_SAMPLES || next.sinceChange < COOLDOWN) return next;

  const budgetMs = 1000 / next.targetFps;
  const meanMs = mean(samples);

  if (meanMs > budgetMs * DEGRADE_RATIO) return degrade(next);
  if (meanMs < budgetMs * RECOVER_RATIO) return recover(next);
  return next;
}

/** 間に合っていないので落とす。fps を先、解像度を後。 */
function degrade(state: BudgetState): BudgetState {
  if (state.targetFps > MIN_FPS) {
    return { ...state, targetFps: Math.max(MIN_FPS, Math.floor(state.targetFps / 2)), sinceChange: 0 };
  }
  if (state.scaleIndex < ANALYSIS_SCALES.length - 1) {
    return { ...state, scaleIndex: state.scaleIndex + 1, sinceChange: 0 };
  }
  return state;
}

/** 余裕があるので戻す。解像度を先、fps を後。 */
function recover(state: BudgetState): BudgetState {
  if (state.scaleIndex > 0) {
    return { ...state, scaleIndex: state.scaleIndex - 1, sinceChange: 0 };
  }
  if (state.targetFps < state.maxFps) {
    return { ...state, targetFps: Math.min(state.maxFps, state.targetFps * 2), sinceChange: 0 };
  }
  return state;
}
