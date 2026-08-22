import type { LabColor } from '../types.js';
import type { RoiImage } from './bands/profile.js';
import { srgb255ToLab } from './color/colorSpace.js';
import type { OrientedBox } from './locate.js';
import { medianInPlace } from './math.js';
import { rectify, type RectifyOptions } from './rectify.js';
import { roiGeometry, roiToImage } from './roiMapping.js';

/**
 * ガイド枠を本体へ絞り込む。
 *
 * ガイド枠は「ここに合わせてください」という目印なので、**本体より必ず
 * 大きめに写る**。それをそのまま検出枠として `analyzeOptions` に渡すと、
 * 枠 = 本体という前提で組まれた条件がまとめて外れる:
 *
 * 1. `bodyColumns` が背景の列まで本体と申告し、机や基板がバンドになる
 * 2. `bodyRows` が本体の外に走査線を並べる
 * 3. `rectify` は短軸を `targetHeight` へ正規化するので、**枠が太いぶんだけ
 *    長軸の分解能が落ちる**。太さ 2 倍の枠ではバンド 1 本の幅が半分になる
 *
 * 3 が最も重い。43 枚で枠を膨らませて測ると、長さだけ 1.4 倍では正解
 * 32 → 28 で済むのに対し、太さだけ 2 倍では **正解 32 → 2・誤答 1 → 12** まで
 * 崩れる。ガイド読み取りでラン認識が悪化する主因はここにある。
 *
 * `refine.ts` は**伸ばす**専用（細長さ 2.4 以上の枠には手を出さない）なので、
 * 細長いガイド枠には効かない。縮める側をここに置く。
 */

/** 絞り込みに使う ROI の高さ [px]。断面の中央値を取るのでこの程度で足りる。 */
const FIT_HEIGHT = 48;

/**
 * 絞り込み用の ROI 条件。**パディングを付けない。**
 *
 * 見たいのは「枠の内側のどこまでが本体か」なので、枠の外は要らない。
 * 枠より大きい本体を追いかけるのは `refine.ts` の仕事。
 */
const FIT_RECTIFY: RectifyOptions = { padding: 0, targetHeight: FIT_HEIGHT };

/**
 * 本体と同じ色みとみなす a\*b\* 上の距離。
 *
 * **明度は見ない。** 円筒形ボディは上下の縁へ向かって暗くなるので、明度を
 * 混ぜると陰影だけで本体の縁と判定してしまう。基準色選びで明度を外したのと
 * 同じ理由（`color/anchor.ts` の `nearestBodyReference`）。
 */
const BODY_CHROMA_TOLERANCE = 8;

/** 行の色を測る列の範囲（ROI 幅に対する割合）。中央だけを見る。 */
const CENTER_COLUMN_FRACTION = 0.5;

/** 種の色を取る行の範囲（ROI 高さに対する割合）。ガイドの中心線に対応する。 */
const SEED_ROW_FRACTION = 0.2;

/**
 * 列方向に跨いでよい途切れの長さ（本体の太さに対する割合）。
 *
 * 列を外から見るとバンドは本体色から外れた区間として現れるので、跨がないと
 * 最初のバンドで止まる。バンドの幅は本体の太さの 0.3 倍ほど（`refine.ts` の
 * `MAX_BAND_GAP_RATIO` と同じ見立て）なので、その倍を上限にする。
 */
const MAX_BAND_GAP_RATIO = 0.7;

/**
 * 絞り込みを採用する下限（元の枠に対する割合）。
 *
 * これより小さくなる答えは、利用者が軸を外していて種の色が背景だった等の
 * 事故を疑う。**縮めすぎるより縮めないほうが安全**なので、元の枠を返す。
 */
const MIN_FITTED_FRACTION = 0.25;

/**
 * 絞り込んだ大きさに足す余白（絞り込んだ大きさに対する割合）。
 *
 * 縁ちょうどで切ると、円筒の肩と端のバンドを削る。実測でも、余白なしでは
 * **すでに本体に合っている枠を縮めるだけで正解 32 → 26** に落ちた。
 * 少しだけ外を残す。元の枠は超えないので、余白が悪さをする上限は元の枠。
 */
const FIT_MARGIN = 0.08;

/** 色みだけの距離。明度は見ない（{@link BODY_CHROMA_TOLERANCE}）。 */
function chromaDistance(one: LabColor, other: LabColor): number {
  return Math.hypot(one.a - other.a, one.b - other.b);
}

/** ROI の行 `y` の代表色。`[x0, x1)` の列の中央値を取る。 */
function rowColor(image: RoiImage, y: number, x0: number, x1: number): LabColor {
  const count = x1 - x0;
  const reds = new Uint8ClampedArray(count);
  const greens = new Uint8ClampedArray(count);
  const blues = new Uint8ClampedArray(count);

  for (let i = 0; i < count; i += 1) {
    const offset = (y * image.width + (x0 + i)) * 4;
    reds[i] = image.data[offset] as number;
    greens[i] = image.data[offset + 1] as number;
    blues[i] = image.data[offset + 2] as number;
  }
  return srgb255ToLab(medianInPlace(reds), medianInPlace(greens), medianInPlace(blues));
}

