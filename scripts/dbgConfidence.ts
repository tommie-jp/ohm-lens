import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage, verdictOf, type Verdict } from '../src/annotate/read.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import { formatOhms, MIN_REPORTABLE_CONFIDENCE } from '../src/core/format.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * 確信度の内訳を一覧するツール。
 *
 * 「確信度が低いのはなぜか」を切り分けるためのもの。式を変える前に
 * 分布を見る。低い理由が absolute（色が基準色から遠い）なのか
 * margin（次点と僅差）なのかで、直し方がまったく違う。
 *
 *   npx tsx scripts/dbgConfidence.ts
 *   npx tsx scripts/dbgConfidence.ts ../sample 23
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

const dir = process.argv[2] ?? '../sample';
const filter = process.argv[3] ?? null;
const palette = loadPalette(dir);
const expected = loadExpected(dir);

const files = readdirSync(dir)
  .filter((name) => EXTENSIONS.has(extname(name).toLowerCase()))
  .filter((name) => filter === null || name.includes(filter))
  .sort();

const MARK: Record<Verdict, string> = { correct: '○', wrong: '×', held: '△' };

console.log(`確信度のしきい値: ${MIN_REPORTABLE_CONFIDENCE}`);
console.log('');
console.log('   ファイル                                    確信度  absolute  margin  plaus  meanΔE  次点差  次点の値/同値?');

interface Row {
  readonly verdict: Verdict;
  readonly confidence: number;
  readonly file: string;
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
  rows.push({ verdict, confidence: read.confidence, file });

  const b = read.joint?.breakdown;
  const cell = (value: number | null | undefined, digits = 2): string =>
    value === null || value === undefined ? '    -' : value.toFixed(digits).padStart(5);

  console.log(
    ` ${MARK[verdict]} ${file.padEnd(42)} ${cell(read.confidence)}   ` +
      `${cell(b?.absolute)}   ${cell(b?.margin)}  ${cell(b?.plausibility)}  ` +
      `${cell(b?.meanDeltaE, 1)}   ${cell(b?.runnerUpGap, 1)}  ` +
      `${b === undefined || b.runnerUpOhms === null ? '-' : `${formatOhms(b.runnerUpOhms)}${b.runnerUpSameValue ? ' (同値)' : ' (別値)'}`}`,
  );
}

// しきい値を跨げば救える保留がどれだけあるか
const held = rows.filter((r) => r.verdict === 'held').sort((a, b) => b.confidence - a.confidence);
console.log('');
console.log('保留を確信度の高い順に（しきい値を下げたときに先に拾われる順）');
for (const row of held) {
  console.log(`  ${row.confidence.toFixed(2)}  ${row.file}`);
}
