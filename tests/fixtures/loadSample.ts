import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { RoiImage } from '../../src/core/bands/profile.js';
import type { BandColor, LabColor } from '../../src/types.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../../src/core/color/palette.js';

/**
 * sample/ の写真をフィクスチャとして読み込む。
 *
 * sample/ は本リポジトリの**外**（親ディレクトリの作業用リポジトリ）にある。
 * 公開リポジトリだけをクローンした環境では存在しないので、呼び出し側は
 * {@link hasSamples} で存在を確認してスキップすること。
 */

const SAMPLE_DIR = join(import.meta.dirname, '../../../sample');

/** 解析前に縮小する長辺の画素数。元は 3000px 級で、そのままだと遅い。 */
const DECODE_MAX_SIZE = 800;

/** フィクスチャとして扱う拡張子。 */
export const SAMPLE_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif', '.tif', '.tiff',
] as const;

export interface SampleEntry {
  readonly file: string;
  readonly ohms: number;
  readonly tolerance: number | null;
  /** 実物のバンド列が判明している場合のみ */
  readonly bands: readonly string[] | null;
  readonly source: string;
}

export function hasSamples(): boolean {
  return existsSync(join(SAMPLE_DIR, 'MANIFEST.json'));
}

/** MANIFEST.json から期待値つきのエントリを読み出す。 */
export function loadManifest(): SampleEntry[] {
  const raw = readFileSync(join(SAMPLE_DIR, 'MANIFEST.json'), 'utf-8');
  const items = JSON.parse(raw) as {
    file: string;
    expected: { ohms: number; tolerance: number | null } | null;
    bands?: string[];
    source?: string;
  }[];

  return items
    .filter((item) => item.expected !== null && existsSync(join(SAMPLE_DIR, item.file)))
    .map((item) => ({
      file: item.file,
      ohms: (item.expected as { ohms: number }).ohms,
      tolerance: (item.expected as { tolerance: number | null }).tolerance,
      bands: item.bands ?? null,
      source: item.source ?? 'commons',
    }));
}

/**
 * 写真を RGBA の生ピクセルとして読み込む（長辺 800px に縮小）。
 *
 * sharp が対応する形式（JPEG / PNG / WebP / GIF / AVIF / HEIC / TIFF）を
 * そのまま扱える。EXIF の向きも反映する。
 */
export async function loadImage(file: string): Promise<RoiImage> {
  const { data, info } = await sharp(join(SAMPLE_DIR, file))
    .rotate() // EXIF の向きを反映
    .resize({ width: DECODE_MAX_SIZE, height: DECODE_MAX_SIZE, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/**
 * 学習済みパレットを読み込む。無ければ既定パレット。
 * 較正（calibrate.test.ts）が sample/palette.json に書き出したものを使う。
 */
export function loadPalette(): Palette {
  const path = join(SAMPLE_DIR, 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;

  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}
