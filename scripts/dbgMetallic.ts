import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage } from '../src/annotate/read.js';
import { alignRunsToBands } from '../src/core/bands/align.js';
import { extractProfiles } from '../src/core/bands/profile.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import { bodyRows } from '../src/core/roiMapping.js';
import { ROI_OPTIONS } from '../src/core/settings.js';
import type { BandColor, LabColor, ProfileSample } from '../src/types.js';

/**
 * 「銀は高さ方向にギラギラする」を確かめるツール。
 *
 * 灰（つや消し顔料）は円筒の陰影にそのまま従うが、銀（金属光沢）は特定の高さで
 * 鏡面ハイライトが立つ。**列ごとに、高さ方向の L\\* のばらつき**を見れば、
 * 平均色では本体に埋もれている銀バンドが浮かび上がるはず — という仮説を、
 * 読めていない検体で直接見る。
 *
 * 大事なのは**本体との比**。本体自身も円筒なので高さ方向に暗くなる。
 * 絶対のばらつきでは灰も銀も動いてしまう。
 *
 *   npx tsx scripts/dbgMetallic.ts
 *   npx tsx scripts/dbgMetallic.ts 42
 */

/** 高さ方向の刻み。本体 25.6px を細かく見るため既定より増やす。 */
const SCAN_COUNT = 15;

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** 見たい検体（読めていない 5 枚 ＋ 灰と銀のラベルがある 5 枚）。 */
const TARGETS = [
  '38-10Mohm',
  '42-1.5kohm',
  '43-4.7kohm',
  '51-39kohm',
  '52-39kohm',
  '01-1ohm',
  '05-7.5ohm',
  '09-82ohm',
  '17-680ohm',
  '24-6.8kohm',
];

function loadPalette(dir: string): Palette {
  const path = join(dir, 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}

function loadLabels(dir: string): Record<string, BandColor[]> {
  const path = join(dir, 'labels.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, BandColor[]>;
}

function listFiles(dir: string): string[] {
  const path = join(dir, 'MANIFEST.json');
  const items = JSON.parse(readFileSync(path, 'utf-8')) as { file: string }[];
  return items.map((item) => item.file);
}

/** 値の列をスパークラインにする（各行で独立にスケールする）。 */
function spark(values: readonly number[]): string {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return '';
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const range = high - low;
  return values
    .map((value) => {
      if (!Number.isFinite(value)) return ' ';
      const level = range === 0 ? 0 : Math.round(((value - low) / range) * (SPARK.length - 1));
      return SPARK[level] as string;
    })
    .join('');
}

/** ラン → 正解色の対応（両方向を試して安いほうを採る。較正と同じ手口）。 */
function bestAlignment(
  runs: readonly { lab: LabColor; start: number; end: number }[],
  sequence: readonly BandColor[],
  palette: Palette,
): Map<number, BandColor> | null {
  let best: { cost: number; map: Map<number, BandColor> } | null = null;
  for (const oriented of [sequence, [...sequence].reverse()]) {
    const result = alignRunsToBands(
      runs.map((run) => ({ lab: run.lab, width: run.end - run.start })),
      oriented,
      { maxSkips: 4, palette },
    );
    if (result === null) continue;
    if (best === null || result.cost < best.cost) {
      best = {
        cost: result.cost,
        map: new Map(result.assignments.map((a) => [a.runIndex, a.color])),
      };
    }
  }
  return best?.map ?? null;
}

/** 標準偏差。 */
function deviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

const dir = '../sample';
const filter = process.argv[2] ?? null;
const palette = loadPalette(dir);
const labels = loadLabels(dir);

const files = listFiles(dir).filter((file) =>
  filter === null ? TARGETS.some((target) => file.startsWith(target)) : file.includes(filter),
);

console.log('列ごとの「高さ方向の L* のばらつき」を見る。銀なら本体より大きいはず');
console.log('  上段 = 平均 L*（従来のプロファイルが見ているもの）');
console.log('  下段 = 高さ方向の標準偏差（ギラギラの指標）');
console.log('');

for (const file of files.sort()) {
  const image = await loadRoiImage(join(dir, file));
  const read = readResistorImage(image, { palette });
  if (read.roi === null || read.box === null) {
    console.log(`${file}: 検出失敗`);
    continue;
  }

  const scans = extractProfiles(read.roi, {
    scanCount: SCAN_COUNT,
    bodyRows: bodyRows(read.box, ROI_OPTIONS),
  });
  if (scans.length < 3) {
    console.log(`${file}: 走査線が取れない`);
    continue;
  }

  const width = Math.min(...scans.map((scan) => scan.length));
  const extent = read.analysis?.extent ?? { start: 0, end: width };
  const from = Math.max(0, Math.round(extent.start));
  const to = Math.min(width, Math.round(extent.end));

  const means: number[] = [];
  const deviations: number[] = [];
  for (let x = from; x < to; x += 1) {
    const column = scans.map((scan) => (scan[x] as ProfileSample).lab.l);
    means.push(column.reduce((sum, value) => sum + value, 0) / column.length);
    deviations.push(deviation(column));
  }

  // 本体の代表的なばらつき（列の中央値）と、突出している列
  const typical = median(deviations);
  const peak = Math.max(...deviations);
  const label = labels[file];

  console.log(`${file}${label === undefined ? '' : `  [${label.join('-')}]`}`);
  console.log(`  L*   ${spark(means)}`);
  console.log(`  σ    ${spark(deviations)}`);
  console.log(
    `       本体の代表 σ ${typical.toFixed(1)}  最大 σ ${peak.toFixed(1)}  ` +
      `比 ${(typical === 0 ? Number.POSITIVE_INFINITY : peak / typical).toFixed(2)}  ` +
      `ラン ${read.analysis?.runs.length ?? 0} 本`,
  );

  // バンド単位で「自分の σ ÷ すぐ隣の本体の σ」を見る。
  // 全列の中央値と比べると、ROI 全体の照明勾配（51 で顕著）が混ざる
  const runs = read.analysis?.runs ?? [];
  if (label !== undefined && runs.length > 0) {
    const aligned = bestAlignment(runs, label, palette);
    const sigmaAt = (x: number): number => deviations[x - from] ?? Number.NaN;
    const localBody = (run: { start: number; end: number }): number => {
      const width = run.end - run.start;
      const left: number[] = [];
      const right: number[] = [];
      for (let i = 1; i <= width; i += 1) {
        const l = sigmaAt(run.start - i);
        const r = sigmaAt(run.end + i - 1);
        if (Number.isFinite(l)) left.push(l);
        if (Number.isFinite(r)) right.push(r);
      }
      const sides = [...left, ...right];
      return sides.length === 0 ? Number.NaN : median(sides);
    };

    for (const [index, run] of runs.entries()) {
      const color = aligned?.get(index);
      const inner: number[] = [];
      for (let x = run.start; x < run.end; x += 1) {
        const value = sigmaAt(x);
        if (Number.isFinite(value)) inner.push(value);
      }
      const own = median(inner);
      const around = localBody(run);
      console.log(
        `       ラン${index}  ${(color ?? '?').padEnd(7)} ` +
          `幅 ${String(run.end - run.start).padStart(2)}  ` +
          `σ ${own.toFixed(1).padStart(5)}  隣の本体 σ ${around.toFixed(1).padStart(5)}  ` +
          `局所比 ${(own / around).toFixed(2)}`,
      );
    }
  }
  console.log('');
}
