import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractProfile } from '../../src/core/bands/profile.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import { classifyBandColor, isBodyColor, rankBandColors } from '../../src/core/bands/classify.js';
import { buildBodyAnchorAdaptation } from '../../src/core/color/anchor.js';
import { adaptToAnchor } from '../../src/core/color/whiteBalance.js';
import { deltaE2000 } from '../../src/core/color/colorSpace.js';
import { BODY_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import { hasSamples, loadImage } from './loadSample.js';

/** 1 枚の写真について、列ごとの分類過程をダンプする調査用テスト。 */

const TARGETS = ['08-47ohm.jpg', '11-220ohm-5pct.jpg', '01-1ohm-1pct-metalfilm-blue.jpg'];
const REPORT_PATH = join(import.meta.dirname, '../../diagnose-report.txt');

describe.skipIf(!hasSamples())('診断ダンプ', () => {
  it('列ごとの分類過程を書き出す', { timeout: 120_000 }, async () => {
    const lines: string[] = [];

    for (const file of TARGETS) {
      const image = await loadImage(file);
      const box = locateResistor(image);
      if (box === null) {
        lines.push(`${file}: 検出失敗`, '');
        continue;
      }

      const roi = rectify(image, box, { padding: 0.06, targetHeight: 40 });
      const raw = extractProfile(roi);
      const { adaptation, anchor } = buildBodyAnchorAdaptation(raw);
      const profile = raw.map((s) => ({ x: s.x, lab: adaptToAnchor(s.lab, adaptation) }));

      lines.push(
        `=== ${file} ===`,
        `ROI ${roi.width}x${roi.height}  角度 ${box.angleDeg.toFixed(1)}度`,
        `アンカー(補正前) L*${anchor?.l.toFixed(1)} a*${anchor?.a.toFixed(1)} b*${anchor?.b.toFixed(1)}`,
        `beige との ΔE: ${anchor ? deltaE2000(anchor, BODY_REFERENCE_COLORS.beige).toFixed(1) : '-'}`,
        `lightblue との ΔE: ${anchor ? deltaE2000(anchor, BODY_REFERENCE_COLORS.lightblue).toFixed(1) : '-'}`,
        '  x   L*    a*    b*   body?  分類(ΔE)         次点',
      );

      for (const sample of profile) {
        const body = isBodyColor(sample.lab);
        const result = classifyBandColor(sample.lab);
        const ranked = rankBandColors(sample.lab, 2);
        lines.push(
          `${String(sample.x).padStart(3)} ${sample.lab.l.toFixed(1).padStart(5)} ` +
            `${sample.lab.a.toFixed(1).padStart(5)} ${sample.lab.b.toFixed(1).padStart(5)} ` +
            `${body ? ' 本体 ' : '  -  '} ` +
            `${result.color.padEnd(7)}(${result.deltaE.toFixed(1).padStart(4)})  ` +
            `${ranked[1]?.color ?? ''}(${ranked[1]?.deltaE.toFixed(1) ?? ''})`,
        );
      }
      lines.push('');
    }

    writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');
    expect(lines.length).toBeGreaterThan(0);
  });
});
