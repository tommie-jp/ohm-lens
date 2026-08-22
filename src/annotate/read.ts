import { analyzeRoi, type AnalysisResult } from '../core/pipeline.js';
import { locateResistor, type OrientedBox } from '../core/locate.js';
import { rectify } from '../core/rectify.js';
import { refineBoxExtent } from '../core/refine.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../core/settings.js';
import { formatConfidence, formatOhms, isReadableSize, isReportable } from '../core/format.js';
import type { JointReading } from '../core/value/jointDecode.js';
import { DEFAULT_PALETTE, type Palette } from '../core/color/palette.js';
import type { RoiImage } from '../core/bands/profile.js';

/**
 * 1 枚の画像を「本番と同じ条件」で読み取る、描画を含まない中核。
 *
 * GUI・バッチ（`scripts/detect.ts`）・フィクスチャ（`tests/fixtures/`）が
 * **同じ経路で測る**ための共通実装。以前はフィクスチャだけが
 * `ROI_PADDING = 0.06` を直書きし、`refineBoxExtent` も `bodyRange` も
 * 渡していなかったため、レポートの数字がバッチと一致しなかった。
 * 解析条件は必ず `core/settings.ts` 経由にすること。
 *
 * 焼き込み画像が要る場合は、これを使う `annotate/pipeline.ts` の
 * `annotateImage` を呼ぶ。
 */

/** 読み取り値がこの相対誤差以内なら期待値と一致とみなす。 */
const VALUE_TOLERANCE = 1e-6;

export interface ReadOptions {
  readonly palette?: Palette;
  /** 期待値（MANIFEST から分かる場合）。`correct` の判定に使う。 */
  readonly expectedOhms?: number;
}

export interface ReadResult {
  readonly located: boolean;
  /** 検出できた場合の回転ボックス（枠を広げ直した後）。 */
  readonly box: OrientedBox | null;
  /** 水平化した ROI。検出できなければ null。 */
  readonly roi: RoiImage | null;
  readonly analysis: AnalysisResult | null;
  /** 役割つきの解釈。バンドが足りなければ null。 */
  readonly joint: JointReading | null;
  readonly ohms: number | null;
  /**
   * 検出枠が読める解像度に達しているか（`isReadableSize`）。
   * 足りないときは値を出さない（`ohms` は null、確信度は 0）。
   */
  readonly readable: boolean;
  readonly confidence: number;
  /**
   * 確信度が閾値を超えていて、値として出してよいか。
   * 低いものは実機では「?」になる（誤った値を自信ありげに出さない方針）。
   */
  readonly confident: boolean;
  /** 期待値と一致したか。期待値が無ければ常に false。 */
  readonly correct: boolean;
}

/** 検出に失敗したときの結果。 */
function notLocated(): ReadResult {
  return {
    located: false,
    box: null,
    roi: null,
    analysis: null,
    joint: null,
    ohms: null,
    readable: false,
    confidence: 0,
    confident: false,
    correct: false,
  };
}

/**
 * 検出 → 枠の広げ直し → ROI 切り出し → 解析 → 役割つきデコード。
 *
 * 検出に失敗しても例外にせず `located: false` を返す。
 * デバッグ用途では失敗が消えてしまわないことが大事。
 */
export function readResistorImage(image: RoiImage, options: ReadOptions = {}): ReadResult {
  const palette = options.palette ?? DEFAULT_PALETTE;
  const located = locateResistor(image);
  if (located === null) return notLocated();

  // カラーコードの並びを手がかりに、枠を長軸方向へ広げ直す
  const box = refineBoxExtent(located, image, refineOptions(palette));
  const roi = rectify(image, box, ROI_OPTIONS);
  const analysis = analyzeRoi(roi, analyzeOptions(box, palette));
  // 役割つきの解釈は解析が持っているものをそのまま使う。**取り直さない** —
  // 条件を 1 つ取り違えただけで確信度が analysis 側とずれ、レポートが二枚舌になる
  const joint = analysis.joint;

  // 読める解像度に達していない枠からは値を出さない。バンド 1 本が数画素しか
  // ない枠を rectify が拡大しても情報は増えず、当たっていても偶然になる
  const readable = isReadableSize(box);
  const ohms = readable ? (analysis.reading?.ohms ?? null) : null;
  const expected = options.expectedOhms;

  return {
    located: true,
    box,
    roi,
    analysis,
    joint,
    ohms,
    readable,
    confidence: readable ? (analysis.reading?.confidence ?? 0) : 0,
    confident: readable && isReportable(analysis.reading ?? null),
    correct:
      expected !== undefined && ohms !== null && Math.abs(ohms - expected) / expected < VALUE_TOLERANCE,
  };
}

/**
 * 実機での見え方の三分。
 *
 * 「値一致」だけを見ていると、自信ありげな誤答が何件あるか分からない。
 * 誤った値を自信ありげに出さない方針なので、`wrong` が何件残るかが要点。
 */
export type Verdict = 'correct' | 'wrong' | 'held';

export function verdictOf(result: ReadResult): Verdict {
  if (result.ohms === null || !result.confident) return 'held';
  return result.correct ? 'correct' : 'wrong';
}

/**
 * ラン数が正解と合っているか。
 *
 * 値が当たっているかとは別の指標。値が保留でも本数が合っていれば分割は
 * 正しく、逆に本数が違えば値が当たっていても偶然を疑う。
 * 検出できなかった写真は 0 本として `fewer` に入れる（別勘定にすると
 * 3 つの合計が枚数と合わなくなる）。
 */
export type RunVerdict = 'same' | 'fewer' | 'more';

export function runVerdict(detected: number, expected: number): RunVerdict {
  if (detected === expected) return 'same';
  return detected < expected ? 'fewer' : 'more';
}

/**
 * 「32(74%)」のように件数と割合を並べる。
 *
 * 母数が 0 のときは割合を書かない。0% と書くと「測ったが 0 だった」に
 * 見えるが、実際は測れていない。
 */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return `${part}(-)`;
  return `${part}(${((part / whole) * 100).toFixed(0)}%)`;
}

/** 進捗表示・集計用の 1 行。`summary.txt` と同じ書式。 */
export function captionFor(result: ReadResult, label: string, expectedOhms?: number): string {
  const expected = expectedOhms === undefined ? '期待 不明' : `期待 ${formatOhms(expectedOhms)}`;
  if (!result.located) return `${label} | ${expected} | 検出失敗`;

  const box = result.box as OrientedBox;
  const bandSummary = (result.joint?.usedRuns ?? [])
    .map((used) => `${used.color}${used.roleText}`)
    .join(' ');

  return (
    `${label} | ${expected} → ` +
    `${result.ohms === null ? '読取不可' : `${formatOhms(result.ohms)}${result.confident ? '' : '(保留)'}`} ` +
    `[確信度 ${formatConfidence(result.confidence)}] | ` +
    `${box.angleDeg.toFixed(0)}° L${Math.round(box.length)} T${Math.round(box.thickness)} ` +
    `(比 ${(box.length / box.thickness).toFixed(2)}) | ${bandSummary}`
  );
}
