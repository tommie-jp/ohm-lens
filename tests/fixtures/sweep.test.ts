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

const BODY_DELTA_E = [4, 5, 6, 7, 8, 10, 12];
const MIN_BAND_WIDTH = [2, 3, 4];
const ROI_HEIGHT = 40;
const ROI_PADDING = 0.06;

describe.skipIf(!hasSamples())('閾値の掃引', () => {
  it('本体色閾値とバンド最小幅の組み合わせを評価する', { timeout: 600_000 }, async () => {
    const entries = loadManifest();

    // 画像の読み込みと ROI 化は 1 回だけ（掃引のたびにやると遅い）
    const rois: { entry: SampleEntry; roi: RoiImage }[] = [];
    for (const entry of entries) {
      const image = await loadImage(entry.file);
      const box = locateResistor(image);
      if (box === null) continue;
      rois.push({ entry, roi: rectify(image, box, { padding: ROI_PADDING, targetHeight: ROI_HEIGHT }) });
    }

    const lines: string[] = [`ROI 化できた画像: ${rois.length}/${entries.length}`, ''];
    lines.push('bodyΔE  minWidth  正解  デコード成功');

    let best = { bodyDeltaE: 0, minBandWidth: 0, correct: -1 };
    for (const bodyDeltaE of BODY_DELTA_E) {
      for (const minBandWidth of MIN_BAND_WIDTH) {
        let correct = 0;
        let decoded = 0;
        for (const { entry, roi } of rois) {
          const result = analyzeRoi(roi, {
            segment: { bodyDeltaE, minBandWidth },
            extent: { bodyDeltaE },
          });
          const ohms = result.reading?.ohms;
          if (ohms !== undefined && ohms !== null) decoded += 1;
          if (ohms !== undefined && ohms !== null && Math.abs(ohms - entry.ohms) / entry.ohms < 1e-6) {
            correct += 1;
          }
        }
        lines.push(
          `${String(bodyDeltaE).padStart(6)}  ${String(minBandWidth).padStart(8)}  ` +
            `${String(correct).padStart(4)}  ${String(decoded).padStart(12)}`,
        );
        if (correct > best.correct) best = { bodyDeltaE, minBandWidth, correct };
      }
    }

    lines.push(
      '',
      `最良: bodyΔE=${best.bodyDeltaE} minWidth=${best.minBandWidth} → ${best.correct}/${rois.length} (${((best.correct / rois.length) * 100).toFixed(0)}%)`,
    );
    writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');

    expect(best.correct).toBeGreaterThanOrEqual(0);
  });
});
