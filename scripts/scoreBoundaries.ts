import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage } from '../src/annotate/read.js';
import {
  boxMatches,
  intervalsFromRuns,
  scoreBands,
  scoreBoundaries,
  type BandInterval,
  type BoundaryLabels,
} from '../src/core/bands/boundaries.js';
import { bandRunStages } from '../src/core/bands/segment.js';
import type { ColorRun } from '../src/core/bands/runs.js';
import { ROI_OPTIONS, SEGMENT_THRESHOLDS } from '../src/core/settings.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import { sampleDir } from '../tests/fixtures/loadSample.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * 境界検出の成績を、人手で確定した正解（`boundaries.json`）に対して測る。
 *
 * **最終的な抵抗値の正解数ではなく、境界位置の一致で測る。** 正解数で測ると
 * パレットやデコード側の要因に埋もれて、境界検出を直した効果が判別できない
 * （`docs/13-バンド境界の検出指標.md` §8）。
 *
 * 測るものは 3 つ。
 *
 * 1. **境界点の一致**（従来）— 位置がどれだけ正確か
 * 2. **バンド単位の一致**（IoU）— 本数が合っているか。境界点の指標は、本体を
 *    丸ごと覆う 1 本の巨大なランでも端がたまたま近ければ一致に数えるため、
 *    「ランとして切れていない」失敗を隠す
 * 3. **段階別の生存**— 正解のバンドが分割・本体除去・まとめ・端落とし・拾い直しの
 *    どこで消えたか。直す場所を選ぶのに要る（§10 の連鎖はここで初めて見える）
 *
 *   npx tsx scripts/scoreBoundaries.ts           # 許容差 2%
 *   npx tsx scripts/scoreBoundaries.ts --tol 3   # 許容差を変える
 *
 * `verified: true` のエントリだけを見る。種のままのものは無視する。
 */

const BOUNDARIES_PATH = join(sampleDir(), 'boundaries.json');
const REPORT_PATH = join(import.meta.dirname, '../boundary-report.txt');

const DEFAULT_TOLERANCE = 2;

/** バンドが「同じもの」とみなせる区間の重なり（IoU）。 */
const MIN_IOU = 0.3;

/** 段階の名前。ランが減る順に並べる。 */
const STAGES = ['分割', '本体除去', 'まとめ', '端落とし', '拾い直し'] as const;
type Stage = (typeof STAGES)[number];

const args = process.argv.slice(2);
const tolerance = (() => {
  const at = args.indexOf('--tol');
  return at >= 0 ? Number(args[at + 1] ?? DEFAULT_TOLERANCE) : DEFAULT_TOLERANCE;
})();

if (!existsSync(BOUNDARIES_PATH)) {
  console.log('boundaries.json がありません。まず seedBoundaries.ts で種を作ってください。');
  process.exit(0);
}

