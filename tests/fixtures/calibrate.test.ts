import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractProfile } from '../../src/core/bands/profile.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import { bodyColumns } from '../../src/core/roiMapping.js';
import { bandRuns } from '../../src/core/bands/segment.js';
import { alignRunsToBands } from '../../src/core/bands/align.js';
import {
  addObservations,
  expectedSequences,
  paletteOverrides,
  type Observations,
} from '../../src/core/learning.js';
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
const ROI_PADDING = 0.28;
const BODY_MARGIN = 0.18;
const BODY_LIGHTNESS_WEIGHT = 0.6;
const EDGE_DELTA_E = 9;
const CLUSTER_DELTA_E = 18;
const MIN_RUN_LENGTH = 3;
/** この件数に満たない色は学習結果として採用しない（既定値のまま残す）。 */
const MIN_SAMPLES_PER_COLOR = 3;

const DIGITS: BandColor[] = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white',
];

/** 人手による修正ラベル（ファイル名 → 正しいバンド列）。 */
function loadLabels(): Record<string, BandColor[]> {
  if (!existsSync(LABELS_PATH)) return {};
  return JSON.parse(readFileSync(LABELS_PATH, 'utf-8')) as Record<string, BandColor[]>;
}

/** あり得るバンド列。人手ラベル > 実測バンド列 > 値からの逆算。 */
function candidateSequences(entry: SampleEntry, labels: Record<string, BandColor[]>): BandColor[][] {
  const manual = labels[entry.file];
  if (manual) return [manual];
  if (entry.bands) return [entry.bands as BandColor[]];
  return expectedSequences(entry.ohms, entry.tolerance);
}

interface Run {
  readonly lab: LabColor;
  readonly length: number;
}

/**
 * 本体ランを除いた「バンド候補」のランを取り出す。
 * 解析側と同じ `bandRuns` を通すので、較正と本番で条件がずれない。
 */
function extractRuns(profile: readonly ProfileSample[]): Run[] {
  return bandRuns(profile, {
    edgeDeltaE: EDGE_DELTA_E,
    minBandWidth: MIN_RUN_LENGTH,
    clusterDeltaE: CLUSTER_DELTA_E,
    bodyLightnessWeight: BODY_LIGHTNESS_WEIGHT,
    keepEdgeRuns: true,
  }).map((run) => ({ lab: run.lab, length: run.end - run.start }));
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

      const rectifyOptions = { padding: ROI_PADDING, targetHeight: ROI_HEIGHT };
      const roi = rectify(image, box, rectifyOptions);
      // 本体の位置は検出結果から決める。較正は取りこぼしを避けたいので広めに取る
      const body = bodyColumns(box, rectifyOptions, BODY_MARGIN);
      const raw = extractProfile(roi).slice(Math.round(body.start), Math.round(body.end));
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

    // 学習したパレットを書き出す。件数と既定値からのずれの判定は
    // GUI の学習と同じ paletteOverrides に任せる（二重管理を避ける）
    let observations: Observations = {};
    for (const [color, samples] of observed) {
      observations = addObservations(observations, samples.map((lab) => ({ color, lab })));
    }
    const learned = paletteOverrides(observations, MIN_SAMPLES_PER_COLOR);
    writeFileSync(
      PALETTE_PATH,
      JSON.stringify({ generatedFrom: `${matched} images`, colors: learned }, null, 2) + '\n',
      'utf-8',
    );

    writeFileSync(REPORT_PATH, [...table, '', ...lines, ''].join('\n'), 'utf-8');
    expect(matched).toBeGreaterThan(0);
  });
});
