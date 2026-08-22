import type { Band } from '../types.js';
import type { OrientedBox } from '../core/locate.js';
import type { RectifyOptions } from '../core/rectify.js';
import { bandCorners, labelAnchor, labelDirection, labelSide } from '../core/roiMapping.js';
import { BAND_COLOR_ABBR, BAND_COLOR_JA, bandColorCss } from '../core/color/colors.js';
import { roleTextsFor, type UsedRun } from '../core/value/jointDecode.js';

/**
 * 検出結果を元の写真に焼き込む。
 *
 * 「検出が外れているのか」「バンド分割が外れているのか」「分類が外れて
 * いるのか」を写真 1 枚で切り分けられるようにするのが目的。座標計算は
 * すべて `core/roiMapping` に寄せてあるので、ここは描画だけを担う。
 */

/** 検出ボックスの枠色。赤。 */
const BOX_COLOR = '#ff3b30';

/** バンド帯の塗り。写真と紛れないよう白の半透明にする。 */

/** ラベルを箱の縁からどれだけ離すか（箱の太さに対する割合）。 */
const LABEL_OFFSET_RATIO = 0.55;

/** ラベル文字の大きさ（箱の太さに対する割合）。 */
const LABEL_SIZE_RATIO = 0.5;

const MIN_LABEL_PX = 11;
const MAX_LABEL_PX = 42;

/** 確信度がこれ未満のラベルは薄く描く（誤分類を見分けるため）。 */
const LOW_CONFIDENCE = 0.35;

/**
 * 色見本の一辺（文字サイズに対する割合）。
 *
 * 丸ではなく四角にしてある。同じ差し渡しでも面積が広く、金/黄・灰/銀の
 * ように明度だけが違う組を見分けやすい。
 */
const SWATCH_SIZE_RATIO = 0.8;

/**
 * 色見本の中心を色名の書き出し位置からどれだけ手前へ置くか
 * （文字サイズに対する割合）。文字は左揃えで x=0 から右へ伸びるので、
 * 一辺の半分ぶんの余白が残るように取る。
 */
const SWATCH_OFFSET_RATIO = 0.62;

export interface OverlayOptions {
  /** ROI を切り出したときと同じ設定。座標を正しく逆変換するために必要。 */
  readonly rectify: RectifyOptions;
  /** 色名を日本語 1 文字で出す（既定）。false なら英字 3 文字の略号。 */
  readonly japanese?: boolean;
  /**
   * ラベルの文字サイズ [px]（描画先の座標系）。
   * 未指定なら箱の太さに比例させる（焼き込み画像向け）。ライブ表示では
   * 見た目の大きさを一定にしたいので、換算した値を渡す。
   */
  readonly textPx?: number;
  /**
   * 同時デコードが採用したラン（`JointReading.usedRuns`）。
   *
   * 与えると、意味の欄は**デコーダが決めた役割**になり、採用されなかった
   * ランは「除外」として破線・半透明で描かれる。省略すると従来どおり
   * 全バンドから独立に役割を組み立てる（joint の解が無い経路向け）。
   *
   * 表示だけを独立分類のままにすると、金属容疑として除外した本体色のランが
   * カラーコードとして画面に出る。値は守られているのに読み取りが壊れて
   * 見えるので、**画面と値は同じ解釈から描く**。
   */
  readonly usedRuns?: readonly UsedRun[];
  /** ノイズとして捨てたランの添字（`JointReading.droppedRuns`）。 */
  readonly droppedRuns?: readonly number[];
}

/** 除外したランの帯・意味に使う色。バンド色と紛れないよう灰色にする。 */
const DROPPED_COLOR = '#8e8e93';

/** 除外したランの帯の破線の刻み [px]（文字サイズに対する割合で使う）。 */
const DROPPED_DASH_RATIO = [0.35, 0.28] as const;

/** 除外したランを描く不透明度。 */
const DROPPED_ALPHA = 0.5;

/** バンドの不透明度。除外を最優先で薄くし、それ以外は確信度が低ければ薄くする。 */
function bandAlpha(isDropped: boolean, confidence: number): number {
  if (isDropped) return DROPPED_ALPHA;
  return confidence < LOW_CONFIDENCE ? 0.55 : 1;
}

/**
 * 色名の先へ値をずらす量（文字サイズに対する割合）。
 * 略号 3 文字ぶん + 間隔。位置で決め打つので、値の文字数が違っても揃う。
 */
const VALUE_GAP_RATIO = 2.6;

/**
 * 寝かせた文字を描く。どんな背景でも読めるよう白フチを付ける。
 * `anchor` を先頭に、`angle` の向きへ伸ばす（開始位置を揃えるため左寄せ）。
 */
function drawSidewaysText(
  context: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  angle: number,
  text: string,
  fillStyle: string,
  fontPx: number,
): void {
  context.save();
  context.translate(anchor.x, anchor.y);
  context.rotate(angle);
  context.textAlign = 'left';
  context.lineWidth = Math.max(2, fontPx * 0.22);
  context.strokeStyle = 'rgb(255 255 255 / 0.92)';
  context.strokeText(text, 0, 0);
  context.fillStyle = fillStyle;
  context.fillText(text, 0, 0);
  context.restore();
}

