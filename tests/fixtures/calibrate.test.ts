import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractProfile } from '../../src/core/bands/profile.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import { identifyBody, splitRuns } from '../../src/core/bands/runs.js';
import { alignRunsToBands } from '../../src/core/bands/align.js';
import { buildBodyAnchorAdaptation } from '../../src/core/color/anchor.js';
import { adaptToAnchor } from '../../src/core/color/whiteBalance.js';
import { labToRgb } from '../../src/core/color/colorSpace.js';
import { BAND_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import type { BandColor, LabColor, ProfileSample } from '../../src/types.js';
import { hasSamples, loadImage, loadManifest, loadPalette, type SampleEntry } from './loadSample.js';

/**
 * 基準色テーブルの較正（Step 0-7）。
 *
 * 各写真の正解値からバンド色の並びが分かるので、抽出したランと突き合わせて
 * 「この色は実際にどんな Lab に写るか」を集計する。既定の基準色は見た目からの
 * 推定値なので、実写に合わせて置き換える。
 */

const REPORT_PATH = join(import.meta.dirname, '../../calibration.txt');
/** 学習結果のパレット。ここに書き出したものを解析側が読み込む。 */
const PALETTE_PATH = join(import.meta.dirname, '../../../sample/palette.json');
/** 人手による修正ラベル。推測が間違っていたときはここで上書きする。 */
const LABELS_PATH = join(import.meta.dirname, '../../../sample/labels.json');

/** 対応付けのコストがこれを超えたら信用せず、較正に使わない。 */
const MAX_ALIGN_COST = 25;

const ROI_HEIGHT = 40;
const ROI_PADDING = 0.06;
const EDGE_DELTA_E = 4;
const CLUSTER_DELTA_E = 4;
const MIN_RUN_LENGTH = 3;
/** この件数に満たない色は学習結果として採用しない（既定値のまま残す）。 */
const MIN_SAMPLES_PER_COLOR = 3;

const DIGITS: BandColor[] = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white',
];
const MULTIPLIER_BY_EXPONENT: Record<number, BandColor> = {
  [-2]: 'silver', [-1]: 'gold', 0: 'black', 1: 'brown', 2: 'red', 3: 'orange',
  4: 'yellow', 5: 'green', 6: 'blue', 7: 'violet', 8: 'grey', 9: 'white',
};
const TOLERANCE_COLOR: Record<number, BandColor> = {
  0.1: 'violet', 0.5: 'green', 1: 'brown', 2: 'red', 5: 'gold', 10: 'silver',
};

/** 人手による修正ラベル（ファイル名 → 正しいバンド列）。 */
function loadLabels(): Record<string, BandColor[]> {
  if (!existsSync(LABELS_PATH)) return {};
  return JSON.parse(readFileSync(LABELS_PATH, 'utf-8')) as Record<string, BandColor[]>;
}

/** 抵抗値と許容差から、あり得るバンド列を列挙する（2桁=4本 / 3桁=5本）。 */
function candidateSequences(entry: SampleEntry, labels: Record<string, BandColor[]>): BandColor[][] {
  const manual = labels[entry.file];
  if (manual) return [manual];
  if (entry.bands) return [entry.bands as BandColor[]];

  const sequences: BandColor[][] = [];
  for (const digits of [2, 3]) {
    for (let exponent = -2; exponent <= 9; exponent += 1) {
      const significand = entry.ohms / 10 ** exponent;
      if (Math.abs(significand - Math.round(significand)) > 1e-9) continue;
      const rounded = Math.round(significand);
      if (rounded < 10 ** (digits - 1) || rounded >= 10 ** digits) continue;
      const multiplier = MULTIPLIER_BY_EXPONENT[exponent];
      if (multiplier === undefined) continue;

      const base = [...String(rounded)].map((d) => DIGITS[Number(d)] as BandColor);
      base.push(multiplier);
      if (entry.tolerance !== null) {
        const tolerance = TOLERANCE_COLOR[entry.tolerance];
        if (tolerance === undefined) continue;
        base.push(tolerance);
      }
      sequences.push(base);
    }
  }
  return sequences;
}

interface Run {
  readonly lab: LabColor;
  readonly length: number;
}

/** 本体ランを除いた「バンド候補」のランを取り出す（分類はしない）。 */
function extractRuns(profile: readonly ProfileSample[]): Run[] {
  const runs = splitRuns(profile, { edgeDeltaE: EDGE_DELTA_E, minRunLength: MIN_RUN_LENGTH });
  const body = identifyBody(runs, CLUSTER_DELTA_E);
  if (body === null) return [];

  const bodyRuns = new Set(body.runIndices);
  return runs
    .map((run, index) => ({ run, index }))
    .filter(({ index }) => !bodyRuns.has(index))
    .map(({ run }) => ({ lab: run.lab, length: run.end - run.start }));
}

