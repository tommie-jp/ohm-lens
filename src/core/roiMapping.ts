import type { OrientedBox } from './locate.js';
import type { RectifyOptions } from './rectify.js';

/**
 * ROI 座標と元画像座標の相互変換。
 *
 * `rectify` は元画像から ROI を切り出す（順方向）。検出結果を元の写真に
 * 焼き込んで確認するには逆方向が要る。順方向と同じ式をここに 1 か所だけ
 * 置き、`rectify` からも使うことで二重管理を避ける。
 *
 * ROI の X 軸は箱の長軸、Y 軸は短軸に対応する。
 */

const DEFAULT_PADDING = 0;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** ROI の大きさと、元画像との対応に必要な量。 */
export interface RoiGeometry {
  /** ROI の幅 [px] */
  readonly width: number;
  /** ROI の高さ [px] */
  readonly height: number;
  /** 元画像 → ROI の拡縮率 */
  readonly scale: number;
  /** パディングを含めた長軸方向の長さ（元画像スケール） */
  readonly sourceLength: number;
  /** パディングを含めた短軸方向の太さ（元画像スケール） */
  readonly sourceThickness: number;
  /** 長軸の単位ベクトル */
  readonly cos: number;
  readonly sin: number;
}

/** `rectify` が作る ROI の寸法と対応関係を求める。 */
export function roiGeometry(box: OrientedBox, options: RectifyOptions): RoiGeometry {
  const padding = options.padding ?? DEFAULT_PADDING;
  const sourceLength = Math.max(1, box.length * (1 + padding * 2));
  const sourceThickness = Math.max(1, box.thickness * (1 + padding * 2));

  const scale =
    options.targetWidth !== undefined
      ? Math.max(1, options.targetWidth) / sourceLength
      : options.targetHeight !== undefined
        ? Math.max(1, options.targetHeight) / sourceThickness
        : 1;

  const rad = (box.angleDeg * Math.PI) / 180;
  return {
    width: Math.max(1, Math.round(sourceLength * scale)),
    height: Math.max(1, Math.round(sourceThickness * scale)),
    scale,
    sourceLength,
    sourceThickness,
    cos: Math.cos(rad),
    sin: Math.sin(rad),
  };
}

/**
 * ROI 座標を元画像座標に写す。
 *
 * `rectify` のサンプリングと同じ式なので、ROI の画素 (x, y) が元画像の
 * どこから来たかを正確に辿れる。
 */
export function roiToImage(
  box: OrientedBox,
  options: RectifyOptions,
  roiX: number,
  roiY: number,
): Point {
  const geometry = roiGeometry(box, options);
  const along = roiX / geometry.scale - geometry.sourceLength / 2;
  const across = roiY / geometry.scale - geometry.sourceThickness / 2;

  return {
    x: box.centerX + along * geometry.cos - across * geometry.sin,
    y: box.centerY + along * geometry.sin + across * geometry.cos,
  };
}

/** 元画像座標を ROI 座標に写す（{@link roiToImage} の逆）。 */
export function imageToRoi(
  box: OrientedBox,
  options: RectifyOptions,
  imageX: number,
  imageY: number,
): Point {
  const geometry = roiGeometry(box, options);
  const dx = imageX - box.centerX;
  const dy = imageY - box.centerY;

  // 長軸・短軸への射影（回転行列の転置）
  const along = dx * geometry.cos + dy * geometry.sin;
  const across = -dx * geometry.sin + dy * geometry.cos;

  return {
    x: (along + geometry.sourceLength / 2) * geometry.scale,
    y: (across + geometry.sourceThickness / 2) * geometry.scale,
  };
}

/** ROI 上の列範囲。`Band` の start/end をそのまま渡せる。 */
export interface ColumnRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 検出した本体が ROI のどの列を占めるかを返す。
 *
 * ROI はパディングぶんだけ本体より広いので、その内訳はここで確定できる。
 * 本体の位置をプロファイルから推定し直すと、背景を本体に含めたり
 * 逆に端のバンドを切り落としたりする。検出側が既に答えを持っているのだから、
 * それを事前情報として渡すほうが確実。
 *
 * @param margin 本体長に対する外側への余白。バンドは丸まった肩に載って
 *   いることがあるので、少しだけ外を含める。
 */
export function bodyColumns(
  box: OrientedBox,
  options: RectifyOptions,
  margin = 0,
): ColumnRange {
  const geometry = roiGeometry(box, options);
  const bodyWidth = box.length * geometry.scale;
  const center = geometry.width / 2;
  const half = bodyWidth * (0.5 + margin);

  return {
    start: Math.max(0, center - half),
    end: Math.min(geometry.width, center + half),
  };
}

/**
 * バンド 1 本が元画像で占める四隅を返す。
 * 順序は左上 → 右上 → 右下 → 左下（多角形として閉じられる）。
 */
export function bandCorners(
  box: OrientedBox,
  options: RectifyOptions,
  band: ColumnRange,
): Point[] {
  const { height } = roiGeometry(box, options);
  return [
    roiToImage(box, options, band.start, 0),
    roiToImage(box, options, band.end, 0),
    roiToImage(box, options, band.end, height),
    roiToImage(box, options, band.start, height),
  ];
}

/**
 * バンドの色名ラベルを置く位置（元画像座標）。
 *
 * バンド中心から短軸の外側（法線方向）へ `offset` px ずらす。
 * 抵抗器の上に文字が重なって色帯が見えなくなるのを避けるため。
 *
 * @param offset 箱の縁からの距離 [px]（元画像スケール）
 */
export function labelAnchor(
  box: OrientedBox,
  options: RectifyOptions,
  band: ColumnRange,
  offset: number,
): Point {
  const geometry = roiGeometry(box, options);
  const centerColumn = (band.start + band.end) / 2;

  // 箱の上辺（ROI の y=0 側）に乗せてから、法線方向へさらに離す
  const onEdge = roiToImage(box, options, centerColumn, 0);
  return {
    x: onEdge.x + offset * geometry.sin,
    y: onEdge.y - offset * geometry.cos,
  };
}
