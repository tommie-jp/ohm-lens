import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../src/core/settings.js';
import { locateResistor } from '../src/core/locate.js';
import { refineBoxExtent } from '../src/core/refine.js';
import { rectify } from '../src/core/rectify.js';
import { analyzeRoi } from '../src/core/pipeline.js';
import { splitRuns, identifyBody } from '../src/core/bands/runs.js';
import { deltaE76 } from '../src/core/color/colorSpace.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * 同色隣接バンドが「1 本のランに融合している」のか、
 * 「2 本に分かれているが分類を誤っている」のかを切り分けるツール。
 *
 * 本番と同じ経路（本体範囲で切ってから splitRuns → identifyBody）を再現し、
 *   - 融合の疑い: 本体ランを挟まずに隣り合うバンド候補の数
 *   - 失われたギャップ: flush() が捨てた列のうち本体色に近いもの
 * を数える。
 *
 *   npx tsx scripts/dbgGap.ts ../sample/*.jpg
 */

const CLUSTER_DELTA_E = 18;
/** 捨てられた列を「本体色」とみなす ΔE。 */
const BODY_MATCH_DELTA_E = 18;
/** これ以下しか離れていなければ「隣接している」とみなす列数。 */
const ADJACENT_GAP = 2;
/** HiRes の相対幅フィルタ。バンド幅の中央値に対する下限。 */
const RELATIVE_WIDTH_FLOOR = 0.2;

function loadPalette(dir: string): Palette {
  const path = join(dir, 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('使い方: npx tsx scripts/dbgGap.ts <画像> [画像...]');
  process.exit(1);
}

const palette = loadPalette('../sample');
const labels = JSON.parse(readFileSync('../sample/labels.json', 'utf-8')) as Record<
  string,
  string[] | { bands?: string[] }
>;

let suspectMerge = 0;
let lostColumns = 0;
let analysed = 0;
let relativeFilterDrops = 0;

for (const path of paths) {
  const image = await loadRoiImage(path);
  const located = locateResistor(image);
  if (located === null) continue;

  const box = refineBoxExtent(located, image, refineOptions(palette));
  const roi = rectify(image, box, ROI_OPTIONS);
  const result = analyzeRoi(roi, analyzeOptions(box, palette));

  const extent = result.extent;
  const profile = extent === null ? result.profile : result.profile.slice(extent.start, extent.end);

  const runs = splitRuns(profile, {});
  // 破棄なしの分割。差分が flush() で捨てられた列。
  const rawRuns = splitRuns(profile, { minRunLength: 1 });
  const body = identifyBody(runs, CLUSTER_DELTA_E);
  if (body === null) continue;
  analysed += 1;

  const bodyIndices = new Set(body.runIndices);
  const kept = new Set<number>();
  for (const run of runs) for (let x = run.start; x < run.end; x += 1) kept.add(x);

  const lost = rawRuns.filter((run) => {
    for (let x = run.start; x < run.end; x += 1) if (kept.has(x)) return false;
    return deltaE76(run.lab, body.lab) < BODY_MATCH_DELTA_E;
  });
  const lostWidth = lost.reduce((sum, run) => sum + (run.end - run.start), 0);
  lostColumns += lostWidth;

  // 融合の疑い: 間に本体ランを挟まずに隣り合うバンド候補
  const candidates = runs
    .map((run, index) => ({ run, index }))
    .filter(({ index }) => !bodyIndices.has(index));
  let adjacent = 0;
  for (let i = 1; i < candidates.length; i += 1) {
    const previous = candidates[i - 1] as { run: { end: number }; index: number };
    const current = candidates[i] as { run: { start: number }; index: number };
    const hasBodyBetween = runs
      .slice(previous.index + 1, current.index)
      .some((_, k) => bodyIndices.has(previous.index + 1 + k));
    if (!hasBodyBetween && current.run.start - previous.run.end <= ADJACENT_GAP) adjacent += 1;
  }
  if (adjacent > 0) suspectMerge += 1;

  // HiRes の相対幅フィルタ（中央値の 20% 未満を捨てる）を当てたらどうなるか
  const widths = result.runs.map((run) => run.end - run.start).sort((a, b) => a - b);
  const medianWidth = widths.length === 0 ? 0 : (widths[widths.length >> 1] as number);
  const dropped = result.runs.filter(
    (run) => run.end - run.start < medianWidth * RELATIVE_WIDTH_FLOOR,
  ).length;
  relativeFilterDrops += dropped;

  const raw = labels[basename(path)];
  const expected = Array.isArray(raw) ? raw : (raw?.bands ?? []);
  console.log(
    `${basename(path).padEnd(44)} 期待${expected.length}本` +
      ` 全ラン${String(runs.length).padStart(2)}（本体${String(bodyIndices.size).padStart(2)}）` +
      ` 候補${String(result.runs.length).padStart(2)}` +
      ` 捨てた本体色列${String(lostWidth).padStart(3)}` +
      ` 本体を挟まない隣接${adjacent}` +
      ` 幅中央値${String(medianWidth).padStart(2)} 相対幅で落ちる${dropped}`,
  );
}

console.log(
  `\n解析 ${analysed} 枚` +
    ` / 本体を挟まず隣接するバンド候補がある画像 ${suspectMerge}` +
    ` / 本体色なのに捨てられた列 合計 ${lostColumns}` +
    ` / 相対幅フィルタで落ちるラン 合計 ${relativeFilterDrops}`,
);