/** ROI の列 `x` の代表色。`[y0, y1)` の行の中央値を取る。 */
function columnColor(image: RoiImage, x: number, y0: number, y1: number): LabColor {
  const count = y1 - y0;
  const reds = new Uint8ClampedArray(count);
  const greens = new Uint8ClampedArray(count);
  const blues = new Uint8ClampedArray(count);

  for (let i = 0; i < count; i += 1) {
    const offset = ((y0 + i) * image.width + x) * 4;
    reds[i] = image.data[offset] as number;
    greens[i] = image.data[offset + 1] as number;
    blues[i] = image.data[offset + 2] as number;
  }
  return srgb255ToLab(medianInPlace(reds), medianInPlace(greens), medianInPlace(blues));
}

/** 複数の Lab の成分ごとの中央値。 */
function medianLab(colors: readonly LabColor[]): LabColor {
  const pick = (select: (color: LabColor) => number): number =>
    medianInPlace(Float64Array.from(colors, select));
  return { l: pick((c) => c.l), a: pick((c) => c.a), b: pick((c) => c.b) };
}

/** 走査の対象範囲（ROI 上の添字）。`end` は含まない。 */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * 中央から外へ歩き、本体色から外れ続けたら止まる。
 *
 * @param center 歩き始める添字
 * @param limit 添字の上限（含まない）
 * @param isBody その添字が本体色か
 * @param maxGap 跨いでよい途切れの長さ
 * @returns 最後に本体だった位置で挟んだ範囲
 */
function walkFromCenter(
  center: number,
  limit: number,
  isBody: (at: number) => boolean,
  maxGap: number,
): Span {
  const walk = (step: number): number => {
    let last = center;
    let gap = 0;
    for (let at = center + step; at >= 0 && at < limit; at += step) {
      if (isBody(at)) {
        last = at;
        gap = 0;
        continue;
      }
      gap += 1;
      if (gap > maxGap) break;
    }
    return last;
  };

  return { start: walk(-1), end: walk(1) + 1 };
}

/**
 * ガイド枠を本体の大きさへ絞り込む。絞り込めなければ元の枠をそのまま返す。
 *
 * 枠の**中心と角度は動かさない**。そこは利用者がガイドに合わせた結果なので、
 * 画像から推し直すより信じるほうが確実（中心線を表示しているのはそのため）。
 * 動かすのは長さと太さだけで、しかも**小さくする方向にしか動かさない**。
 *
 * @param box ガイド枠（本体より大きめに写っている前提）
 * @param image 解析フレーム全体
 */
export function shrinkBoxToBody(
  box: OrientedBox,
  image: RoiImage,
  margin: number = FIT_MARGIN,
): OrientedBox {
  const roi = rectify(image, box, FIT_RECTIFY);
  if (roi.width < 4 || roi.height < 4) return box;

  // 行の色は中央の列だけで測る。本体が枠より短いとき、端の列は背景になる
  const halfWidth = Math.max(1, Math.round((roi.width * CENTER_COLUMN_FRACTION) / 2));
  const centerColumn = Math.floor(roi.width / 2);
  const columnFrom = Math.max(0, centerColumn - halfWidth);
  const columnTo = Math.min(roi.width, centerColumn + halfWidth);

  const rowColors: LabColor[] = [];
  for (let y = 0; y < roi.height; y += 1) rowColors.push(rowColor(roi, y, columnFrom, columnTo));

  // 種は中央の数行。ガイドの中心線に軸を合わせてもらっているので本体に当たる
  const seedHalf = Math.max(1, Math.round((roi.height * SEED_ROW_FRACTION) / 2));
  const centerRow = Math.floor(roi.height / 2);
  const seed = medianLab(
    rowColors.slice(Math.max(0, centerRow - seedHalf), Math.min(roi.height, centerRow + seedHalf)),
  );

  // 短軸: 行を跨ぐものは無いので、外れたらそこが縁
  const rows = walkFromCenter(
    centerRow,
    roi.height,
    (y) => chromaDistance(rowColors[y] as LabColor, seed) <= BODY_CHROMA_TOLERANCE,
    0,
  );
  const bodyHeight = rows.end - rows.start;
  if (bodyHeight < roi.height * MIN_FITTED_FRACTION) return box;

  // 長軸: 本体行の中央値で列を測る。バンドは途切れとして跨ぐ
  const body = medianLab(rowColors.slice(rows.start, rows.end));
  const columns = walkFromCenter(
    centerColumn,
    roi.width,
    (x) => chromaDistance(columnColor(roi, x, rows.start, rows.end), body) <= BODY_CHROMA_TOLERANCE,
    bodyHeight * MAX_BAND_GAP_RATIO,
  );
  const bodyWidth = columns.end - columns.start;
  if (bodyWidth < roi.width * MIN_FITTED_FRACTION) return box;

  const geometry = roiGeometry(box, FIT_RECTIFY);
  const center = roiToImage(
    box,
    FIT_RECTIFY,
    (columns.start + columns.end) / 2,
    (rows.start + rows.end) / 2,
  );

  // 縮める方向にしか動かさない。ガイドより大きい本体は refine.ts の領分
  return {
    ...box,
    centerX: center.x,
    centerY: center.y,
    length: Math.min(box.length, (bodyWidth * (1 + margin)) / geometry.scale),
    thickness: Math.min(box.thickness, (bodyHeight * (1 + margin)) / geometry.scale),
  };
}
