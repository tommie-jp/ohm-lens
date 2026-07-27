import type { LabColor } from '../types.js';
import type { RoiImage } from './bands/profile.js';
import { deltaE2000, srgb255ToLab } from './color/colorSpace.js';
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
 * 2. 背景から離れた画素を前景とする（影は背景に含める）
 * 3. 前景が広すぎるなら閾値を上げて取り直す（背景を掴んだ状態の回避）
 * 4. 連結成分のうち**最も抵抗器らしい**ものを選ぶ（大きさではなく形で選ぶ）
 * 5. 主成分分析（PCA）で長軸の向きを求める
 * 6. 長軸方向の太さ分布から、リード線を除いた本体の範囲を切り出す
 *
 * 背景を単一色と仮定しているのは変わらないが、机やカーペットのように
 * ムラのある背景では前景が膨らむ。3 と 4 がその保険になっている。
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

/** これ以上 ΔE が離れていれば前景とみなす（初期値）。 */
const FOREGROUND_DELTA_E = 10;

/** 前景がこの割合を超えたら「背景を掴んだ」とみなし、閾値を上げて取り直す。 */
const MAX_FOREGROUND_RATIO = 0.35;

/** 閾値を上げ直す最大回数。 */
const MAX_THRESHOLD_RETRIES = 4;

/** 1 回の再試行で閾値を何倍にするか。 */
const THRESHOLD_GROWTH = 1.6;

/** 前景がこの割合未満なら被写体なしとみなす。 */
const MIN_FOREGROUND_RATIO = 0.002;

/**
 * 照明のムラ（影・ハイライト）とみなす色度の許容差。
 * 同じ面が明るくなっても暗くなっても色相は変わらないので a*b* の距離が小さい。
 */
const LIGHTING_CHROMA_TOLERANCE = 9;

/**
 * 照明のムラとみなす明度差の上限。
 * これを超える差は照明ではなく別の物体（黒バンド、白飛びした金属など）と考える。
 */
const LIGHTING_MAX_LIGHTNESS_DIFF = 24;

/** 本体とみなす太さの下限（最大太さに対する割合）。リード線を落とすため。 */
const BODY_THICKNESS_RATIO = 0.45;

/** 本体の途中で許す途切れの長さ（本体の太さに対する割合）。 */
const BODY_GAP_RATIO = 0.9;

/** 途切れを跨ぐ条件: 中心線のずれ（太さに対する割合）。 */
const BODY_CENTER_TOLERANCE = 0.3;

/** 途切れを跨ぐ条件: 太さの比の下限（上限はこの逆数）。 */
const BODY_THICKNESS_TOLERANCE = 0.6;

/**
 * 太さを測るときの分位点。
 * 影やハイライトが 1 点混じっただけで太さが跳ねないよう、最大値は使わない。
 */
const THICKNESS_PERCENTILE = 0.99;

/** 処理を軽くするための最大解像度（長辺）。これを超える画像は間引く。 */
const MAX_ANALYSIS_SIZE = 400;

/** 形の評価にかける連結成分の数（大きい順）。 */
const MAX_COMPONENTS_SCORED = 10;

/** これ未満の格子数の成分は形を測るには小さすぎる。 */
const MIN_COMPONENT_CELLS = 8;

/** 抵抗器らしい細長さの範囲（長さ ÷ 太さ）。 */
const MIN_ELONGATION = 1.65;
const IDEAL_ELONGATION = 4;
const MAX_ELONGATION = 14;

/** 抵抗器らしい面積の範囲（前景格子の全体に対する割合）。 */
const MIN_AREA_RATIO = 0.004;
const MAX_AREA_RATIO = 0.55;

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

