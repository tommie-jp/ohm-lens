import type { LabColor } from '../types.js';
import type { RoiImage } from './bands/profile.js';
import { deltaE2000Prepared, prepareLab, srgb255ToLab, type PreparedLab } from './color/colorSpace.js';
import { medianInPlace } from './math.js';

/**
 * 画像から抵抗器の位置・向き・大きさを求める。
 *
 * Phase 0 は「水平配置の静止画」を前提にしていたが、実際の写真では
 * 抵抗器が斜めに写っている。回転補正の前段として、ここで主軸を求める。
 * Phase 3 で YOLO(OBB) に置き換わるまでの古典 CV 版。
 *
 * 手順:
 * 1. 画像の外周から背景色を推定する
 * 2. 背景から ΔE が離れた画素を前景とする
 * 3. 最大の連結成分を抵抗器とみなす
 * 4. 主成分分析（PCA）で長軸の向きを求める
 * 5. 長軸方向の太さ分布から、リード線を除いた本体の範囲を切り出す
 */

/** 検出結果。長軸に沿った回転バウンディングボックス。 */
export interface OrientedBox {
  readonly centerX: number;
  readonly centerY: number;
  /** 長軸の向き [度]。0 が水平右向き。 */
  readonly angleDeg: number;
  /** 長軸方向の長さ [px]（本体のみ、リード線を除く） */
  readonly length: number;
  /** 短軸方向の太さ [px] */
  readonly thickness: number;
}

const CHANNELS = 4;

/** 背景推定に使う外周の幅（画像の短辺に対する割合）。 */
const BORDER_FRACTION = 0.06;

/** これ以上 ΔE が離れていれば前景とみなす。 */
const FOREGROUND_DELTA_E = 10;

/** 前景がこの割合未満なら被写体なしとみなす。 */
const MIN_FOREGROUND_RATIO = 0.002;

/** 本体とみなす太さの下限（最大太さに対する割合）。リード線を落とすため。 */
const BODY_THICKNESS_RATIO = 0.45;

/**
 * 太さを測るときの分位点。
 *
 * 外れ値に強い 0.9 も試したが、sample/ の 39 枚では正解率が下がった
 * （23% → 15%）。太めに見積もった ROI のほうが、結果的に細かいノイズが
 * 平滑化されて良い。実写真を増やしたら再評価する。
 */
const THICKNESS_PERCENTILE = 1;

/** 処理を軽くするための最大解像度（長辺）。これを超える画像は間引く。 */
const MAX_ANALYSIS_SIZE = 400;

/** 画像の外周から背景色を推定する。 */
export function estimateBackground(image: RoiImage): LabColor {
  const { width, height, data } = image;
  const border = Math.max(1, Math.round(Math.min(width, height) * BORDER_FRACTION));

  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  for (let y = 0; y < height; y += 1) {
    const isBorderRow = y < border || y >= height - border;
    for (let x = 0; x < width; x += 1) {
      if (!isBorderRow && x >= border && x < width - border) continue;
      const offset = (y * width + x) * CHANNELS;
      reds.push(data[offset] as number);
      greens.push(data[offset + 1] as number);
      blues.push(data[offset + 2] as number);
    }
  }

  if (reds.length === 0) return srgb255ToLab(255, 255, 255);

  return srgb255ToLab(
    medianInPlace(Float64Array.from(reds)),
    medianInPlace(Float64Array.from(greens)),
    medianInPlace(Float64Array.from(blues)),
  );
}

/** 解析を軽くするための間引き幅。 */
function analysisStep(width: number, height: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / MAX_ANALYSIS_SIZE));
}

/** 背景から離れた画素のマスクを作る（間引き後の格子）。 */
function foregroundMask(
  image: RoiImage,
  background: PreparedLab,
  step: number,
): { mask: Uint8Array; cols: number; rows: number } {
  const { width, height, data } = image;
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const mask = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row += 1) {
    const y = row * step;
    for (let col = 0; col < cols; col += 1) {
      const x = col * step;
      const offset = (y * width + x) * CHANNELS;
      const lab = srgb255ToLab(
        data[offset] as number,
        data[offset + 1] as number,
        data[offset + 2] as number,
      );
      if (deltaE2000Prepared(prepareLab(lab), background) > FOREGROUND_DELTA_E) {
        mask[row * cols + col] = 1;
      }
    }
  }

  return { mask, cols, rows };
}

/** 4 近傍で連結成分を求め、最大のものに属する画素だけを残す。 */
function largestComponent(mask: Uint8Array, cols: number, rows: number): number[] {
  const labels = new Int32Array(mask.length).fill(-1);
  const stack: number[] = [];
  let best: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== -1) continue;

    const component: number[] = [];
    labels[start] = start;
    stack.push(start);

    while (stack.length > 0) {
      const index = stack.pop() as number;
      component.push(index);
      const x = index % cols;
      const y = (index - x) / cols;

      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < cols - 1 ? index + 1 : -1,
        y > 0 ? index - cols : -1,
        y < rows - 1 ? index + cols : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || mask[neighbour] === 0 || labels[neighbour] !== -1) continue;
        labels[neighbour] = start;
        stack.push(neighbour);
      }
    }

    if (component.length > best.length) best = component;
  }

  return best;
}

