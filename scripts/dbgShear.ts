import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage, verdictOf, type Verdict } from '../src/annotate/read.js';
import { SCAN_COUNT } from '../src/core/bands/profile.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import { bodyRows } from '../src/core/roiMapping.js';
import { ROI_OPTIONS } from '../src/core/settings.js';
import type { BandColor, LabColor, ProfileSample } from '../src/types.js';

/**
 * OBB の残留回転（シア）を測るツール（docs/14 §5.2）。
 *
 * バンドは本体の全高にわたる縦縞なので、水平化が正しければ**どの走査線でも
 * バンドの列位置は同じ**。ずれていれば OBB の角度が外れている。走査線ごとの
 * L\* プロファイルを中央の走査線に合わせ込み、ずれ量の傾きから角度を出す。
 *
 * **整数ラグでは測れない。** 本体の太さは ROI 上で 25.6px しかないので、
 * 残留 1° は全高で 0.45px、2° で 0.89px のシアにしかならない。だから
 * 線形補間で分数ラグを探す。
 *
 * これは**計測専用**。角度と誤答に相関があることを確認するまで、
 * 補正（`refineBoxAngle`）は作らない。
 *
 *   npx tsx scripts/dbgShear.ts
 *   npx tsx scripts/dbgShear.ts ../sample 49
 */

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif']);

/** 探すシアの範囲 [px]（片側）と刻み。 */
const MAX_LAG = 4;
const LAG_STEP = 0.05;

function loadPalette(dir: string): Palette {
  const path = join(dir, 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}

function loadExpected(dir: string): Map<string, number> {
  const path = join(dir, 'MANIFEST.json');
  const map = new Map<string, number>();
  if (!existsSync(path)) return map;
  const items = JSON.parse(readFileSync(path, 'utf-8')) as {
    file: string;
    expected: { ohms: number } | null;
  }[];
  for (const item of items) if (item.expected !== null) map.set(item.file, item.expected.ohms);
  return map;
}

/** L\* を線形補間で取り出す。範囲外は端でクランプ。 */
function lightnessAt(scan: readonly ProfileSample[], position: number): number {
  const clamped = Math.min(scan.length - 1, Math.max(0, position));
  const low = Math.floor(clamped);
  const high = Math.min(scan.length - 1, low + 1);
  const fraction = clamped - low;
  const a = (scan[low] as ProfileSample).lab.l;
  const b = (scan[high] as ProfileSample).lab.l;
  return a * (1 - fraction) + b * fraction;
}

/**
 * scan を lag だけずらしたときの、reference との二乗誤差（1 列あたり）。
 * 端は評価しない（ずらすと範囲外になるため）。
 */
function residual(
  scan: readonly ProfileSample[],
  reference: readonly ProfileSample[],
  from: number,
  to: number,
  lag: number,
): number {
  let sum = 0;
  let count = 0;
  for (let x = from; x < to; x += 1) {
    const difference = lightnessAt(scan, x + lag) - (reference[x] as ProfileSample).lab.l;
    sum += difference * difference;
    count += 1;
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count;
}

/**
 * 二乗誤差が最小になる分数ラグと、そのときの改善率。
 *
 * 改善率は「ラグ 0 の二乗誤差 ÷ 最良の二乗誤差」。**1 に近ければ推定は無意味**
 * （プロファイルに特徴が無く、どこにずらしても誤差が変わらない）。
 * ラン 0 本の検体ではこれが起きるので、飽和したラグを鵜呑みにしないための検算。
 */
function bestLag(
  scan: readonly ProfileSample[],
  reference: readonly ProfileSample[],
  from: number,
  to: number,
): { lag: number; gain: number; saturated: boolean } {
  let best = 0;
  let bestResidual = Number.POSITIVE_INFINITY;
  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag += LAG_STEP) {
    const value = residual(scan, reference, from, to, lag);
    if (value < bestResidual) {
      bestResidual = value;
      best = lag;
    }
  }
  const atZero = residual(scan, reference, from, to, 0);
  return {
    lag: best,
    gain: bestResidual === 0 ? Number.POSITIVE_INFINITY : atZero / bestResidual,
    saturated: Math.abs(best) >= MAX_LAG - LAG_STEP,
  };
}

/** 最小二乗で傾きを出す（x は走査線の添字）。 */
function slope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

function summarize(values: readonly number[]): string {
  if (values.length === 0) return 'なし';
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] as number;
  return (
    `${String(values.length).padStart(2)} 件  ` +
    `中央 ${median.toFixed(2).padStart(5)}  ` +
    `最小 ${(sorted[0] as number).toFixed(2).padStart(5)}  ` +
    `最大 ${(sorted[sorted.length - 1] as number).toFixed(2).padStart(5)}`
  );
}

