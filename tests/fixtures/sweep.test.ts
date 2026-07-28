import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRoi } from '../../src/core/pipeline.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import { refineBoxExtent } from '../../src/core/refine.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../../src/core/settings.js';
import { isReportable } from '../../src/core/format.js';
import type { RoiImage } from '../../src/core/bands/profile.js';
import type { AnalyzeOptions } from '../../src/core/pipeline.js';
import { hasSamples, loadImage, loadManifest, loadPalette, type SampleEntry } from './loadSample.js';

/**
 * 閾値の掃引（Step 0-7 の較正）。
 *
 * **ROI 化までは本番条件（`core/settings.ts`）で行い、掃引するのは
 * ラン分割のパラメータだけ**にする。以前はここで `ROI_PADDING = 0.06` を
 * 直書きし、`refineBoxExtent` も `bodyRange` も `bodyLightnessWeight` も
 * 渡していなかったため、掃引の「最良」が本番では再現しなかった。
 *
 * 評価は「値一致」ではなく**実機での見え方（正解 / 誤答 / 保留）**で行う。
 * 誤った値を自信ありげに出さない方針なので、正解が増えても誤答が増える
 * 組み合わせは採らない。
 */

const REPORT_PATH = join(import.meta.dirname, '../../sweep-report.txt');

const EDGE_DELTA_E = [6, 9, 12, 16, 20];
const CLUSTER_DELTA_E = [10, 14, 18, 24, 30];
const MIN_BAND_WIDTH = [2, 3, 5];

interface Prepared {
  readonly entry: SampleEntry;
  readonly roi: RoiImage;
  /** 本番条件の解析オプション。掃引ではこの上に分割パラメータを重ねる。 */
  readonly base: AnalyzeOptions;
}

interface Score {
  readonly correct: number;
  readonly wrong: number;
  readonly held: number;
  readonly decoded: number;
}

function evaluate(prepared: readonly Prepared[], overrides: {
  edgeDeltaE: number;
  clusterDeltaE: number;
  minBandWidth: number;
}): Score {
  let correct = 0;
  let wrong = 0;
  let held = 0;
  let decoded = 0;

  for (const { entry, roi, base } of prepared) {
    const result = analyzeRoi(roi, {
      ...base,
      segment: {
        ...base.segment,
        edgeDeltaE: overrides.edgeDeltaE,
        clusterDeltaE: overrides.clusterDeltaE,
        minBandWidth: overrides.minBandWidth,
      },
      extent: {
        edgeDeltaE: overrides.edgeDeltaE,
        clusterDeltaE: overrides.clusterDeltaE,
        minRunLength: overrides.minBandWidth,
      },
    });

    const ohms = result.reading?.ohms ?? null;
    if (ohms !== null) decoded += 1;

    // 実機での見え方で三分する（確信度が低ければ値を出さない）
    if (ohms === null || !isReportable(result.reading ?? null)) {
      held += 1;
    } else if (Math.abs(ohms - entry.ohms) / entry.ohms < 1e-6) {
      correct += 1;
    } else {
      wrong += 1;
    }
  }

  return { correct, wrong, held, decoded };
}

describe.skipIf(!hasSamples())('閾値の掃引', () => {
  it('ラン分割のパラメータを本番条件で評価する', { timeout: 900_000 }, async () => {
    // Arrange: 画像の読み込みと ROI 化は 1 回だけ（掃引のたびにやると遅い）
    const entries = loadManifest();
    const palette = loadPalette();
    const prepared: Prepared[] = [];

    for (const entry of entries) {
      const image = await loadImage(entry.file);
      const located = locateResistor(image);
      if (located === null) continue;

      const box = refineBoxExtent(located, image, refineOptions(palette));
      prepared.push({
        entry,
        roi: rectify(image, box, ROI_OPTIONS),
        base: analyzeOptions(box, palette),
      });
    }

    // Act
    const lines: string[] = [
      '解析条件: core/settings.ts（ROI 化・パレット・本体範囲は本番と同一）',
      '掃引するのはラン分割のパラメータのみ',
      '',
      `ROI 化できた画像: ${prepared.length}/${entries.length}`,
      '',
      'edgeΔE  clusterΔE  minWidth  正解  誤答  保留  デコード成功',
    ];

    let best = { edgeDeltaE: 0, clusterDeltaE: 0, minBandWidth: 0, correct: -1, wrong: 0 };
    for (const edgeDeltaE of EDGE_DELTA_E) {
      for (const clusterDeltaE of CLUSTER_DELTA_E) {
        for (const minBandWidth of MIN_BAND_WIDTH) {
          const score = evaluate(prepared, { edgeDeltaE, clusterDeltaE, minBandWidth });
          lines.push(
            `${String(edgeDeltaE).padStart(6)}  ${String(clusterDeltaE).padStart(9)}  ` +
              `${String(minBandWidth).padStart(8)}  ${String(score.correct).padStart(4)}  ` +
              `${String(score.wrong).padStart(4)}  ${String(score.held).padStart(4)}  ` +
              `${String(score.decoded).padStart(12)}`,
          );
          // 誤答が増える組み合わせは、正解が増えても採らない
          const better =
            score.wrong < best.wrong ||
            (score.wrong === best.wrong && score.correct > best.correct);
          if (best.correct < 0 || better) {
            best = { edgeDeltaE, clusterDeltaE, minBandWidth, correct: score.correct, wrong: score.wrong };
          }
        }
      }
    }

    lines.push(
      '',
      `最良: edgeΔE=${best.edgeDeltaE} clusterΔE=${best.clusterDeltaE} ` +
        `minWidth=${best.minBandWidth} → 正解 ${best.correct}/${entries.length} ` +
        `(${((best.correct / entries.length) * 100).toFixed(0)}%) 誤答 ${best.wrong}`,
    );
    writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');

    // Assert（レポート目的なので閾値では落とさない）
    expect(best.correct).toBeGreaterThanOrEqual(0);
  });
});
