import type { ProfileSample } from '../../types.js';
import { srgb255ToLab } from '../color/colorSpace.js';
import { clamp, clamp01, medianInPlace } from '../math.js';

/**
 * ROI（水平化済みの抵抗器画像）の生ピクセル。
 * DOM に依存しないよう ImageData そのものではなく最小の構造で受け取る。
 *
 * **不変条件: 長軸は X 方向**。回転した抵抗器は呼び出し側で水平化してから
 * 渡すこと（Phase 3 では OBB の角度で回転補正してから切り出す）。
 */
export interface RoiImage {
  readonly width: number;
  readonly height: number;
  /** RGBA が 4 バイトずつ並んだ配列（ImageData.data と同じ並び） */
  readonly data: Uint8ClampedArray;
}

export interface ProfileOptions {
  /**
   * 長軸に沿ってサンプリングする中央帯の割合 0..1。
   * リード線や輪郭のぼけを避けるため既定では中央 50% のみを使う。
   */
  readonly centerFraction?: number;
}

/** ROI 上の行範囲。`bodyRows` の戻り値をそのまま渡せる。 */
export interface RowRange {
  readonly start: number;
  readonly end: number;
}

export interface ScanProfileOptions extends ProfileOptions {
  /**
   * 走査線の本数。既定は {@link SCAN_COUNT}。
   *
   * 本体の高さを `scanCount + 1` で割った内側の境界に走査線を引き、
   * 各走査線は自分の持ち分（1 / (scanCount + 1)）の行の中央値を取る。
   * 隣の走査線と重ならないので、走査線どうしは独立した観測になる。
   */
  readonly scanCount?: number;
  /**
   * 本体が占める行範囲（`bodyRows` の結果）。
   *
   * ROI はパディングぶん本体より太いので、ROI 全体を等分すると**両端の
   * 走査線が本体の外に落ちる**（padding 0.28 のとき本体は ROI 高さの中央
   * 64% で、8 等分の 1 本目と 7 本目は背景かリード線）。列側で
   * `bodyRange` を事前情報にしたのと同じ理由で、検出側の答えを使う。
   *
   * 省略すると中央帯（{@link ProfileOptions.centerFraction}）を等分する。
   */
  readonly bodyRows?: RowRange;
}

const DEFAULT_CENTER_FRACTION = 0.5;
const CHANNELS = 4;

/**
 * 走査線の既定本数。本体の高さを 8 分割した内側の境界に 7 本引く。
 *
 * **走査線は値の決定には使わない。** バンド色が行方向にどれだけばらついて
 * いるかを測り、確信度の減点に使うだけ（`bands/scanSpread.ts`）。値の側で
 * 使う案（列単位で畳む・走査線ごとに色順応する・切れ目を多数決する・
 * バンド色を融合する）はすべて実測で棄却した。
 * 経緯は `docs/14-走査線の多重化を測った結果.md`。
 */
export const SCAN_COUNT = 7;

/**
 * ROI を長軸方向の 1D カラープロファイルに変換する。
 *
 * 各列について中央帯の複数行をサンプリングし、チャンネルごとの**中央値**を取る。
 * 平均ではなく中央値なのは、光沢ボディの鏡面反射による白飛びが 1〜2 行混じっても
 * 結果が引っ張られないようにするため。
 *
 * @throws {RangeError} data の長さが width×height×4 と一致しない場合
 */
export function extractProfile(image: RoiImage, options: ProfileOptions = {}): ProfileSample[] {
  if (!hasPixels(image)) return [];

  const centerFraction = clampFraction(options.centerFraction ?? DEFAULT_CENTER_FRACTION);
  const { start, end } = centerRange(image.height, centerFraction);
  return profileForRows(image, start, end);
}

/**
 * ROI を複数本の 1D カラープロファイルに変換する（走査線の多重化）。
 *
 * 本体の高さを `scanCount + 1` で等分し、内側の境界に走査線を引く。返る配列は
 * **上から下の順**で、各要素は {@link extractProfile} と同じ形の 1 本の
 * プロファイル。バンドは本体の全高にわたる縦縞なので、どの走査線も同じ
 * バンド列を見ているはず — 見えていなければ反射か残留回転を疑える。
 * それを測るのが `bands/scanSpread.ts`。
 *
 * @throws {RangeError} data の長さが width×height×4 と一致しない場合
 */
