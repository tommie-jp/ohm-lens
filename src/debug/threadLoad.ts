/**
 * スレッドの占有率を測って時系列に残す。
 *
 * ブラウザからは本当の CPU 使用率を取れないので、**そのスレッドが解析の処理に
 * 使った時間の割合**で代用する（実測した処理時間 ÷ 経過時間）。メインと
 * ワーカーで同じ定義にしてあるので、どちらがどれだけ働いているかを並べて
 * 比べられる。
 *
 * DOM に触らない（描画は `threadLoadView.ts`）。
 */

/** 占有率を平均する窓の長さ [ms]。短いと 1 フレームの重さで跳ね、長いと鈍る。 */
export const WINDOW_MS = 1000;

/** グラフに出す点の数。 */
export const HISTORY_LENGTH = 60;

/** 1 回ぶんの仕事。 */
interface Work {
  /** 仕事が終わった時刻 [ms]（`performance.now()`）。 */
  readonly at: number;
  /** かかった時間 [ms]。 */
  readonly ms: number;
}

export interface LoadState {
  /** まだ窓に入っている仕事。 */
  readonly work: readonly Work[];
  /** 占有率の履歴（古い順、0..1）。 */
  readonly history: readonly number[];
}

export function createLoad(): LoadState {
  return { work: [], history: [] };
}

/** 仕事を 1 件積む。 */
export function recordWork(state: LoadState, at: number, ms: number): LoadState {
  return { ...state, work: [...state.work, { at, ms }] };
}

/** 窓に入っている仕事だけ残す。 */
function inWindow(work: readonly Work[], now: number): readonly Work[] {
  return work.filter((one) => now - one.at < WINDOW_MS);
}

/** いまの占有率（0..1）。 */
export function currentLoad(state: LoadState, now: number): number {
  const busy = inWindow(state.work, now).reduce((total, one) => total + one.ms, 0);
  // 待たされている間に仕事が積み上がると窓を超えることがある。頭打ちにする
  return Math.min(1, busy / WINDOW_MS);
}

/**
 * 履歴に 1 点刻む。一定の間隔で呼ぶこと。
 * 窓から出た仕事はここで捨てるので、際限なく溜まることはない。
 */
export function sampleLoad(state: LoadState, now: number): LoadState {
  const work = inWindow(state.work, now);
  const history = [...state.history, currentLoad(state, now)];
  return {
    work,
    history: history.length > HISTORY_LENGTH ? history.slice(-HISTORY_LENGTH) : history,
  };
}
