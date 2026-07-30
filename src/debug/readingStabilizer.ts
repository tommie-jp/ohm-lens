/**
 * 読み取り値のちらつき止め。
 *
 * ライブでは 1 フレームごとに値が出るので、手ブレや露出の揺れで表示が
 * ころころ変わって読めない。**同じ値が続けて出たときだけ**表示する。
 * 揺れている間は何も出さない（誤った値を自信ありげに出さないという
 * 設計メモ §2 [7] の方針とも揃う）。
 *
 * `frameBudget` と同じく、状態を書き換えずに新しい状態を返す。
 */

/** 表示に必要な連続一致回数。 */
export const DEFAULT_REQUIRED_MATCHES = 3;

export interface StabilizerState {
  readonly required: number;
  /** 直近の値（新しいものが末尾）。必要回数ぶんだけ持つ。 */
  readonly recent: readonly string[];
}

export function createStabilizer(required = DEFAULT_REQUIRED_MATCHES): StabilizerState {
  return { required: Math.max(1, required), recent: [] };
}

export interface StabilizerResult {
  readonly state: StabilizerState;
  /** 表示してよい値。まだ揺れているなら null。 */
  readonly stable: string | null;
}

/** 1 フレーム分の読み取り値を渡し、表示してよい値を受け取る。 */
export function pushReading(state: StabilizerState, text: string): StabilizerResult {
  const recent = [...state.recent, text].slice(-state.required);
  const settled =
    recent.length === state.required && recent.every((value) => value === recent[0]);
  return { state: { ...state, recent }, stable: settled ? text : null };
}
