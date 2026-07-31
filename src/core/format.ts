import type { ResistorReading } from '../types.js';
import { clamp01 } from './math.js';

/**
 * 抵抗値の表示用フォーマットと、値を出してよいかの判定。
 * オーバーレイ描画（Phase 1 以降）とデバッグページで共有する。
 */

/**
 * この確信度を下回る読み取りは値を表示せず「?」にする。
 *
 * 誤った値を自信ありげに出すくらいなら読めないと言う、という方針
 * （設計メモ §2 [5]）。Phase 1 のオーバーレイと Phase 2 の時間方向投票も
 * この閾値を共有すること。
 *
 * `sample/` の 40 枚での実測。
 *
 * | 閾値 | 0.28 | **0.30** | 0.32 | 0.40 |
 * | ------ | ------ | ---------- | ------ | ------ |
 * | 正解 | 33 | **33** | 32 | 30 |
 * | 誤答 | 0 | **0** | 0 | 0 |
 * | 保留 | 7 | **7** | 8 | 10 |
 *
 * **確信度の順序が正しくなったので下げられるようになった。** 以前は
 * 誤読が正解より上に来ており（`01` 0.36 誤 > `05` 0.34 正）、どこに置いても
 * 誤答なしで正解だけを増やすことができなかった。`docs/12` の改善
 * （並びの幾何による減点・本体基準を色みだけで選ぶ・本体基準の追加）で
 * 順序が入れ替わり、**正解の下限 0.3130（`21`）と誤読の上限 0.2731（`01`）の
 * あいだに空きができた**。
 *
 * その空き `(0.273, 0.313]` のなかで、丸い値の **0.30** を採る
 * （誤読まで 0.027、正解まで 0.013）。正解を落とすのは「読めない」と言うだけ
 * だが、誤読を通すのは自信ありげに間違えることなので、危険な側に厚く置く。
 *
 * **空きの位置は検体に敏感である。** 39 枚のときは `(0.309, 0.328]` で 0.32 を
 * 採っていたが、白バンドの検体を 1 枚足しただけで下端も上端も動いた。
 * 端に寄せて詰めると検体が変わるたびに壊れるので、**空きの内側の丸い値**を
 * 選び、成績が同じ範囲では動かさない。
 */
export const MIN_REPORTABLE_CONFIDENCE = 0.3;

const UNITS: readonly { readonly threshold: number; readonly suffix: string }[] = [
  { threshold: 1e9, suffix: 'G' },
  { threshold: 1e6, suffix: 'M' },
  { threshold: 1e3, suffix: 'k' },
  { threshold: 1, suffix: '' },
];

/** 有効数字 3 桁で末尾の 0 を落とす。 */
function trimNumber(value: number): string {
  return Number.parseFloat(value.toPrecision(3)).toString();
}

/**
 * 確信度を「35%」のように表記する。
 * 0..1 の生値より、人が読むときの目盛りとして分かりやすい。
 */
export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return '?';
  return `${Math.round(clamp01(confidence) * 100)}%`;
}

/** 抵抗値を 4.7kΩ のような表記にする。 */
export function formatOhms(ohms: number): string {
  if (!Number.isFinite(ohms)) return '?';

  const unit = UNITS.find((candidate) => Math.abs(ohms) >= candidate.threshold);
  if (unit === undefined) return `${trimNumber(ohms * 1000)}mΩ`;

  return `${trimNumber(ohms / unit.threshold)}${unit.suffix}Ω`;
}

/**
 * 読み取りに必要な本体の太さ [px]。これを割る検出枠からは値を出さない。
 *
 * **絶対の画素数で見るのが正しい。** センサが被写体に何画素当てられているかの
 * 話で、画面に対する割合ではない（遠くの抵抗器でも 4K なら画素は足りる）。
 *
 * 48 枚の実測では**正解の最小の太さが 54px**で、それ未満は 1 枚も正解していない。
 *
 * | 太さ [px] | 検体 | 判定 |
 * | ---- | ---- | ---- |
 * | 4 | `43-4.7kohm` | 保留（104×384 の画像に 25×4 の枠） |
 * | 12 | `52-39kohm` | 保留（76×552 の画像に 45×12 の枠） |
 * | 22 | `09-82ohm` | 保留 |
 * | 25 | `49-18kohm` | **誤答** |
 * | 30 / 36 / 38 | `46` / `51` / `41` | 保留 |
 * | 54 以上 | 32 枚 | すべて正解 |
 *
 * 太さ 12px の枠ではバンド 1 本が 3px しかなく、`rectify` はそれを 3〜6 倍に
 * **拡大**して 40px の ROI を作る — 情報は 1 つも増えない。
 *
 * 38（保留の最大）と 54（正解の最小）の間は空白なので、その中央を採る。
 * 空白の位置は検体に敏感なので、端に寄せず内側の丸い値にする
 * （{@link MIN_REPORTABLE_CONFIDENCE} と同じ作法）。
 *
 * **検出側ではなく読み取り側の方針として置く。** 細い枠を見つけたこと自体は
 * 検出の誤りではないので `locate` は素直に返し、値を出すかどうかをここで決める。
 */
export const MIN_READABLE_THICKNESS = 46;

/**
 * その検出枠は値を出せる解像度か。
 * 満たさないときは「?」を出す（誤った値を自信ありげに出さない、設計メモ §2 [5]）。
 */
export function isReadableSize(
  box: { readonly thickness: number } | null,
  minThickness = MIN_READABLE_THICKNESS,
): boolean {
  return box !== null && box.thickness >= minThickness;
}

/** 確信度が十分で、値として表示してよい読み取りかどうか。 */
export function isReportable(
  reading: ResistorReading | null,
  minConfidence = MIN_REPORTABLE_CONFIDENCE,
): reading is ResistorReading {
  return reading !== null && reading.confidence >= minConfidence;
}

/**
 * 読み取り結果を「4.7kΩ ±5%」のように整形する。
 * 読めなかった場合と、確信度が閾値未満の場合は "?" を返す。
 */
export function formatReading(
  reading: ResistorReading | null,
  minConfidence = MIN_REPORTABLE_CONFIDENCE,
): string {
  if (!isReportable(reading, minConfidence)) return '?';

  const tolerance = reading.tolerance === null ? '' : ` ±${reading.tolerance}%`;
  return `${formatOhms(reading.ohms)}${tolerance}`;
}
