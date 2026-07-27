import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractProfile } from '../../src/core/bands/profile.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import { isBodyColor } from '../../src/core/bands/classify.js';
import { buildBodyAnchorAdaptation } from '../../src/core/color/anchor.js';
import { adaptToAnchor } from '../../src/core/color/whiteBalance.js';
import { deltaE2000, labToRgb } from '../../src/core/color/colorSpace.js';
import { BAND_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import type { BandColor, LabColor, ProfileSample } from '../../src/types.js';
import { hasSamples, loadImage, loadManifest, type SampleEntry } from './loadSample.js';

/**
 * 基準色テーブルの較正（Step 0-7）。
 *
 * 各写真の正解値からバンド色の並びが分かるので、抽出したランと突き合わせて
 * 「この色は実際にどんな Lab に写るか」を集計する。既定の基準色は見た目からの
 * 推定値なので、実写に合わせて置き換える。
 */

const REPORT_PATH = join(import.meta.dirname, '../../calibration.txt');

const ROI_HEIGHT = 40;
const ROI_PADDING = 0.06;
const BODY_DELTA_E = 4;
const MIN_RUN_LENGTH = 3;

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

/** 抵抗値と許容差から、あり得るバンド列を列挙する（2桁=4本 / 3桁=5本）。 */
function candidateSequences(entry: SampleEntry): BandColor[][] {
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

/** 本体色を除いた連続ランを取り出す（分類はしない）。 */
function extractRuns(profile: readonly ProfileSample[]): Run[] {
  const runs: Run[] = [];
  let current: ProfileSample[] = [];

  const flush = (): void => {
    if (current.length >= MIN_RUN_LENGTH) {
      const sorted = (key: (s: ProfileSample) => number): number => {
        const values = current.map(key).sort((a, b) => a - b);
        return values[values.length >> 1] as number;
      };
      runs.push({
        lab: { l: sorted((s) => s.lab.l), a: sorted((s) => s.lab.a), b: sorted((s) => s.lab.b) },
        length: current.length,
      });
    }
    current = [];
  };

  for (const sample of profile) {
    if (isBodyColor(sample.lab, BODY_DELTA_E)) flush();
    else current.push(sample);
  }
  flush();
  return runs;
}

/** 現在の基準色に対する総 ΔE。小さいほど「その並びらしい」。 */
function sequenceCost(runs: readonly Run[], sequence: readonly BandColor[]): number {
  return runs.reduce(
    (sum, run, index) => sum + deltaE2000(run.lab, BAND_REFERENCE_COLORS[sequence[index] as BandColor]),
    0,
  );
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

      // 本数が一致する並びだけを採用する（順方向・逆方向の両方を試す）
      const options = candidateSequences(entry)
        .filter((sequence) => sequence.length === runs.length)
        .flatMap((sequence) => [sequence, [...sequence].reverse()]);
      if (options.length === 0) {
        lines.push(`  - ${entry.file}: ラン ${runs.length} 本、一致する並びなし`);
        continue;
      }

      const bestSequence = options.reduce((best, sequence) =>
        sequenceCost(runs, sequence) < sequenceCost(runs, best) ? sequence : best,
      );
      matched += 1;
      lines.push(`  ○ ${entry.file}: ${bestSequence.join('-')}`);

      runs.forEach((run, index) => {
        const color = bestSequence[index] as BandColor;
        const list = observed.get(color) ?? [];
        list.push(run.lab);
        observed.set(color, list);
      });
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

    writeFileSync(REPORT_PATH, [...table, '', ...lines, ''].join('\n'), 'utf-8');
    expect(matched).toBeGreaterThan(0);
  });
});
