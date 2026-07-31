import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage } from '../src/annotate/read.js';
import { alignRunsToBands } from '../src/core/bands/align.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * 彩度の圧縮率を測るツール（docs/14 §8）。
 *
 * `buildAdaptation` は L を**乗算**、a,b を**加算**で補正するだけで、
 * **彩度の倍率を持たない**。露出・WB で彩度が縮むと加算では直せない。
 *
 * ただしパレットは同じ写真から学習しているので、全体の中央値はほぼ 1 になる
 * （学習が平均を吸収している）。**効くかどうかは写真ごとのばらつきで決まる。**
 * 1 枚ごとの倍率が揃っているなら、ゲイン項を足しても直すものが無い。
 *
 *   npx tsx scripts/dbgChroma.ts
 */

/** 基準の彩度がこれ未満の色は倍率の推定に使わない（黒・灰・白は 0 除算になる）。 */
const MIN_REFERENCE_CHROMA = 12;

/** 倍率の推定に必要な最小のバンド数。 */
const MIN_BANDS_FOR_GAIN = 2;

/**
 * 倍率の推定から外す色。
 *
 * 金・銀は基準色そのものが実写と合っていない疑いがある（`align.ts` の
 * `maxBandSkips` のコメント: 金を正しく学ぶには人手ラベルが要る）。
 * 「写真ごとの彩度ゲイン」と「基準色の誤り」を混ぜて測らないために外す。
 */
const EXCLUDED: ReadonlySet<BandColor> = new Set<BandColor>(['gold', 'silver']);

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

const chroma = (lab: LabColor): number => Math.hypot(lab.a, lab.b);

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
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

const dir = '../sample';
const palette = loadPalette(dir);
const labels = loadLabels(dir);

console.log('1 枚ごとの彩度の倍率（基準の彩度 ÷ 実測の彩度）。1 なら補正不要');
console.log('');
console.log('   ファイル                                    倍率  使ったバンド');

const gains: number[] = [];
const perColor = new Map<BandColor, number[]>();
/** ラン数とラベル数が一致した検体だけの実測 Lab。 */
const exactObserved = new Map<BandColor, LabColor[]>();

for (const [file, sequence] of Object.entries(labels).sort()) {
  const image = await loadRoiImage(join(dir, file));
  const read = readResistorImage(image, { palette });
  const runs = read.analysis?.runs ?? [];
  if (runs.length === 0) continue;

  const aligned = bestAlignment(runs, sequence, palette);
  if (aligned === null) continue;

  // ラン数とラベル数が一致する検体では、順序を保つ対応付けは 1 通りしかない。
  // 色の近さで選ぶ余地が無いので、**色の実測値として信用できる**。
  // 一致しない検体では、存在しないバンド（多くは金）が余った背景のランに
  // 押し付けられる（`align.ts` の maxBandSkips のコメント）
  const exact = runs.length === sequence.length;
  if (exact) {
    for (const [index, run] of runs.entries()) {
      const color = aligned.get(index);
      if (color === undefined) continue;
      exactObserved.set(color, [...(exactObserved.get(color) ?? []), run.lab]);
    }
  }

  const ratios: string[] = [];
  const values: number[] = [];
  for (const [index, run] of runs.entries()) {
    const color = aligned.get(index);
    if (color === undefined) continue;
    const reference = chroma(palette.colors[color]);
    const observed = chroma(run.lab);
    if (reference < MIN_REFERENCE_CHROMA || observed <= 0) continue;
    const ratio = reference / observed;
    perColor.set(color, [...(perColor.get(color) ?? []), ratio]);
    ratios.push(`${color} ${ratio.toFixed(2)}`);
    if (EXCLUDED.has(color)) continue;
    values.push(ratio);
  }
  if (values.length < MIN_BANDS_FOR_GAIN) continue;

  const gain = median(values);
  gains.push(gain);
  console.log(`   ${file.padEnd(42)} ${gain.toFixed(2).padStart(5)}  ${ratios.join(' / ')}`);
}

const sorted = [...gains].sort((a, b) => a - b);
console.log('');
console.log(`枚数 ${gains.length}`);
if (gains.length > 0) {
  console.log(
    `倍率の分布: 最小 ${(sorted[0] as number).toFixed(2)}  ` +
      `25% ${(sorted[Math.floor(sorted.length * 0.25)] as number).toFixed(2)}  ` +
      `中央 ${median(gains).toFixed(2)}  ` +
      `75% ${(sorted[Math.floor(sorted.length * 0.75)] as number).toFixed(2)}  ` +
      `最大 ${(sorted[sorted.length - 1] as number).toFixed(2)}`,
  );
  const spread = (sorted[sorted.length - 1] as number) / (sorted[0] as number);
  console.log(`最大 ÷ 最小 = ${spread.toFixed(2)} 倍`);
  console.log('');
  console.log(
    spread < 1.5
      ? '→ ばらつきが小さい。1 枚ごとのゲイン項を足しても直すものがほとんど無い'
      : '→ ばらつきが大きい。加算のシフトでは直せない差が残っている',
  );
}

console.log('');
console.log('ラン数とラベル数が一致した検体だけの実測 Lab（対応が順序で確定する）');
console.log('   色       件数  実測 Lab              基準 Lab              彩度の比');
for (const color of [...exactObserved.keys()].sort()) {
  const samples = exactObserved.get(color) as LabColor[];
  const observed = {
    l: median(samples.map((lab) => lab.l)),
    a: median(samples.map((lab) => lab.a)),
    b: median(samples.map((lab) => lab.b)),
  };
  const reference = palette.colors[color];
  const ratio = chroma(observed) === 0 ? Number.NaN : chroma(reference) / chroma(observed);
  const show = (lab: LabColor): string =>
    `L${lab.l.toFixed(0).padStart(4)} a${lab.a.toFixed(0).padStart(4)} b${lab.b.toFixed(0).padStart(4)}`;
  console.log(
    `   ${color.padEnd(8)} ${String(samples.length).padStart(3)}  ${show(observed)}   ` +
      `${show(reference)}   ${ratio.toFixed(2).padStart(5)}`,
  );
}

console.log('');
console.log('色ごとの倍率（1 から離れているほど基準色が実写と合っていない）');
console.log('   色       件数  中央  最小  最大');
for (const [color, values] of [...perColor.entries()].sort(
  (a, b) => median(b[1]) - median(a[1]),
)) {
  const sortedValues = [...values].sort((a, b) => a - b);
  console.log(
    `   ${color.padEnd(8)} ${String(values.length).padStart(3)}  ` +
      `${median(values).toFixed(2).padStart(5)} ` +
      `${(sortedValues[0] as number).toFixed(2).padStart(5)} ` +
      `${(sortedValues[sortedValues.length - 1] as number).toFixed(2).padStart(5)}` +
      `${EXCLUDED.has(color) ? '   （倍率の推定から除外）' : ''}`,
  );
}