function drawPolygon(
  context: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
): void {
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
}

/**
 * 抵抗器を囲む赤い回転ボックス。
 *
 * ROI にはパディングが乗っているので、囲むのは padding を含まない
 * 「検出した箱そのもの」。ここだけ素の寸法から四隅を出す。
 */
export function drawDetectionBox(context: CanvasRenderingContext2D, box: OrientedBox): void {
  context.save();
  context.strokeStyle = BOX_COLOR;
  context.lineWidth = Math.max(2, Math.round(box.thickness / 14));
  drawPolygon(context, boxCorners(box));
  context.stroke();
  context.restore();
}

/** 箱の四隅（元画像座標）。パディングは含まない。 */
function boxCorners(box: OrientedBox): { x: number; y: number }[] {
  const rad = (box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfLength = box.length / 2;
  const halfThickness = box.thickness / 2;

  return (
    [
      [-halfLength, -halfThickness],
      [halfLength, -halfThickness],
      [halfLength, halfThickness],
      [-halfLength, halfThickness],
    ] as const
  ).map(([along, across]) => ({
    x: box.centerX + along * cos - across * sin,
    y: box.centerY + along * sin + across * cos,
  }));
}

/** 各バンドの範囲を帯で塗り、色名を縁の外側に添える。 */
export function drawBandLabels(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  bands: readonly Band[],
  options: OverlayOptions,
): void {
  if (bands.length === 0) return;

  const fontPx = Math.round(
    options.textPx ??
      Math.min(MAX_LABEL_PX, Math.max(MIN_LABEL_PX, box.thickness * LABEL_SIZE_RATIO)),
  );
  const baseOffset = box.thickness * LABEL_OFFSET_RATIO;
  // 注釈は水平な抵抗器なら下、垂直なら右に出す
  const side = labelSide(box);
  const direction = labelDirection(box);
  // 注釈の向きへ回す角度。水平な抵抗器なら 90°＝文字は下へ伸び、文字の下
  // （ベースライン側）が画面の左を向く
  const angle = Math.atan2(direction.y, direction.x);
  // 色列が表す意味（数字・倍率・許容差）。読み取り方向は core が決める。
  // デコーダの解釈が渡されていればそちらが正で、独立分類からは組み立て直さない
  const usedByIndex = new Map((options.usedRuns ?? []).map((used) => [used.runIndex, used]));
  const dropped = new Set(options.droppedRuns ?? []);
  const fallbackRoles =
    options.usedRuns === undefined ? roleTextsFor(bands.map((band) => band.color)) : null;

  context.save();
  context.font = `700 ${fontPx}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  bands.forEach((band, index) => {
    const used = usedByIndex.get(index);
    // 採用情報があるのに載っていないランは、デコーダが使わなかったということ
    const isDropped = dropped.has(index) || (options.usedRuns !== undefined && used === undefined);

    // 帯: バンドの占める範囲を示す（塗らない。色帯そのものを隠さないため）
    context.save();
    drawPolygon(context, bandCorners(box, options.rectify, band));
    context.strokeStyle = isDropped ? DROPPED_COLOR : bandColorCss(band.color);
    context.lineWidth = Math.max(1, Math.round(box.thickness / 22));
    if (isDropped) {
      context.setLineDash(DROPPED_DASH_RATIO.map((step) => Math.max(2, step * fontPx)));
    }
    context.stroke();
    context.restore();

    context.globalAlpha = bandAlpha(isDropped, band.confidence);

    // 番号: バンドのすぐ外側。色空間の面に出る番号と対応する
    const numberAt = labelAnchor(box, options.rectify, band, fontPx * 0.8, side);
    context.lineWidth = Math.max(2, fontPx * 0.22);
    context.strokeStyle = 'rgb(255 255 255 / 0.92)';
    context.strokeText(String(index + 1), numberAt.x, numberAt.y);
    context.fillStyle = BOX_COLOR;
    context.fillText(String(index + 1), numberAt.x, numberAt.y);

    // 色名とカラーコードの値。どちらも全バンドで同じ位置から始めるので、
    // 隣り合うバンドどうしで縦に揃って読める（バンドごとの段違いはしない）。
    // 注釈を積む向きへ寝かせて描く（水平な抵抗器なら文字は下へ伸びる）。
    const nameAt = labelAnchor(box, options.rectify, band, baseOffset + fontPx * 1.4, side);
    const valueAt = labelAnchor(
      box,
      options.rectify,
      band,
      baseOffset + fontPx * (1.4 + VALUE_GAP_RATIO),
      side,
    );

    // 色見本（金/黄、灰/銀の取り違えを目で確かめられるように）。色名の手前に置く
    context.save();
    context.translate(nameAt.x, nameAt.y);
    context.rotate(angle);
    const swatch = fontPx * SWATCH_SIZE_RATIO;
    context.beginPath();
    context.rect(-fontPx * SWATCH_OFFSET_RATIO - swatch / 2, -swatch / 2, swatch, swatch);
    context.fillStyle = bandColorCss(band.color);
    context.fill();
    context.strokeStyle = 'rgb(0 0 0 / 0.5)';
    context.lineWidth = 1;
    context.stroke();
    context.restore();

    const name = (options.japanese ?? true)
      ? BAND_COLOR_JA[band.color]
      : BAND_COLOR_ABBR[band.color];
    // 意味は「デコーダがどう扱ったか」。除外したものは値を書かず、そう書く
    const meaning = isDropped ? '除外' : (used?.roleText ?? fallbackRoles?.[index] ?? '?');
    drawSidewaysText(context, nameAt, angle, name, isDropped ? DROPPED_COLOR : BOX_COLOR, fontPx);
    drawSidewaysText(
      context,
      valueAt,
      angle,
      meaning,
      isDropped ? DROPPED_COLOR : BOX_COLOR,
      fontPx,
    );
    context.globalAlpha = 1;
  });

  context.restore();
}

/** ガイドの中心線の太さと破線の刻み [px]（`unitPx` 倍して使う）。 */
const GUIDE_LINE_WIDTH = 1.5;
const GUIDE_DASH = [6, 5] as const;

/**
 * ガイド枠そのもの（白い破線の長方形と中心線）。
 *
 * **赤い枠とは見た目を分ける。** 赤は「解析が本体と見なした範囲」に使うので、
 * 利用者が合わせる目印を同じ色で描くと、両者がずれているときに気づけない。
 * 白い破線が置き場所、赤が実際に読んだ範囲。
 *
 * @param unitPx 画面 1px に相当する描画先の px 数（線の太さを一定に保つ）
 */
export function drawGuideOutline(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  unitPx = 1,
): void {
  context.save();
  context.strokeStyle = 'rgb(255 255 255 / 0.9)';
  context.lineWidth = GUIDE_LINE_WIDTH * unitPx;
  context.setLineDash(GUIDE_DASH.map((step) => step * unitPx));
  drawPolygon(context, boxCorners(box));
  context.stroke();
  context.restore();

  drawGuideCenterline(context, box, unitPx);
}

/**
 * ガイド枠の長手方向の中心線（細い白の点線）。
 *
 * 抵抗器の軸を枠の中心へ合わせる目印。枠の内側なので、被写体を隠さない
 * よう細く点線にする。
 *
 * @param unitPx 画面 1px に相当する描画先の px 数（線の太さを一定に保つ）
 */
export function drawGuideCenterline(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  unitPx = 1,
): void {
  const rad = (box.angleDeg * Math.PI) / 180;
  const halfX = (Math.cos(rad) * box.length) / 2;
  const halfY = (Math.sin(rad) * box.length) / 2;

  context.save();
  context.strokeStyle = 'rgb(255 255 255 / 0.9)';
  context.lineWidth = GUIDE_LINE_WIDTH * unitPx;
  context.setLineDash(GUIDE_DASH.map((step) => step * unitPx));
  context.beginPath();
  context.moveTo(box.centerX - halfX, box.centerY - halfY);
  context.lineTo(box.centerX + halfX, box.centerY + halfY);
  context.stroke();
  context.restore();
}

/** 推定値の文字の大きさ（箱の太さに対する割合）。バンドラベルより大きく。 */
const READING_SIZE_RATIO = 0.75;

const MIN_READING_PX = 14;
const MAX_READING_PX = 56;

/**
 * 推定した抵抗値を箱のそばに描く（ライブ表示用）。
 *
 * バンドラベルは {@link labelDirection} の向き（水平なら下、垂直なら右）に
 * 出るので、値はその**反対側**に出して重なりを避ける。渡す文字列は
 * `formatReading()` の戻り値をそのまま使うこと — 確信度が閾値未満のとき
 * 「?」になる規約を format 側が担保している。
 */
export function drawReadingLabel(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  text: string,
  textPx?: number,
): void {
  const fontPx = Math.round(
    textPx ??
      Math.min(MAX_READING_PX, Math.max(MIN_READING_PX, box.thickness * READING_SIZE_RATIO)),
  );
  const direction = labelDirection(box);
  // バンドラベルの反対側へ 2 行ぶん離す。1 行だと枠の縁に重なって読みにくい
  const offset = box.thickness / 2 + fontPx * 2;
  const x = box.centerX - direction.x * offset;
  const y = box.centerY - direction.y * offset;

  context.save();
  context.font = `700 ${fontPx}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineWidth = Math.max(3, fontPx * 0.22);
  context.strokeStyle = 'rgb(255 255 255 / 0.92)';
  context.strokeText(text, x, y);
  context.fillStyle = BOX_COLOR;
  context.fillText(text, x, y);
  context.restore();
}

/** 箱とバンドをまとめて描く。 */
export function drawDetectionOverlay(
  context: CanvasRenderingContext2D,
  box: OrientedBox,
  bands: readonly Band[],
  options: OverlayOptions,
): void {
  drawDetectionBox(context, box);
  drawBandLabels(context, box, bands, options);
}
