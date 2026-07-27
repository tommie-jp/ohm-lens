import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRoi } from '../../src/core/pipeline.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import type { RoiImage } from '../../src/core/bands/profile.js';
import { hasSamples, loadImage, loadManifest, type SampleEntry } from './loadSample.js';

/**
 * 閾値の掃引（Step 0-7 の較正）。
 * 実写真に対する正解率が最大になるパラメータを探す。
 */

const REPORT_PATH = join(import.meta.dirname, '../../sweep-report.txt');

const EDGE_DELTA_E = [6, 9, 12, 16, 20];
const CLUSTER_DELTA_E = [10, 14, 18, 24, 30];
const MIN_BAND_WIDTH = [2, 3, 5];
const ROI_HEIGHTS = [40];
const ROI_PADDING = 0.06;

describe.skipIf(!hasSamples())('閾値の掃引', () => {
  it('本体色閾値とバンド最小幅の組み合わせを評価する', { timeout: 600_000 }, async () => {
    const entries = loadManifest();

    // 画像の読み込みと ROI 化は 1 回だけ（掃引のたびにやると遅い）
    const rois: { entry: SampleEntry; roi: RoiImage; width: number }[] = [];
    for (const entry of entries) {
      const image = await loadImage(entry.file);
      const box = locateResistor(image);
      if (box === null) continue;
      for (const height of ROI_HEIGHTS) {
        rois.push({ entry, roi: rectify(image, box, { padding: ROI_PADDING, targetHeight: height }), width: height });
      }
    }

    const lines: string[] = [`ROI 化できた画像: ${rois.length}/${entries.length}`, ''];
    lines.push('ROI幅  edgeΔE  clusterΔE  minWidth  正解  デコード成功');

    let best = { edgeDeltaE: 0, clusterDeltaE: 0, minBandWidth: 0, roiWidth: 0, correct: -1 };
    for (const roiWidth of ROI_HEIGHTS) {
    for (const edgeDeltaE of EDGE_DELTA_E) {
      for (const clusterDeltaE of CLUSTER_DELTA_E) {
      for (const minBandWidth of MIN_BAND_WIDTH) {
        let correct = 0;
        let decoded = 0;
        for (const { entry, roi } of rois.filter((r) => r.width === roiWidth)) {
          const result = analyzeRoi(roi, {
            segment: { edgeDeltaE, minBandWidth, clusterDeltaE },
            extent: { edgeDeltaE, minRunLength: minBandWidth, clusterDeltaE },
          });
          const ohms = result.reading?.ohms;
          if (ohms !== undefined && ohms !== null) decoded += 1;
          if (ohms !== undefined && ohms !== null && Math.abs(ohms - entry.ohms) / entry.ohms < 1e-6) {
            correct += 1;
          }
        }
        lines.push(
          `${String(roiWidth).padStart(4)}  ${String(edgeDeltaE).padStart(6)}  ${String(clusterDeltaE).padStart(9)}  ${String(minBandWidth).padStart(8)}  ` +
            `${String(correct).padStart(4)}  ${String(decoded).padStart(12)}`,
        );
        if (correct > best.correct) best = { edgeDeltaE, clusterDeltaE, minBandWidth, roiWidth, correct };
      }
      }
    }
    }

    lines.push(
      '',
      `最良: ROI幅=${best.roiWidth} edgeΔE=${best.edgeDeltaE} clusterΔE=${best.clusterDeltaE} minWidth=${best.minBandWidth} → ${best.correct}/${entries.length} (${((best.correct / entries.length) * 100).toFixed(0)}%)`,
    );
    writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');

    expect(best.correct).toBeGreaterThanOrEqual(0);
  });
});