/**
 * その画素を背景とみなすか。
 *
 * 単純な ΔE 判定に加えて**照明のムラを背景に含める**。机の上で撮ると
 * 抵抗器の影が前景に入って本体と連結し、太さを 2 倍近くまで押し上げる。
 * 逆に光源側が明るい写真では、その明るい領域が巨大な前景の塊になり、
 * 主軸がそちらを向いてしまう（23-3.9kohm では検出枠が写真の左上に出た）。
 *
 * どちらも「色相はそのままで明度だけ動く」ので、色度の距離が小さく明度差が
 * 限定的なものを照明と判断する。黒バンドや白飛びした金属は明度差が大きいので
 * 前景のまま残る。
 */
export function isBackgroundLike(lab: LabColor, background: LabColor, deltaE: number): boolean {
  if (deltaE2000(lab, background) <= deltaE) return true;

  const chromaDistance = Math.hypot(lab.a - background.a, lab.b - background.b);
  return (
    chromaDistance < LIGHTING_CHROMA_TOLERANCE &&
    Math.abs(lab.l - background.l) < LIGHTING_MAX_LIGHTNESS_DIFF
  );
}

/** 解析を軽くするための間引き幅。 */
function analysisStep(width: number, height: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / MAX_ANALYSIS_SIZE));
}

interface Mask {
  readonly mask: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly ratio: number;
}

/** 背景から離れた画素のマスクを作る（間引き後の格子）。 */
function foregroundMask(
  image: RoiImage,
  background: LabColor,
  step: number,
  deltaE: number,
): Mask {
  const { width, height, data } = image;
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const mask = new Uint8Array(cols * rows);
  let count = 0;

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
      if (!isBackgroundLike(lab, background, deltaE)) {
        mask[row * cols + col] = 1;
        count += 1;
      }
    }
  }

  return { mask, cols, rows, ratio: count / Math.max(1, mask.length) };
}

/**
 * 前景が広すぎるうちは閾値を上げて取り直す。
 *
 * 抵抗器は画面の 5〜20% 程度しか占めない。前景が 35% を超えるのは
 * 机の質感やグラデーションを拾っている状態で、そのまま連結成分を
 * 取ると背景ごと掴んでしまう。
 */
function buildMask(image: RoiImage, background: LabColor, step: number): Mask {
  let deltaE = FOREGROUND_DELTA_E;
  let mask = foregroundMask(image, background, step, deltaE);

  for (let retry = 0; retry < MAX_THRESHOLD_RETRIES; retry += 1) {
    if (mask.ratio <= MAX_FOREGROUND_RATIO) break;
    deltaE *= THRESHOLD_GROWTH;
    const next = foregroundMask(image, background, step, deltaE);
    // 前景が消えてしまうなら、ひとつ前の状態を採る
    if (next.ratio < MIN_FOREGROUND_RATIO) break;
    mask = next;
  }
  return mask;
}

/**
 * 開処理（収縮 → 膨張）の半径。格子の短辺に対する割合。
 * リード線・カーペットの毛・画像の枠線といった細い構造を切り離すのが目的。
 * これらが残ると本体と 1 つの連結成分になり、主軸がまるで別の向きを向く。
 */
const OPENING_RADIUS_RATIO = 0.013;

/** 1 次元の窓走査（min か max）。収縮・膨張の共通実装。 */
function sweep(
  source: Uint8Array,
  cols: number,
  rows: number,
  radius: number,
  keep: 0 | 1,
): Uint8Array {
  const horizontal = new Uint8Array(source.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let value = 1 - keep;
      for (let d = -radius; d <= radius; d += 1) {
        const x = col + d;
        if (x < 0 || x >= cols) continue;
        if (source[row * cols + x] === keep) {
          value = keep;
          break;
        }
      }
      horizontal[row * cols + col] = value;
    }
  }

  const result = new Uint8Array(source.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let value = 1 - keep;
      for (let d = -radius; d <= radius; d += 1) {
        const y = row + d;
        if (y < 0 || y >= rows) continue;
        if (horizontal[y * cols + col] === keep) {
          value = keep;
          break;
        }
      }
      result[row * cols + col] = value;
    }
  }
  return result;
}