function medianLab(samples: readonly LabColor[]): LabColor {
  const pick = (key: (c: LabColor) => number): number => {
    const values = samples.map(key).sort((a, b) => a - b);
    return values[values.length >> 1] as number;
  };
  return { l: pick((c) => c.l), a: pick((c) => c.a), b: pick((c) => c.b) };
}

describe.skipIf(!hasSamples())('基準色の較正', () => {
  it('実写真からバンド色の Lab を集計する', { timeout: 600_000 }, async () => {
    const entries = loadManifest();
    const labels = loadLabels();
    // 前回の学習結果があれば、それを使って対応付ける（反復するほど精度が上がる）
    const palette = loadPalette();
    const observed = new Map<BandColor, LabColor[]>();
    const lines: string[] = [];
    let matched = 0;

    for (const entry of entries) {
      const image = await loadImage(entry.file);
      const box = locateResistor(image);
      if (box === null) continue;

      const roi = rectify(image, box, { padding: ROI_PADDING, targetHeight: ROI_HEIGHT });
      const raw = extractProfile(roi);
      const { adaptation } = buildBodyAnchorAdaptation(raw);
      const profile = raw.map((s) => ({ x: s.x, lab: adaptToAnchor(s.lab, adaptation) }));
      const runs = extractRuns(profile);

      // 余分なランを飛ばしながら対応付ける（本数一致は要求しない）
      let bestAligned: { cost: number; sequence: BandColor[]; assignments: readonly { runIndex: number; color: BandColor }[] } | null = null;
      for (const sequence of candidateSequences(entry, labels)) {
        for (const oriented of [sequence, [...sequence].reverse()]) {
          const aligned = alignRunsToBands(
            runs.map((run) => ({ lab: run.lab, width: run.length })),
            oriented,
            { maxSkips: 4, palette },
          );
          if (aligned !== null && (bestAligned === null || aligned.cost < bestAligned.cost)) {
            bestAligned = { cost: aligned.cost, sequence: oriented, assignments: aligned.assignments };
          }
        }
      }

      if (bestAligned === null) {
        lines.push(`  - ${entry.file}: ラン ${runs.length} 本、対応付け不可`);
        continue;
      }
      if (bestAligned.cost > MAX_ALIGN_COST) {
        lines.push(`  ! ${entry.file}: コスト ${bestAligned.cost.toFixed(1)} が高すぎるため較正に使わない`);
        continue;
      }
      matched += 1;
      lines.push(`  ○ ${entry.file}: ${bestAligned.sequence.join('-')} (コスト ${bestAligned.cost.toFixed(1)})`);

      for (const { runIndex, color } of bestAligned.assignments) {
        const run = runs[runIndex];
        if (run === undefined) continue;
        const list = observed.get(color) ?? [];
        list.push(run.lab);
        observed.set(color, list);
      }
    }

    const table: string[] = ['', `並びが一致した画像: ${matched}/${entries.length}`, ''];
    table.push('色       件数  現在の Lab               実写の Lab               sRGB 換算');
    for (const color of [...DIGITS, 'gold', 'silver'] as BandColor[]) {
      const samples = observed.get(color) ?? [];
      const current = BAND_REFERENCE_COLORS[color];
      if (samples.length === 0) {
        table.push(`${color.padEnd(8)} ${String(0).padStart(4)}  ` +
          `L${current.l.toFixed(0).padStart(4)} a${current.a.toFixed(0).padStart(4)} b${current.b.toFixed(0).padStart(4)}   （データなし）`);
        continue;
      }
      const median = medianLab(samples);
      const rgb = labToRgb(median);
      table.push(
        `${color.padEnd(8)} ${String(samples.length).padStart(4)}  ` +
          `L${current.l.toFixed(0).padStart(4)} a${current.a.toFixed(0).padStart(4)} b${current.b.toFixed(0).padStart(4)}   ` +
          `L${median.l.toFixed(0).padStart(4)} a${median.a.toFixed(0).padStart(4)} b${median.b.toFixed(0).padStart(4)}   ` +
          `[${Math.round(rgb.r * 255)}, ${Math.round(rgb.g * 255)}, ${Math.round(rgb.b * 255)}]`,
      );
    }

    // 学習したパレットを書き出す（データが取れた色だけ）
    const learned: Partial<Record<BandColor, LabColor>> = {};
    for (const [color, samples] of observed) {
      if (samples.length >= MIN_SAMPLES_PER_COLOR) learned[color] = medianLab(samples);
    }
    writeFileSync(
      PALETTE_PATH,
      JSON.stringify({ generatedFrom: `${matched} images`, colors: learned }, null, 2) + '\n',
      'utf-8',
    );

    writeFileSync(REPORT_PATH, [...table, '', ...lines, ''].join('\n'), 'utf-8');
    expect(matched).toBeGreaterThan(0);
  });
});
