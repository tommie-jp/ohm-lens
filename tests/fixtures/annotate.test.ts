import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { analyzeRoi } from '../../src/core/pipeline.js';
import { locateResistor, type OrientedBox } from '../../src/core/locate.js';
import { rectify, type RectifyOptions } from '../../src/core/rectify.js';
import { bandCorners, labelAnchor } from '../../src/core/roiMapping.js';
import { BAND_COLOR_ABBR, bandColorCss } from '../../src/core/color/colors.js';
import { formatOhms } from '../../src/core/format.js';
import type { Band } from '../../src/types.js';
import { hasSamples, loadImage, loadManifest, loadPalette, type SampleEntry } from './loadSample.js';

/**
 * sample/ の全画像に検出結果を焼き込んで出力する（D3）。
 *
 * GUI で 1 枚ずつ見るのは遅い。39 枚を並べて眺めれば
 * 「検出（locate）が外れているのか」「バンド分割（runs）が細切れなのか」
 * 「分類（palette）が化けているのか」を一気に切り分けられる。
 *
 * 日本語フォントは環境依存なので、こちらは英字 3 文字を使う。
 */

const OUT_DIR = join(import.meta.dirname, '../../debug-out');
const ROI: RectifyOptions = { padding: 0.06, targetHeight: 40 };

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** 検出ボックス（パディングを含まない素の寸法）の四隅。 */
function boxCorners(box: OrientedBox): { x: number; y: number }[] {
  const rad = (box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return (
    [
      [-box.length / 2, -box.thickness / 2],
      [box.length / 2, -box.thickness / 2],
      [box.length / 2, box.thickness / 2],
      [-box.length / 2, box.thickness / 2],
    ] as const
  ).map(([along, across]) => ({
    x: box.centerX + along * cos - across * sin,
    y: box.centerY + along * sin + across * cos,
  }));
}

function polygonPoints(points: readonly { x: number; y: number }[]): string {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/** 焼き込み用の SVG を組み立てる。 */
function buildSvg(
  width: number,
  height: number,
  box: OrientedBox | null,
  bands: readonly Band[],
  caption: string,
): string {
  const parts: string[] = [];
  const fontPx = Math.max(11, Math.round((box?.thickness ?? 40) * 0.34));

  if (box !== null) {
    const lineWidth = Math.max(2, Math.round(box.thickness / 16));
    parts.push(
      `<polygon points="${polygonPoints(boxCorners(box))}" fill="none" ` +
        `stroke="#ff3b30" stroke-width="${lineWidth}" />`,
    );

    bands.forEach((band, index) => {
      parts.push(
        `<polygon points="${polygonPoints(bandCorners(box, ROI, band))}" ` +
          `fill="rgba(255,255,255,0.3)" stroke="${bandColorCss(band.color)}" stroke-width="2" />`,
      );

      const stagger = index % 2 === 0 ? 0 : fontPx * 1.3;
      const anchor = labelAnchor(box, ROI, band, box.thickness * 0.5 + stagger + fontPx);
      const label = BAND_COLOR_ABBR[band.color];
      const opacity = band.confidence < 0.35 ? '0.55' : '1';
      parts.push(
        `<circle cx="${(anchor.x - fontPx * 1.6).toFixed(1)}" cy="${anchor.y.toFixed(1)}" ` +
          `r="${(fontPx * 0.32).toFixed(1)}" fill="${bandColorCss(band.color)}" ` +
          `stroke="rgba(0,0,0,0.5)" stroke-width="1" opacity="${opacity}" />`,
        `<text x="${anchor.x.toFixed(1)}" y="${anchor.y.toFixed(1)}" ` +
          `font-family="sans-serif" font-size="${fontPx}" font-weight="700" ` +
          `text-anchor="middle" dominant-baseline="central" opacity="${opacity}" ` +
          `stroke="rgba(255,255,255,0.92)" stroke-width="${(fontPx * 0.24).toFixed(1)}" ` +
          `paint-order="stroke" fill="#111">${escapeXml(label)}</text>`,
      );
    });
  }

  parts.push(
    `<rect x="0" y="0" width="${width}" height="26" fill="rgba(0,0,0,0.62)" />`,
    `<text x="6" y="18" font-family="monospace" font-size="14" fill="#fff">` +
      `${escapeXml(caption)}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

async function annotate(entry: SampleEntry, palette: ReturnType<typeof loadPalette>): Promise<string> {
  const image = await loadImage(entry.file);
  const box = locateResistor(image);

  let bands: readonly Band[] = [];
  let caption: string;

  if (box === null) {
    caption = `${entry.file} | 期待 ${formatOhms(entry.ohms)} | 検出失敗`;
  } else {
    const roi = rectify(image, box, ROI);
    const result = analyzeRoi(roi, { segment: { palette } });
    bands = result.bands;
    const got = result.reading === null ? '読取不可' : formatOhms(result.reading.ohms);
    const aspect = (box.length / box.thickness).toFixed(2);
    caption =
      `${entry.file} | 期待 ${formatOhms(entry.ohms)} → ${got} | ` +
      `${box.angleDeg.toFixed(0)}° L${Math.round(box.length)} T${Math.round(box.thickness)} ` +
      `(比 ${aspect}) | ${bands.map((band) => BAND_COLOR_ABBR[band.color]).join(' ')}`;
  }

  const svg = buildSvg(image.width, image.height, box, bands, caption);
  const png = await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();

  const name = entry.file.replace(/\.[^.]+$/, '.annotated.jpg');
  writeFileSync(join(OUT_DIR, name), png);
  return caption;
}

describe.skipIf(!hasSamples())('検出結果の焼き込み出力', () => {
  it('sample/ 全件を debug-out/ に出力する', { timeout: 600_000 }, async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const entries = loadManifest();
    const palette = loadPalette();

    const captions: string[] = [];
    for (const entry of entries) {
      captions.push(await annotate(entry, palette));
    }

    writeFileSync(join(OUT_DIR, 'summary.txt'), captions.join('\n') + '\n', 'utf-8');
    expect(captions).toHaveLength(entries.length);
  });
});