/** 開処理。細い構造を落としてから元の太さに戻す。 */
function open(mask: Uint8Array, cols: number, rows: number, radius: number): Uint8Array {
  if (radius < 1) return mask;
  // 収縮は「窓内に 0 があれば 0」、膨張は「窓内に 1 があれば 1」
  const eroded = sweep(mask, cols, rows, radius, 0);
  return sweep(eroded, cols, rows, radius, 1);
}

/** 4 近傍の連結成分をすべて求め、大きい順に返す。 */
function findComponents(mask: Uint8Array, cols: number, rows: number): number[][] {
  const labels = new Int32Array(mask.length).fill(-1);
  const stack: number[] = [];
  const components: number[][] = [];

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
    components.push(component);
  }

  return components.sort((a, b) => b.length - a.length).slice(0, MAX_COMPONENTS_SCORED);
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Shape {
  readonly angle: number;
  readonly meanX: number;
  readonly meanY: number;
  readonly projected: readonly { along: number; across: number }[];
}

/** 点群の主軸（第1主成分）の向きと、その軸に沿った座標を求める。 */
function analyseShape(points: readonly Point[]): Shape {
  let meanX = 0;
  let meanY = 0;
  for (const point of points) {
    meanX += point.x;
    meanY += point.y;
  }
  meanX /= points.length;
  meanY /= points.length;

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

  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    angle,
    meanX,
    meanY,
    projected: points.map((point) => {
      const dx = point.x - meanX;
      const dy = point.y - meanY;
      return { along: dx * cos + dy * sin, across: -dx * sin + dy * cos };
    }),
  };
}

/** 分位点（配列を破壊しない）。 */
function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return sorted[index] as number;
}

interface BodyMetrics {
  readonly start: number;
  readonly end: number;
  readonly thickness: number;
  /** 短軸方向の本体中心（成分の重心からのずれ） */
  readonly acrossCenter: number;
}

/** ビンひとつぶんの断面。 */
interface Slice {
  readonly thickness: number;
  readonly center: number;
}

/**
 * 断面の上端・下端を分位点で取る。
 *
 * 重心からの `|across|` ではなく**上下端の差**で測るのが要点。
 * リード線や背景のムラが片側にだけ繋がると重心が本体から外れ、
 * `|across| × 2` は太さを 1.5〜2 倍に見積もってしまう。
 */
function sliceOf(values: readonly number[]): Slice {
  const low = percentile(values, 1 - THICKNESS_PERCENTILE);
  const high = percentile(values, THICKNESS_PERCENTILE);
  return { thickness: high - low, center: (high + low) / 2 };
}

/**
 * 長軸方向の太さ分布から、リード線を除いた本体の範囲を求める。
 * 本体は最も太い区間の連続部分とみなす。
 */
