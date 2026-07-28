import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rankBandColors } from '../../src/core/bands/classify.js';
import { deltaE2000 } from '../../src/core/color/colorSpace.js';
import { BODY_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import { captionFor, readResistorImage } from '../../src/annotate/read.js';
import type { LabColor } from '../../src/types.js';
import { hasSamples, loadImage, loadManifest, loadPalette } from './loadSample.js';

/**
 * 読み取りが外れた写真について、**ラン単位**の分類過程をダンプする調査用テスト。
 *
 * 以前は列（プロファイルの x 座標）ごとに `classifyBandColor` /
 * `isBodyColor` をダンプしていたが、**本番の主経路は「ラン →
 * `rankBandColors`（`value/jointDecode.ts` の `candidatesFor`）」**であり、
 * 列ごとの分類は本番が一度も計算しない量だった。見ても実際の誤読の原因に
 * つながらないので、ラン単位に作り替えている。
 *
 * 解析条件は `annotate/read.ts` 経由で `core/settings.ts` に従う。
 */

/** 調査対象。値が外れている・保留になっている写真を選ぶ。 */
const TARGETS = [
  '05-7.5ohm-1pct-metalfilm-blue.jpg', // 値も色も正解なのに確信度 0.31 で保留
  '23-3.9kohm-1pct-metalfilm-blue.jpg', // 同上（0.34）
  '38-10Mohm.jpg', // 唯一の誤答
  '01-1ohm-1pct-metalfilm-blue.jpg', // silver のランが出ない
  '39-10Mohm-1pct-metalfilm-blue.jpg', // 本数は合うが色が違う
];

const REPORT_PATH = join(import.meta.dirname, '../../diagnose-report.txt');

/** Lab を LCh に直す。無彩色（C≈0）は色相を持たない。 */
function toLch(lab: LabColor): { c: number; h: number | null } {
  const c = Math.hypot(lab.a, lab.b);
  return { c, h: c < 1 ? null : ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360 };
}

describe.skipIf(!hasSamples())('診断ダンプ', () => {
  it('ラン単位の分類過程を書き出す', { timeout: 300_000 }, async () => {
    const palette = loadPalette();
    const expectedByFile = new Map(loadManifest().map((entry) => [entry.file, entry]));
    const lines: string[] = ['解析条件: core/settings.ts（doDetect.sh と同一）', ''];

    for (const file of TARGETS) {
      const entry = expectedByFile.get(file);
      const image = await loadImage(file);
      const read = readResistorImage(image, {
        palette,
        ...(entry === undefined ? {} : { expectedOhms: entry.ohms }),
      });

      lines.push(`=== ${file} ===`);
      lines.push(`  ${captionFor(read, file, entry?.ohms)}`);

      if (!read.located || read.analysis === null) {
        lines.push('  検出失敗', '');
        continue;
      }

      const { analysis } = read;
      const anchor = analysis.anchor;
      lines.push(
        `  ROI ${read.roi?.width}x${read.roi?.height}  角度 ${read.box?.angleDeg.toFixed(1)}度`,
        anchor === null
          ? '  アンカー: なし（色順応補正なし）'
          : `  アンカー(補正前) L*${anchor.l.toFixed(1)} a*${anchor.a.toFixed(1)} b*${anchor.b.toFixed(1)}` +
            `  beige ΔE ${deltaE2000(anchor, BODY_REFERENCE_COLORS.beige).toFixed(1)}` +
            `  lightblue ΔE ${deltaE2000(anchor, BODY_REFERENCE_COLORS.lightblue).toFixed(1)}`,
        entry?.bands ? `  正解バンド列: ${entry.bands.join(' ')}` : '  正解バンド列: 未確定',
        '',
        '   #  範囲      幅   L*    a*    b*    C*     h   上位候補(ΔE)',
      );

      analysis.runs.forEach((run, index) => {
        const { c, h } = toLch(run.lab);
        const ranked = rankBandColors(run.lab, 3, palette)
          .map((candidate) => `${candidate.color}(${candidate.deltaE.toFixed(1)})`)
          .join(' ');
        lines.push(
          `  ${String(index).padStart(2)}  ` +
            `${String(run.start).padStart(3)}..${String(run.end).padEnd(3)} ` +
            `${String(run.end - run.start).padStart(3)}  ` +
            `${run.lab.l.toFixed(1).padStart(5)} ${run.lab.a.toFixed(1).padStart(5)} ` +
            `${run.lab.b.toFixed(1).padStart(5)} ${c.toFixed(1).padStart(5)} ` +
            `${(h === null ? '  -' : h.toFixed(0)).padStart(5)}   ${ranked}`,
        );
      });

      const joint = read.joint;
      lines.push(
        '',
        joint === null
          ? '  役割つきの解釈: なし（バンドが足りない）'
          : `  採用: ${joint.usedRuns.map((used) => `#${used.runIndex}=${used.color}${used.roleText}`).join(' ')}` +
            (joint.droppedRuns.length > 0 ? `  / 除外: ${joint.droppedRuns.map((i) => `#${i}`).join(' ')}` : ''),
        '',
      );
    }

    writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');
    expect(lines.length).toBeGreaterThan(0);
  });
});
