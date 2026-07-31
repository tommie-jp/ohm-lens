import type { RoiImage } from '../../core/bands/profile.js';
import type { OrientedBox } from '../../core/locate.js';
import type { AnalysisResult } from '../../core/pipeline.js';
import type { BandColor, LabColor } from '../../types.js';

/**
 * メインスレッドと解析 Worker の間のメッセージ型。
 *
 * どのメンバーもプレーンな数値・文字列・配列・`ArrayBuffer` だけで構成し、
 * 構造化クローンでそのまま渡せるようにする。DOM の型（`ImageData` など）は
 * ここに持ち込まない（Worker 側を DOM 非依存に保ち、node のテストで
 * そのまま動かすため）。
 */

/**
 * 解析の 3 経路を 1 つのプロトコルに載せるためのモード。
 *
 * - `auto`: 画像全体から抵抗器を検出して読む（静止画の自動検出・ライブ自動）
 * - `box`: 検出済みの枠で切り出して読む（ライブガイド。`guideBox` は
 *   表示サイズに依存するのでメインスレッドで計算して渡す）
 * - `roi`: 画像を ROI そのものとして解析する（静止画の手動指定）
 */
export type AnalysisMode =
  | { readonly kind: 'auto' }
  | { readonly kind: 'box'; readonly box: OrientedBox }
  | {
      readonly kind: 'roi';
      /**
       * 色順応補正を行うか。
       *
       * **`roi` にだけ置くのは、他の 2 モードでは指定しても効かないから。**
       * `auto` と `box` は `settings.ts` の `analyzeOptions` が条件を組むので、
       * そこの既定値（有効）が必ず勝つ。全モード共通の欄に置くと「指定できる
       * のに 3 分の 2 では黙って無視される」形になるため、型で締める。
       */
      readonly adaptWhiteBalance: boolean;
    };

/**
 * 転送用の画像。`pixels` は RGBA 並び（`ImageData.data` と同じ）。
 *
 * `ArrayBuffer` にしてあるのは postMessage の transfer リストに載せて
 * ゼロコピーで渡すため。**transfer に載せたバッファは detach されるので、
 * 送った側はその後 `pixels`（と元の `RoiImage.data`）に触らないこと。**
 * `getImageData` の結果は毎回新しいコピーなので、通常経路では問題にならない。
 */
export interface TransferImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: ArrayBuffer;
}

/** メイン → Worker: 1 フレームぶんの解析依頼。 */
export interface AnalysisRequest {
  /** 応答との突き合わせ用。クライアントが単調増加で振る。 */
  readonly frameId: number;
  readonly image: TransferImage;
  readonly mode: AnalysisMode;
  /**
   * 学習結果込みのパレット（`activePalette()?.colors`）。null なら既定。
   * `Palette.entries` は Worker 側で `createPalette` が作り直すので送らない。
   * 毎リクエストに載せることで「学習直後に古いパレットの応答が返る」
   * 順序問題を構造的に避ける（Worker に状態を持たせない）。
   */
  readonly paletteColors: Record<BandColor, LabColor> | null;
}

/**
 * 解析結果のうち UI が読む部分だけ。
 *
 * **足し算で並べる**（`Omit` で引かない）。引き算にすると `AnalysisResult` に
 * 項目が増えたとき、転送するものが黙って太る。特に `scans`（走査線 7 本ぶんの
 * プロファイル）は構造化クローンが 452µs → 63µs と 7 倍違うので、
 * 何を載せるかは意識して選ぶ。
 */
export type AnalysisSummary = Pick<
  AnalysisResult,
  'profile' | 'bands' | 'runs' | 'reading' | 'anchor'
>;

/** Worker → メイン: 解析結果。 */
export interface AnalysisResponse {
  readonly frameId: number;
  /** 検出・補正後の枠。オーバーレイ描画と平滑化に使う。 */
  readonly box: OrientedBox | null;
  /** 水平化した ROI。右カラムの表示に使う。 */
  readonly roi: TransferImage | null;
  /** 解析できなかったとき（`auto` で検出に失敗）は null。例外にはしない。 */
  readonly analysis: AnalysisSummary | null;
  /** Worker 内の実測時間。表示・デバッグ用（バジェット判断はメイン側の往復時間）。 */
  readonly durationMs: number;
}

/** `RoiImage` を転送用に包む。バッファ全体を指す view ならコピーしない。 */
export function toTransferImage(image: RoiImage): TransferImage {
  const spansWholeBuffer =
    image.data.byteOffset === 0 && image.data.byteLength === image.data.buffer.byteLength;
  const pixels = spansWholeBuffer
    ? image.data.buffer
    : image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength);
  return { width: image.width, height: image.height, pixels: pixels as ArrayBuffer };
}

/** 転送用の画像を解析パイプラインの入力型に戻す（コピーしない）。 */
export function toRoiImage(image: TransferImage): RoiImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.pixels) };
}