function bodyExtent(
  projected: readonly { along: number; across: number }[],
  step: number,
): BodyMetrics | null {
  let minAlong = Number.POSITIVE_INFINITY;
  let maxAlong = Number.NEGATIVE_INFINITY;
  for (const point of projected) {
    minAlong = Math.min(minAlong, point.along);
    maxAlong = Math.max(maxAlong, point.along);
  }
  if (!Number.isFinite(minAlong) || maxAlong <= minAlong) return null;

  const binCount = Math.max(4, Math.ceil((maxAlong - minAlong) / step));
  const binWidth = (maxAlong - minAlong) / binCount;
  const bins: number[][] = Array.from({ length: binCount }, () => []);

  for (const point of projected) {
    const bin = Math.min(binCount - 1, Math.floor((point.along - minAlong) / binWidth));
    (bins[bin] as number[]).push(point.across);
  }

  const slices = bins.map(sliceOf);
  const maxThickness = Math.max(...slices.map((slice) => slice.thickness));
  if (maxThickness <= 0) return null;

  const threshold = maxThickness * BODY_THICKNESS_RATIO;

  // 白帯が白背景に溶けて穴が開くことがあるので、短い途切れは跨ぐ。
  // ただし跨ぐ相手は「同じ太さで同じ中心線に乗っている」ときだけ。
  // これが無いと、リード線の先の反射やムラまで一続きの本体にしてしまう。
  const maxGap = Math.max(2, Math.round((maxThickness * BODY_GAP_RATIO) / binWidth));

  const continues = (from: Slice, to: Slice): boolean =>
    Math.abs(to.center - from.center) < from.thickness * BODY_CENTER_TOLERANCE &&
    to.thickness > from.thickness * BODY_THICKNESS_TOLERANCE &&
    to.thickness < from.thickness / BODY_THICKNESS_TOLERANCE;

  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;
  let lastBody = -1;
  for (let bin = 0; bin <= binCount; bin += 1) {
    const slice = bin < binCount ? (slices[bin] as Slice) : null;
    const isBody = slice !== null && slice.thickness >= threshold;

    if (isBody) {
      const bridges =
        runStart >= 0 && bin - lastBody <= maxGap && continues(slices[lastBody] as Slice, slice);
      if (runStart < 0 || (bin > lastBody + 1 && !bridges)) {
        if (runStart >= 0 && lastBody + 1 - runStart > bestEnd - bestStart) {
          bestStart = runStart;
          bestEnd = lastBody + 1;
        }
        runStart = bin;
      }
      lastBody = bin;
      continue;
    }

    // 途切れが長くなりすぎた（または末尾）なら、ここで区間を閉じる
    if (runStart >= 0 && (slice === null || bin - lastBody > maxGap)) {
      if (lastBody + 1 - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = lastBody + 1;
      }
      runStart = -1;
    }
  }
  if (bestStart < 0) return null;

  // 本体区間は中央値で代表させる（端の 1 ビンの跳ねと、途切れの穴を拾わない）
  const body = slices.slice(bestStart, bestEnd).filter((slice) => slice.thickness >= threshold);
  return {
    start: minAlong + bestStart * binWidth,
    end: minAlong + bestEnd * binWidth,
    thickness: percentile(body.map((slice) => slice.thickness), 0.5),
    acrossCenter: percentile(body.map((slice) => slice.center), 0.5),
  };
}

/** 候補となった連結成分ひとつぶん。検出の調整を目で追うために公開する。 */
export interface Candidate {
  readonly box: OrientedBox;
  readonly score: number;
  /** 長さ ÷ 太さ */
  readonly elongation: number;
  /** 前景格子に対する画素数の割合 */
  readonly areaRatio: number;
  /** 回転矩形をどれだけ埋めているか */
  readonly fill: number;
}

/** 形の条件で落ちた成分と、その理由。 */
export interface Rejection {
  readonly reason: string;
  readonly cells: number;
}

function isCandidate(value: Candidate | Rejection): value is Candidate {
  return 'score' in value;
}

/**
 * 連結成分がどれだけ抵抗器らしいかを評価する。
 *
 * **大きさではなく形で選ぶ**のが要点。カーペットや机の質感を拾うと
 * 巨大だが細長くない塊ができるので、最大の成分をそのまま採ると外す。
 */
