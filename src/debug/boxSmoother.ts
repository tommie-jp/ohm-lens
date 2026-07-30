import type { OrientedBox } from '../core/locate.js';

/**
 * 検出ボックスの時間平滑化（docs/03 §M4）。
 *
 * ライブ映像では検出座標がフレームごとに数 px 揺れ、赤枠がチラついて見える。
 * 直近数フレームの移動平均で描画用の枠を落ち着かせる。平滑化した枠は
 * **描画専用**で、色帯解析には生の検出結果を使う（平滑遅れを読み取りに
 * 持ち込まない）。`frameBudget` と同じく不変の状態を返す関数型で書く。
 */

export interface SmootherOptions {
  /** 平均する最大フレーム数。大きいほど滑らかだが追従が遅れる。 */
  readonly window?: number;
  /** 検出が途切れてから直前の枠を出し続けるフレーム数。 */
  readonly holdFrames?: number;
  /** 中心がこの割合 × 長さを超えて動いたら別の抵抗器とみなして追従し直す。 */
  readonly jumpRatio?: number;
}

const DEFAULT_WINDOW = 4;
const DEFAULT_HOLD_FRAMES = 2;
const DEFAULT_JUMP_RATIO = 0.25;

export interface SmootherState {
  readonly window: number;
  readonly holdFrames: number;
  readonly jumpRatio: number;
  /** 直近の生ボックス（新しいものが末尾）。 */
  readonly boxes: readonly OrientedBox[];
  /** 連続で検出できなかったフレーム数。 */
  readonly misses: number;
}

export function createSmoother(options: SmootherOptions = {}): SmootherState {
  return {
    window: options.window ?? DEFAULT_WINDOW,
    holdFrames: options.holdFrames ?? DEFAULT_HOLD_FRAMES,
    jumpRatio: options.jumpRatio ?? DEFAULT_JUMP_RATIO,
    boxes: [],
    misses: 0,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 窓内のボックスを平均する。
 *
 * 角度は 180° の対称性がある（+89° と −89° はほぼ同じ向き）ので、
 * 素朴に平均すると折り返しで 0° に化ける。倍角のベクトル
 * (cos2θ, sin2θ) を平均してから半分に戻すことで正しく扱う。
 */
function averageBoxes(boxes: readonly OrientedBox[]): OrientedBox {
  const cos2 = mean(boxes.map((box) => Math.cos((2 * box.angleDeg * Math.PI) / 180)));
  const sin2 = mean(boxes.map((box) => Math.sin((2 * box.angleDeg * Math.PI) / 180)));
  return {
    centerX: mean(boxes.map((box) => box.centerX)),
    centerY: mean(boxes.map((box) => box.centerY)),
    angleDeg: (Math.atan2(sin2, cos2) * 180) / Math.PI / 2,
    length: mean(boxes.map((box) => box.length)),
    thickness: mean(boxes.map((box) => box.thickness)),
  };
}

function isJump(previous: OrientedBox, next: OrientedBox, jumpRatio: number): boolean {
  const distance = Math.hypot(next.centerX - previous.centerX, next.centerY - previous.centerY);
  return distance > next.length * jumpRatio;
}

export interface SmootherResult {
  readonly state: SmootherState;
  /** 描画に使う平滑化済みボックス。出すものが無ければ null。 */
  readonly box: OrientedBox | null;
}

/**
 * 1 フレーム分の検出結果を渡し、描画に使うボックスを受け取る。
 * 検出できなかったフレームは `null` を渡す（保持期間内なら直前の枠を返す）。
 */
export function pushBox(state: SmootherState, box: OrientedBox | null): SmootherResult {
  if (box === null) {
    const misses = state.misses + 1;
    if (misses <= state.holdFrames && state.boxes.length > 0) {
      return { state: { ...state, misses }, box: averageBoxes(state.boxes) };
    }
    return { state: { ...state, boxes: [], misses }, box: null };
  }

  const last = state.boxes.at(-1);
  const boxes =
    last !== undefined && isJump(last, box, state.jumpRatio)
      ? [box] // 別の抵抗器へ移った。平均を引きずらず即座に追従する
      : [...state.boxes, box].slice(-state.window);
  return { state: { ...state, boxes, misses: 0 }, box: averageBoxes(boxes) };
}
