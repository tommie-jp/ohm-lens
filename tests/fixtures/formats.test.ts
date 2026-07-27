import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sniffImageFormat } from '../../src/core/imageFormat.js';
import { analyzeRoi } from '../../src/core/pipeline.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

/**
 * 画像形式ごとの読み込み検証。
 *
 * 同じ絵を各形式で書き出し、判定・デコード・解析結果が一致することを見る。
 * HEVC 版の HEIC はこの環境では生成できない（libheif に x265 が無い）ため、
 * ここでは検証できない。実機の iPhone 写真での確認が必要。
 */

/** 4.7kΩ を模した縞模様の元画像。 */
async function sourcePng(): Promise<Buffer> {
  const width = 160;
  const height = 60;
  const pixels = Buffer.alloc(width * height * 3);
  const bands: [number, number, [number, number, number]][] = [
    [30, 45, [235, 210, 50]],
    [60, 75, [120, 70, 160]],
    [90, 105, [200, 30, 30]],
    [125, 140, [200, 160, 50]],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = bands.find(([start, end]) => x >= start && x < end);
      const [r, g, b] = band ? band[2] : [210, 180, 140];
      const offset = (y * width + x) * 3;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** この環境の sharp が書き出せる形式だけを対象にする。 */
const FORMATS = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'] as const;

/**
 * 可逆で書き出せる形式。色が 1 ビットも変わらないので、読み取り結果が
 * 元画像と完全に一致することを要求できる。
 *
 * WebP は sharp の既定がロス圧縮なので、明示的に lossless を指定する。
 */
const LOSSLESS: Partial<Record<(typeof FORMATS)[number], object>> = {
  png: {},
  tiff: {},
  webp: { lossless: true },
};

let directory: string;
const written = new Map<string, string>();

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ohmlens-formats-'));
  const png = await sourcePng();

  for (const format of FORMATS) {
    const buffer = await sharp(png)
      .toFormat(format, LOSSLESS[format] ?? {})
      .toBuffer();
    const path = join(directory, `sample.${format}`);
    writeFileSync(path, buffer);
    written.set(format, path);
  }
}, 120_000);

afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

async function loadRaw(path: string): Promise<RoiImage> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

describe('画像形式ごとの読み込み', () => {
  it.each(FORMATS)('%s を sharp がデコードできる', async (format) => {
    // Arrange
    const path = written.get(format) as string;

    // Act
    const image = await loadRaw(path);

    // Assert
    expect(image.width).toBe(160);
    expect(image.height).toBe(60);
  });

  it.each([
    ['jpeg', 'jpeg'],
    ['png', 'png'],
    ['webp', 'webp'],
    ['gif', 'gif'],
    ['tiff', 'tiff'],
    ['avif', 'avif'],
  ] as const)('%s のマジックバイトを %s と判定する', async (format, expected) => {
    // Arrange
    const buffer = await sharp(written.get(format) as string).toBuffer();

    // Act / Assert
    expect(sniffImageFormat(new Uint8Array(buffer.subarray(0, 32)))).toBe(expected);
  });

  it.each(['png', 'webp', 'tiff'] as const)(
    '可逆な %s では元画像と同じ抵抗値が読める',
    async (format) => {
      // Arrange
      const image = await loadRaw(written.get(format) as string);

      // Act
      const result = analyzeRoi(image);

      // Assert
      expect(result.bands.map((band) => band.color)).toEqual([
        'yellow',
        'violet',
        'red',
        'gold',
      ]);
      expect(result.reading?.ohms).toBeCloseTo(4700, 6);
    },
  );

  it.each(['jpeg', 'gif', 'avif'] as const)(
    '非可逆な %s でも解析が通り、バンドが検出される',
    async (format) => {
      // Arrange
      const image = await loadRaw(written.get(format) as string);

      // Act
      const result = analyzeRoi(image);

      // Assert: 圧縮の癖で本数は前後しうるので、検出できることだけを見る
      expect(result.bands.length).toBeGreaterThan(0);
    },
  );
});