function scoreComponent(
  component: readonly number[],
  cols: number,
  step: number,
  gridArea: number,
): Candidate | Rejection {
  const points = component.map((index) => ({
    x: (index % cols) * step,
    y: Math.floor(index / cols) * step,
  }));

  const shape = analyseShape(points);
  const body = bodyExtent(shape.projected, step);
  if (body === null || body.thickness <= 0) {
    return { reason: '本体の範囲を取れない', cells: component.length };
  }

  const length = body.end - body.start;
  const elongation = length / body.thickness;
  const areaRatio = component.length / gridArea;
  if (elongation < MIN_ELONGATION || elongation > MAX_ELONGATION) {
    return {
      reason: `細長さ ${elongation.toFixed(2)} (L${length.toFixed(0)} T${body.thickness.toFixed(0)})`,
      cells: component.length,
    };
  }
  if (areaRatio < MIN_AREA_RATIO || areaRatio > MAX_AREA_RATIO) {
    return { reason: `面積比 ${(areaRatio * 100).toFixed(1)}%`, cells: component.length };
  }

  // 回転矩形をどれだけ埋めているか（まばらな塊を落とす）
  const boxArea = (length * body.thickness) / (step * step);
  const fill = Math.min(1, component.length / Math.max(1, boxArea));

  // 細長さは理想値からの隔たりで評価する（対数で対称に）
  const elongationScore =
    1 / (1 + Math.abs(Math.log(elongation / IDEAL_ELONGATION)));

  const centerAlong = (body.start + body.end) / 2;
  const cos = Math.cos(shape.angle);
  const sin = Math.sin(shape.angle);

  return {
    box: {
      centerX: shape.meanX + centerAlong * cos - body.acrossCenter * sin,
      centerY: shape.meanY + centerAlong * sin + body.acrossCenter * cos,
      angleDeg: (shape.angle * 180) / Math.PI,
      length,
      thickness: body.thickness,
    },
    elongation,
    areaRatio,
    fill,
    // 形の良さを主、面積を従にする（大きいだけの塊に負けないように）
    score: elongationScore * (0.35 + 0.65 * fill) * (1 + Math.log10(1 + areaRatio * 100) * 0.35),
  };
}

/** 検出の途中経過。しきい値の効き方を目で確かめるために公開する。 */
export interface LocateDiagnostics {
  readonly background: LabColor;
  /** 採用したマスクの前景比率 */
  readonly foregroundRatio: number;
  /** 形の条件を通った候補（スコア降順） */
  readonly candidates: readonly Candidate[];
  /** 形の条件で落ちた成分と、その理由（大きい順） */
  readonly rejected: readonly Rejection[];
  /** 開処理まで済ませた前景マスク（デバッグ表示用） */
  readonly mask: { readonly cells: Uint8Array; readonly cols: number; readonly rows: number };
}

/** 検出の途中経過ごと返す。`locateResistor` はこの薄いラッパ。 */
export function locateResistorDetailed(image: RoiImage): LocateDiagnostics {
  const { width, height } = image;
  const background = estimateBackground(image);
  if (width <= 0 || height <= 0) {
    return {
      background,
      foregroundRatio: 0,
      candidates: [],
      rejected: [],
      mask: { cells: new Uint8Array(0), cols: 0, rows: 0 },
    };
  }

  const step = analysisStep(width, height);
  const { mask, cols, rows, ratio } = buildMask(image, background, step);
  if (ratio < MIN_FOREGROUND_RATIO) {
    return {
      background,
      foregroundRatio: ratio,
      candidates: [],
      rejected: [],
      mask: { cells: mask, cols, rows },
    };
  }

  const radius = Math.round(Math.min(cols, rows) * OPENING_RADIUS_RATIO);
  const opened = open(mask, cols, rows, radius);

  const scored = findComponents(opened, cols, rows)
    .filter((component) => component.length >= MIN_COMPONENT_CELLS)
    .map((component) => scoreComponent(component, cols, step, mask.length));

  return {
    background,
    foregroundRatio: ratio,
    candidates: scored.filter(isCandidate).sort((a, b) => b.score - a.score),
    rejected: scored.filter((entry): entry is Rejection => !isCandidate(entry)),
    mask: { cells: opened, cols, rows },
  };
}

/**
 * 画像から抵抗器を検出する。見つからなければ null。
 *
 * 前提: 画面内で最も「細長くまとまった非背景の塊」が抵抗器であること。
 */
export function locateResistor(image: RoiImage): OrientedBox | null {
  const { candidates } = locateResistorDetailed(image);
  return candidates.length === 0 ? null : (candidates[0] as Candidate).box;
}
