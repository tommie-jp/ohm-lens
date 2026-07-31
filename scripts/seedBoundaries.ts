import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage } from '../src/annotate/read.js';
import { intervalsFromRuns, mergeSeeds, type BoundaryLabels } from '../src/core/bands/boundaries.js';
import { ROI_OPTIONS } from '../src/core/settings.js';
import { SAMPLE_EXTENSIONS, sampleDir } from '../tests/fixtures/loadSample.js';
import type { BandColor } from '../src/types.js';

/**
 * バンド境界の正解データ（`sample/boundaries.json`）の**種**を作る。
 *
 * 0 から手入力するのは現実的でないので、現行の検出結果を推定値として吐き、
 * 人はそれを直す。位置は長手方向の % で、焼き込み画像の X 軸と同じ目盛り。
 * グラフを見て読んだ数字をそのまま書き直せる。
 *
 *   npx tsx scripts/seedBoundaries.ts            # 差分を表示するだけ
 *   npx tsx scripts/seedBoundaries.ts --write    # boundaries.json に書く
 *   npx tsx scripts/seedBoundaries.ts 41 46      # ファイル名で絞り込む
 *
 * **`verified: true` のエントリは絶対に上書きしない。** 直した値を機械が
 * 壊さないため。逆に、種に無いエントリも消さない（検体を消しても正解は残す）。
 *
 * 直したら `"verified": true` に変えること。採点（`scoreBoundaries.ts`）は
 * verified のものだけを見る。
 */

const BOUNDARIES_PATH = join(sampleDir(), 'boundaries.json');

function loadExisting(): BoundaryLabels {
  if (!existsSync(BOUNDARIES_PATH)) return {};
  return JSON.parse(readFileSync(BOUNDARIES_PATH, 'utf-8')) as BoundaryLabels;
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const filters = args.filter((arg) => !arg.startsWith('--'));

const files = readdirSync(sampleDir())
  .filter((file) => (SAMPLE_EXTENSIONS as readonly string[]).includes(extname(file).toLowerCase()))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .sort();

const existing = loadExisting();
const seeds: BoundaryLabels = {};
let located = 0;

for (const file of files) {
  const image = await loadRoiImage(join(sampleDir(), file));
  const read = readResistorImage(image, {});
  if (!read.located || read.box === null || read.analysis === null) {
    console.log(`  -  ${file} 検出失敗（種を作れない）`);
    continue;
  }
  located += 1;

  const analysis = read.analysis;
  const colors = analysis.bands.map((band) => band.color as BandColor);
  seeds[file] = {
    verified: false,
    box: read.box,
    bands: intervalsFromRuns(
      analysis.runs.map((run) => ({ start: run.start, end: run.end })),
      analysis.profile.length,
      ROI_OPTIONS.padding ?? 0,
      colors,
    ),
  };
}

const merged = mergeSeeds(existing, seeds);
const verified = Object.values(merged).filter((label) => label.verified).length;
const skipped = Object.keys(seeds).filter((file) => existing[file]?.verified === true);

console.log(`\n画像 ${files.length} 枚 / 検出成功 ${located} 枚`);
console.log(`エントリ ${Object.keys(merged).length} 件（確認済み ${verified} 件）`);
if (skipped.length > 0) {
  console.log(`確認済みのため据え置いた ${skipped.length} 件:`);
  for (const file of skipped) console.log(`  = ${file}`);
}

if (!write) {
  console.log('\n--write を付けると boundaries.json に書きます。');
  process.exit(0);
}

writeFileSync(BOUNDARIES_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
console.log(`\n${BOUNDARIES_PATH} を更新しました。`);
