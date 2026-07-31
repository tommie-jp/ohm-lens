import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage, verdictOf, type Verdict } from '../src/annotate/read.js';
import { runScanSpreads } from '../src/core/bands/scanSpread.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * バンド色の行方向のばらつきを一覧するツール（docs/13 Phase 5 の下調べ）。
 *
 * **しきい値を決める前に分布を見る。** 正解と誤答でばらつきが重なっていれば、
 * この指標を確信度に足しても順序は直らない（docs/12 §5 と同じ作法）。
 *
 *   npx tsx scripts/dbgScanSpread.ts
 *   npx tsx scripts/dbgScanSpread.ts ../sample 23
 */

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif']);

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

/** 数値の要約（件数・中央値・最小・最大）。 */
function summarize(values: readonly number[]): string {
  if (values.length === 0) return 'なし';
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] as number;
  return (
    `${String(values.length).padStart(2)} 件  ` +
    `中央 ${median.toFixed(1).padStart(5)}  ` +
    `最小 ${(sorted[0] as number).toFixed(1).padStart(5)}  ` +
    `最大 ${(sorted[sorted.length - 1] as number).toFixed(1).padStart(5)}`
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

console.log('   ファイル                                    確信度  ばらつき(最大/中央)  ラン数');

interface Row {
  readonly verdict: Verdict;
  readonly worst: number;
  readonly median: number;
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

  const spreads = runScanSpreads(read.analysis?.runs ?? [], read.analysis?.scans ?? [])
    .filter((value): value is number => value !== null);

  if (spreads.length > 0) {
    const sorted = [...spreads].sort((a, b) => a - b);
    rows.push({
      verdict,
      worst: sorted[sorted.length - 1] as number,
      median: sorted[sorted.length >> 1] as number,
    });
  }

  const cell = (value: number | undefined): string =>
    value === undefined ? '    -' : value.toFixed(1).padStart(5);
  const sorted = [...spreads].sort((a, b) => a - b);

  console.log(
    ` ${MARK[verdict]} ${file.padEnd(42)} ${read.confidence.toFixed(2).padStart(5)}   ` +
      `${cell(sorted[sorted.length - 1])} / ${cell(sorted[sorted.length >> 1])}` +
      `        ${String(read.analysis?.runs.length ?? 0).padStart(2)}`,
  );
}

console.log('');
console.log('判定ごとの分布（最大ばらつき）');
for (const verdict of ['correct', 'wrong', 'held'] as const) {
  const values = rows.filter((row) => row.verdict === verdict).map((row) => row.worst);
  console.log(`  ${MARK[verdict]} ${verdict.padEnd(8)} ${summarize(values)}`);
}

console.log('');
console.log('判定ごとの分布（中央ばらつき）');
for (const verdict of ['correct', 'wrong', 'held'] as const) {
  const values = rows.filter((row) => row.verdict === verdict).map((row) => row.median);
  console.log(`  ${MARK[verdict]} ${verdict.padEnd(8)} ${summarize(values)}`);
}