export function extractProfiles(
  image: RoiImage,
  options: ScanProfileOptions = {},
): ProfileSample[][] {
  if (!hasPixels(image)) return [];
  return scanRowRanges(image.height, options).map((rows) =>
    profileForRows(image, rows.start, rows.end),
  );
}

/**
 * 走査線が見る行範囲（上から下の順）。
 *
 * 本体の高さを `scanCount + 1` で等分し、内側の境界に走査線を引く。
 * 焼き込み画像に走査線を重ねるときも、**この関数の結果を使う**こと
 * （描く位置と読む位置がずれると、見ているものが分からなくなる）。
 */
export function scanRowRanges(
  height: number,
  options: ScanProfileOptions = {},
): RowRange[] {
  if (height <= 0) return [];

  const scanCount = Math.max(1, Math.round(options.scanCount ?? SCAN_COUNT));
  const span = scanSpan(height, options);
  // 各走査線の持ち分。等分した境界に引くので分母は scanCount + 1
  const scanHeight = (span.end - span.start) / (scanCount + 1);

  const ranges: RowRange[] = [];
  for (let index = 1; index <= scanCount; index += 1) {
    const center = span.start + scanHeight * index;
    const start = clamp(Math.round(center - scanHeight / 2), 0, height - 1);
    ranges.push({ start, end: clamp(Math.round(center + scanHeight / 2), start + 1, height) });
  }
  return ranges;
}

/**
 * 行範囲 `[yStart, yEnd)` を 1 本のプロファイルにする。
 * `extractProfile` と `extractProfiles` の共通部分。
 */
function profileForRows(image: RoiImage, yStart: number, yEnd: number): ProfileSample[] {
  const { width, data } = image;
  const rowCount = yEnd - yStart;

  // 列ごとに使い回すスクラッチバッファ。medianInPlace が破壊的にソートするが、
  // 次の列で全要素を上書きするので問題ない。
  const reds = new Uint8ClampedArray(rowCount);
  const greens = new Uint8ClampedArray(rowCount);
  const blues = new Uint8ClampedArray(rowCount);

  const samples: ProfileSample[] = [];
  for (let x = 0; x < width; x += 1) {
    for (let i = 0; i < rowCount; i += 1) {
      const offset = ((yStart + i) * width + x) * CHANNELS;
      reds[i] = data[offset] as number;
      greens[i] = data[offset + 1] as number;
      blues[i] = data[offset + 2] as number;
    }
    samples.push({
      x,
      lab: srgb255ToLab(medianInPlace(reds), medianInPlace(greens), medianInPlace(blues)),
    });
  }

  return samples;
}

/**
 * 画素があるか。無ければ呼び出し側は空配列を返す。
 *
 * @throws {RangeError} data の長さが width×height×4 と一致しない場合
 */
function hasPixels(image: RoiImage): boolean {
  const { width, height, data } = image;
  if (data.length !== width * height * CHANNELS) {
    throw new RangeError(
      `data length ${data.length} does not match width×height×4 (${width * height * CHANNELS})`,
    );
  }
  return width > 0 && height > 0;
}

/** 走査線を並べる行範囲。本体行範囲が無ければ中央帯に落とす。 */
function scanSpan(height: number, options: ScanProfileOptions): RowRange {
  const body = options.bodyRows;
  if (body === undefined) {
    return centerRange(height, clampFraction(options.centerFraction ?? DEFAULT_CENTER_FRACTION));
  }

  const start = clamp(Math.round(body.start), 0, height - 1);
  return { start, end: clamp(Math.round(body.end), start + 1, height) };
}

/** 中央帯の行範囲。少なくとも 1 行は必ず含む。 */
function centerRange(height: number, fraction: number): RowRange {
  const bandHeight = Math.max(1, Math.round(height * fraction));
  const start = Math.floor((height - bandHeight) / 2);
  return { start, end: Math.min(height, start + bandHeight) };
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : DEFAULT_CENTER_FRACTION;
}