/** 点群の主軸（第1主成分）の向きを求める。 */
function principalAngle(points: readonly { x: number; y: number }[]): number {
  const count = points.length;
  let meanX = 0;
  let meanY = 0;
  for (const point of points) {
    meanX += point.x;
    meanY += point.y;
  }
  meanX /= count;
  meanY /= count;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // 共分散行列の固有ベクトル（最大固有値側）の向き
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

/**
 * 画像から抵抗器を検出する。見つからなければ null。
 *
 * 前提: 画像内で最も大きい非背景の塊が抵抗器であること。
 * 複数の抵抗器が写っている画像では最大のものだけを返す。
 */
export function locateResistor(image: RoiImage): OrientedBox | null {
  const { width, height } = image;
  if (width <= 0 || height <= 0) return null;

  const step = analysisStep(width, height);
  const background = prepareLab(estimateBackground(image));
  const { mask, cols, rows } = foregroundMask(image, background, step);

  const component = largestComponent(mask, cols, rows);
  if (component.length < mask.length * MIN_FOREGROUND_RATIO || component.length < 8) return null;

  const points = component.map((index) => ({
    x: (index % cols) * step,
    y: Math.floor(index / cols) * step,
  }));

  const angle = principalAngle(points);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let meanX = 0;
  let meanY = 0;
  for (const point of points) {
    meanX += point.x;
    meanY += point.y;
  }
  meanX /= points.length;
  meanY /= points.length;

  // 主軸に沿った座標へ写し、長軸方向の太さ分布を作る
  const projected = points.map((point) => {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    return { along: dx * cos + dy * sin, across: -dx * sin + dy * cos };
  });

  const body = bodyExtent(projected, step);
  if (body === null) return null;

  const centerAlong = (body.start + body.end) / 2;
  return {
    centerX: meanX + centerAlong * cos,
    centerY: meanY + centerAlong * sin,
    angleDeg: (angle * 180) / Math.PI,
    length: body.end - body.start,
    thickness: body.thickness,
  };
}

/**
 * 長軸方向の太さ分布から、リード線を除いた本体の範囲を求める。
 * 本体は最も太い区間の連続部分とみなす。
 */
function bodyExtent(
  projected: readonly { along: number; across: number }[],
  step: number,
): { start: number; end: number; thickness: number } | null {
  let minAlong = Number.POSITIVE_INFINITY;
  let maxAlong = Number.NEGATIVE_INFINITY;
  for (const point of projected) {
    minAlong = Math.min(minAlong, point.along);
    maxAlong = Math.max(maxAlong, point.along);
  }
  if (!Number.isFinite(minAlong) || maxAlong <= minAlong) return null;

  const binCount = Math.max(4, Math.ceil((maxAlong - minAlong) / step));
  const binWidth = (maxAlong - minAlong) / binCount;

  // 各ビンの「太さ」は across の絶対値の高位分位点 × 2。
  // 最大値だと、影やリード線の反射がひとつ紛れただけで太さが跳ね上がり、
  // ROI が縦に間延びして色帯の解像度が落ちる。
  const perBin: number[][] = Array.from({ length: binCount }, () => []);
  for (const point of projected) {
    const bin = Math.min(binCount - 1, Math.floor((point.along - minAlong) / binWidth));
    (perBin[bin] as number[]).push(Math.abs(point.across));
  }

  const spread = Float64Array.from(perBin, (values) => {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const index = Math.min(values.length - 1, Math.floor(values.length * THICKNESS_PERCENTILE));
    return (values[index] as number) * 2;
  });

  let maxThickness = 0;
  for (const value of spread) maxThickness = Math.max(maxThickness, value);
  if (maxThickness <= 0) return null;

  const threshold = maxThickness * BODY_THICKNESS_RATIO;

  // 閾値を超えるビンの最長連続区間を本体とする
  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;
  for (let bin = 0; bin <= binCount; bin += 1) {
    const isBody = bin < binCount && (spread[bin] as number) >= threshold;
    if (isBody && runStart < 0) runStart = bin;
    if (!isBody && runStart >= 0) {
      if (bin - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = bin;
      }
      runStart = -1;
    }
  }
  if (bestStart < 0) return null;

  let thickness = 0;
  for (let bin = bestStart; bin < bestEnd; bin += 1) {
    thickness = Math.max(thickness, spread[bin] as number);
  }

  return {
    start: minAlong + bestStart * binWidth,
    end: minAlong + bestEnd * binWidth,
    thickness,
  };
}