const dir = process.argv[2] ?? '../sample';
const filter = process.argv[3] ?? null;
const palette = loadPalette(dir);
const expected = loadExpected(dir);

const files = readdirSync(dir)
  .filter((name) => EXTENSIONS.has(extname(name).toLowerCase()))
  .filter((name) => filter === null || name.includes(filter))
  .sort();

const MARK: Record<Verdict, string> = { correct: '○', wrong: '×', held: '△' };

console.log('本体の太さは ROI 上で約 25.6px。残留 1° は全高 0.45px、2° は 0.89px のシア');
console.log('');
console.log(
  '   ファイル                                     検出角  シア[px]  残留角[°]  改善率  ラグの並び',
);
console.log('（改善率が 1 に近い推定は無意味。* はラグが探索範囲に飽和）');

interface Row {
  readonly verdict: Verdict;
  readonly shear: number;
  readonly angle: number;
}
const rows: Row[] = [];

for (const file of files) {
  const ohms = expected.get(file);
  const image = await loadRoiImage(join(dir, file));
  const read = readResistorImage(image, {
    palette,
    ...(ohms === undefined ? {} : { expectedOhms: ohms }),
  });
  const verdict = verdictOf(read);

  const scans = read.analysis?.scans ?? [];
  const extent = read.analysis?.extent ?? null;
  if (read.box === null || scans.length < 3 || extent === null) {
    console.log(` ${MARK[verdict]} ${file.padEnd(43)} 測定不可`);
    continue;
  }

  // 端は評価しない（ずらすと範囲外になる）
  const from = Math.max(MAX_LAG + 1, Math.round(extent.start));
  const to = Math.min((scans[0] as ProfileSample[]).length - MAX_LAG - 1, Math.round(extent.end));
  if (to - from < 8) {
    console.log(` ${MARK[verdict]} ${file.padEnd(43)} 測定不可（本体が狭すぎる）`);
    continue;
  }

  const middle = scans[scans.length >> 1] as ProfileSample[];
  const fits = scans.map((scan) => bestLag(scan, middle, from, to));
  const lags = fits.map((fit) => fit.lag);
  // 中央の走査線どうしは自明に一致するので、改善率の評価から外す
  const gains = fits.filter((_, index) => index !== scans.length >> 1).map((fit) => fit.gain);
  const medianGain = [...gains].sort((a, b) => a - b)[gains.length >> 1] ?? 1;
  const saturated = fits.some((fit) => fit.saturated);

  // 走査線 1 本ぶんの行間隔 [px]
  const span = bodyRows(read.box, ROI_OPTIONS);
  const step = (span.end - span.start) / (SCAN_COUNT + 1);
  const perScan = slope(lags);
  const shear = perScan * (SCAN_COUNT - 1);
  const angle = (Math.atan(step === 0 ? 0 : perScan / step) * 180) / Math.PI;

  rows.push({ verdict, shear: Math.abs(shear), angle: Math.abs(angle) });

  console.log(
    ` ${MARK[verdict]} ${file.padEnd(43)} ` +
      `${read.box.angleDeg.toFixed(0).padStart(4)}°  ` +
      `${shear.toFixed(2).padStart(7)}  ` +
      `${angle.toFixed(2).padStart(8)}  ` +
      `${medianGain.toFixed(2).padStart(5)}${saturated ? '*' : ' '} ` +
      `${lags.map((lag) => lag.toFixed(1).padStart(5)).join('')}`,
  );
}

console.log('');
console.log('判定ごとの分布（シアの絶対値 [px]）');
for (const verdict of ['correct', 'wrong', 'held'] as const) {
  console.log(
    `  ${MARK[verdict]} ${verdict.padEnd(8)} ` +
      summarize(rows.filter((row) => row.verdict === verdict).map((row) => row.shear)),
  );
}

console.log('');
console.log('判定ごとの分布（残留角の絶対値 [°]）');
for (const verdict of ['correct', 'wrong', 'held'] as const) {
  console.log(
    `  ${MARK[verdict]} ${verdict.padEnd(8)} ` +
      summarize(rows.filter((row) => row.verdict === verdict).map((row) => row.angle)),
  );
}