/** 学習済みパレットがあれば使う（doDetect・GUI と同じ条件で測るため）。 */
function loadPalette(): Palette {
  const path = join(sampleDir(), 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}

const labels = JSON.parse(readFileSync(BOUNDARIES_PATH, 'utf-8')) as BoundaryLabels;
const verified = Object.entries(labels).filter(([, label]) => label.verified);

if (verified.length === 0) {
  console.log(
    'verified: true のエントリがありません。\n' +
      '種を手で直して "verified": true に変えると、その枚数から測れます。',
  );
  process.exit(0);
}

const palette = loadPalette();
const padding = ROI_OPTIONS.padding ?? 0;

const lines: string[] = [`許容差 ±${tolerance}% / IoU ${MIN_IOU}`, ''];
let edgeTotals = { matched: 0, missed: 0, spurious: 0, errorSum: 0 };
let bandTotals = { matched: 0, missed: 0, spurious: 0 };
const survived = new Map<Stage, number>(STAGES.map((stage) => [stage, 0]));
/** 最終的に失われたバンドが消えた段階 */
const lostAt = new Map<Stage, number>(STAGES.map((stage) => [stage, 0]));
const lostByColor = new Map<string, number>();
let truthBands = 0;
let driftedBoxes = 0;

const toIntervals = (runs: readonly ColorRun[], count: number): BandInterval[] =>
  intervalsFromRuns(
    runs.map((run) => ({ start: run.start, end: run.end })),
    count,
    padding,
    [],
  );

for (const [file, label] of verified) {
  const path = join(sampleDir(), file);
  if (!existsSync(path)) {
    lines.push(`  -  ${file} 画像なし（正解は残す）`);
    continue;
  }

  const read = readResistorImage(await loadRoiImage(path), { palette });
  const analysis = read.analysis;
  if (!read.located || analysis === null || read.box === null) {
    lines.push(`  ×  ${file} 検出失敗`);
    edgeTotals = { ...edgeTotals, missed: edgeTotals.missed + label.bands.length * 2 };
    bandTotals = { ...bandTotals, missed: bandTotals.missed + label.bands.length };
    truthBands += label.bands.length;
    continue;
  }

  // % は「正解を記録したときの箱」を基準にした相対位置。箱が動いていれば
  // 同じ物理的な境界が別の % に移っているので、その行の数字は当てにならない。
  const boxDrifted = !boxMatches(label.box, read.box);
  if (boxDrifted) driftedBoxes += 1;

  const count = analysis.profile.length;
  const detected = intervalsFromRuns(
    analysis.runs.map((run) => ({ start: run.start, end: run.end })),
    count,
    padding,
    analysis.bands.map((band) => band.color as BandColor),
  );

  const edgeScore = scoreBoundaries(detected, label.bands, tolerance);
  edgeTotals = {
    matched: edgeTotals.matched + edgeScore.matched,
    missed: edgeTotals.missed + edgeScore.missed,
    spurious: edgeTotals.spurious + edgeScore.spurious,
    errorSum: edgeTotals.errorSum + edgeScore.meanError * edgeScore.matched,
  };

  const bandScore = scoreBands(detected, label.bands, MIN_IOU);
  bandTotals = {
    matched: bandTotals.matched + bandScore.matched,
    missed: bandTotals.missed + bandScore.missed,
    spurious: bandTotals.spurious + bandScore.spurious,
  };

  // 段階別の生存。本番と同じ道を通すため、解析が使った補正後プロファイルの
  // 本体範囲をそのまま `bandRunStages` に渡す（`analyzeRoi` と同じ切り出し）。
  const analysed =
    analysis.extent === null
      ? analysis.profile
      : analysis.profile.slice(analysis.extent.start, analysis.extent.end);
  const stages = bandRunStages(analysed, { palette, ...SEGMENT_THRESHOLDS });
  const perStage: [Stage, BandInterval[]][] = [
    ['分割', toIntervals(stages.split, count)],
    ['本体除去', toIntervals(stages.afterBody, count)],
    ['まとめ', toIntervals(stages.merged, count)],
    ['端落とし', toIntervals(stages.trimmed, count)],
    ['拾い直し', detected],
  ];

  for (const band of label.bands) {
    truthBands += 1;
    const alive = perStage.map(
      ([, intervals]) => scoreBands(intervals, [band], MIN_IOU).matched === 1,
    );
    alive.forEach((hit, index) => {
      const stage = STAGES[index] as Stage;
      if (hit) survived.set(stage, (survived.get(stage) ?? 0) + 1);
    });

    if (alive[alive.length - 1] === true) continue;
    // 最後に生きていた段の次で消えた（最初から無ければ分割で消えた）
    const lastAlive = alive.lastIndexOf(true);
    const stage = STAGES[lastAlive < 0 ? 0 : lastAlive + 1] as Stage;
    lostAt.set(stage, (lostAt.get(stage) ?? 0) + 1);
    const color = band.color ?? '不明';
    lostByColor.set(color, (lostByColor.get(color) ?? 0) + 1);
  }

  const mark = bandScore.missed === 0 && bandScore.spurious === 0 ? '○' : '△';
  lines.push(
    `  ${mark}  ${file.padEnd(46)}${boxDrifted ? ' [箱ずれ]' : ''} ` +
      `バンド ${bandScore.matched}/${label.bands.length}（余分 ${bandScore.spurious}）/ ` +
      `境界 一致 ${edgeScore.matched} 取りこぼし ${edgeScore.missed} 余分 ${edgeScore.spurious} / ` +
      `平均ずれ ${edgeScore.meanError.toFixed(1)}%`,
  );
}

const truthEdges = edgeTotals.matched + edgeTotals.missed;
const detectedEdges = edgeTotals.matched + edgeTotals.spurious;
const ratio = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(0)}%`;

lines.push(
  '',
  `対象 ${verified.length} 枚 / 正解のバンド ${truthBands} 本 / 正解の境界 ${truthEdges} 本`,
  '',
  '■ バンド単位（本数が合っているか）',
  `  一致 ${bandTotals.matched}/${truthBands}（${ratio(bandTotals.matched, truthBands)}）` +
    ` / 余分なラン ${bandTotals.spurious} 本`,
  '',
  '■ 境界点（位置がどれだけ正確か）',
  `  再現率 ${ratio(edgeTotals.matched, truthEdges)}  適合率 ${ratio(edgeTotals.matched, detectedEdges)}` +
    `  平均ずれ ${edgeTotals.matched === 0 ? 0 : (edgeTotals.errorSum / edgeTotals.matched).toFixed(2)}%`,
  '',
  '■ 段階別に生き残った正解バンド',
);
for (const stage of STAGES) {
  const count = survived.get(stage) ?? 0;
  lines.push(`  ${stage.padEnd(10)} ${String(count).padStart(3)} / ${truthBands}`);
}

const lost = [...lostAt].filter(([, count]) => count > 0);
if (lost.length > 0) {
  lines.push('', '■ 失われたバンドが消えた段階');
  for (const [stage, count] of lost) lines.push(`  ${stage.padEnd(10)} ${count} 本`);
  lines.push('', '■ 失われたバンドの色');
  for (const [color, count] of [...lostByColor].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${color.padEnd(10)} ${count} 本`);
  }
}

if (driftedBoxes > 0) {
  lines.push(
    '',
    `※ ${driftedBoxes} 枚で検出ボックスが正解記録時からずれています（[箱ずれ]）。`,
    '  % の基準が変わっているので、その行の数字は当てになりません。',
    '  seedBoundaries.ts で取り直して確認しなおしてください。',
  );
}

const report = `${lines.join('\n')}\n`;
writeFileSync(REPORT_PATH, report, 'utf-8');
console.log(report);
console.log(`（${REPORT_PATH} にも書きました）`);
