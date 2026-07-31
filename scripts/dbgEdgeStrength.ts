import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage } from '../src/annotate/read.js';
import { edgeStrength } from '../src/core/bands/edgeStrength.js';
import { alongPercentAt, type BoundaryLabels } from '../src/core/bands/boundaries.js';
import { ROI_OPTIONS } from '../src/core/settings.js';
import { sampleDir } from '../tests/fixtures/loadSample.js';
import type { ProfileSample } from '../src/types.js';

/**
 * 新しい境界指標（平滑化微分 + MAD 正規化 + max）が、人手の正解境界の位置で
 * どれだけ立つかを測る。
 *
 *   npx tsx scripts/dbgEdgeStrength.ts
 *
 * 見るのは 2 つ。
 *
 * - **正解の境界での値**が、本体の内側（境界でないところ）よりどれだけ高いか
 * - 山を上から順に取ったとき、正解の境界を何本目までに拾えるか
 *
 * 指標そのものの良し悪しを見るためのもので、分割アルゴリズムは触らない。
 * 効くと分かってから `splitRuns` に入れる（`docs/13-バンド境界の検出指標.md` §6）。
 */

const BOUNDARIES_PATH = join(sampleDir(), 'boundaries.json');

/** 正解の境界とみなす許容差 [%]。採点器の既定と合わせる。 */
const TOLERANCE_PERCENT = 2;

if (!existsSync(BOUNDARIES_PATH)) {
  console.log('boundaries.json がありません。');
  process.exit(0);
}

const labels = JSON.parse(readFileSync(BOUNDARIES_PATH, 'utf-8')) as BoundaryLabels;
const verified = Object.entries(labels).filter(([, label]) => label.verified);

if (verified.length === 0) {
  console.log('verified: true のエントリがありません。');
  process.exit(0);
}

/** 素の中心差分の絶対値の和（現行の abs 相当）。比較の相手。 */
function plainAbs(profile: readonly ProfileSample[]): number[] {
  return profile.map((_, index) => {
    const prev = profile[Math.max(0, index - 1)] as ProfileSample;
    const next = profile[Math.min(profile.length - 1, index + 1)] as ProfileSample;
    const span = Math.min(profile.length - 1, index + 1) - Math.max(0, index - 1);
    const scale = Math.max(1, span);
    return (
      Math.abs(next.lab.l - prev.lab.l) / scale +
      Math.abs(next.lab.a - prev.lab.a) / scale +
      Math.abs(next.lab.b - prev.lab.b) / scale
    );
  });
}

interface Outcome {
  readonly file: string;
  readonly metric: string;
  /** 正解の境界での値の中央値 */
  readonly atEdge: number;
  /** 境界でないところの値の中央値 */
  readonly elsewhere: number;
  /** 正解の境界を上位何本の山で拾えたか（正解の本数ぶん取ったときの一致数） */
  readonly hits: number;
  readonly edges: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** 極大点だけを候補にする（同じ山の肩を何本も数えないため）。 */
function peaksOf(strength: readonly number[]): number[] {
  const peaks: number[] = [];
  for (let index = 1; index < strength.length - 1; index += 1) {
    const value = strength[index] as number;
    if (value >= (strength[index - 1] as number) && value > (strength[index + 1] as number)) {
      peaks.push(index);
    }
  }
  return peaks;
}

const outcomes: Outcome[] = [];

for (const [file, label] of verified) {
  const path = join(sampleDir(), file);
  if (!existsSync(path)) continue;

  const read = readResistorImage(await loadRoiImage(path), {});
  const analysis = read.analysis;
  if (analysis === null) {
    console.log(`  -  ${file} 解析できない`);
    continue;
  }

  const profile = analysis.profile;
  const padding = ROI_OPTIONS.padding ?? 0;
  const percentAt = (index: number): number => alongPercentAt(index, profile.length, padding);
  const truthEdges = label.bands.flatMap((band) => [band.start, band.end]);
  const isEdge = (index: number): boolean =>
    truthEdges.some((edge) => Math.abs(percentAt(index) - edge) <= TOLERANCE_PERCENT);

  for (const [metric, strength] of [
    ['素の abs', plainAbs(profile)],
    ['平滑化 + 正規化 max', edgeStrength(profile)],
  ] as const) {
    const edgeValues = strength.filter((_, index) => isEdge(index));
    const otherValues = strength.filter((_, index) => !isEdge(index));

    // 正解の本数ぶんだけ山を取ったとき、いくつ当たるか
    const ranked = peaksOf(strength)
      .sort((a, b) => (strength[b] as number) - (strength[a] as number))
      .slice(0, truthEdges.length);
    const used = new Set<number>();
    let hits = 0;
    for (const edge of truthEdges) {
      const found = ranked.find(
        (index) => !used.has(index) && Math.abs(percentAt(index) - edge) <= TOLERANCE_PERCENT,
      );
      if (found !== undefined) {
        used.add(found);
        hits += 1;
      }
    }

    outcomes.push({
      file,
      metric,
      atEdge: median(edgeValues),
      elsewhere: median(otherValues),
      hits,
      edges: truthEdges.length,
    });
  }
}

console.log(`\n許容差 ±${TOLERANCE_PERCENT}% / 対象 ${verified.length} 枚\n`);
console.log(
  'ファイル'.padEnd(44),
  '指標'.padEnd(20),
  '境界での値'.padStart(10),
  'それ以外'.padStart(9),
  '比'.padStart(6),
  '上位一致'.padStart(9),
);
for (const outcome of outcomes) {
  const ratio = outcome.elsewhere === 0 ? Infinity : outcome.atEdge / outcome.elsewhere;
  console.log(
    outcome.file.padEnd(44),
    outcome.metric.padEnd(20),
    outcome.atEdge.toFixed(2).padStart(10),
    outcome.elsewhere.toFixed(2).padStart(9),
    ratio.toFixed(2).padStart(6),
    `${outcome.hits}/${outcome.edges}`.padStart(9),
  );
}

for (const metric of ['素の abs', '平滑化 + 正規化 max']) {
  const group = outcomes.filter((outcome) => outcome.metric === metric);
  if (group.length === 0) continue;
  const hits = group.reduce((sum, outcome) => sum + outcome.hits, 0);
  const edges = group.reduce((sum, outcome) => sum + outcome.edges, 0);
  const ratio = median(
    group.map((outcome) => (outcome.elsewhere === 0 ? 0 : outcome.atEdge / outcome.elsewhere)),
  );
  console.log(
    `\n${metric}: 上位一致 ${hits}/${edges} (${((hits / edges) * 100).toFixed(0)}%) / 境界とそれ以外の比の中央値 ${ratio.toFixed(2)}`,
  );
}
