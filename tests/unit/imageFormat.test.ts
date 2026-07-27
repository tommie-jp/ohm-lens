import { describe, expect, it } from 'vitest';
import {
  isBrowserDecodable,
  sniffImageFormat,
  SUPPORTED_ACCEPT,
} from '../../src/core/imageFormat.js';

/** 先頭バイト列から検査用のバッファを作る。 */
function header(...bytes: number[]): Uint8Array {
  const buffer = new Uint8Array(32);
  buffer.set(bytes);
  return buffer;
}

function ascii(text: string, offset = 0): number[] {
  return [...Array.from({ length: offset }, () => 0), ...[...text].map((c) => c.charCodeAt(0))];
}

describe('sniffImageFormat', () => {
  it('JPEG を判定する', () => {
    expect(sniffImageFormat(header(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
  });

  it('PNG を判定する', () => {
    expect(sniffImageFormat(header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
  });

  it.each(['GIF87a', 'GIF89a'])('%s を判定する', (signature) => {
    expect(sniffImageFormat(header(...ascii(signature)))).toBe('gif');
  });

  it('WebP を判定する（RIFF コンテナの中身まで見る）', () => {
    const bytes = header(...ascii('RIFF'));
    bytes.set(ascii('WEBP'), 8);
    expect(sniffImageFormat(bytes)).toBe('webp');
  });

  it('RIFF でも WEBP でなければ webp とは判定しない', () => {
    const bytes = header(...ascii('RIFF'));
    bytes.set(ascii('WAVE'), 8);
    expect(sniffImageFormat(bytes)).toBe('unknown');
  });

  it.each(['heic', 'heix', 'hevc', 'mif1', 'msf1'])(
    'ISO-BMFF ブランド %s を heic と判定する',
    (brand) => {
      const bytes = header(0, 0, 0, 0x18);
      bytes.set(ascii('ftyp'), 4);
      bytes.set(ascii(brand), 8);
      expect(sniffImageFormat(bytes)).toBe('heic');
    },
  );

  it.each(['avif', 'avis'])('ISO-BMFF ブランド %s を avif と判定する', (brand) => {
    const bytes = header(0, 0, 0, 0x18);
    bytes.set(ascii('ftyp'), 4);
    bytes.set(ascii(brand), 8);
    expect(sniffImageFormat(bytes)).toBe('avif');
  });

  it('BMP を判定する', () => {
    expect(sniffImageFormat(header(0x42, 0x4d))).toBe('bmp');
  });

  it.each([
    ['リトルエンディアン', [0x49, 0x49, 0x2a, 0x00]],
    ['ビッグエンディアン', [0x4d, 0x4d, 0x00, 0x2a]],
  ])('TIFF (%s) を判定する', (_name, bytes) => {
    expect(sniffImageFormat(header(...bytes))).toBe('tiff');
  });

  it('判別できないものは unknown', () => {
    expect(sniffImageFormat(header(0x00, 0x01, 0x02, 0x03))).toBe('unknown');
  });

  it('短すぎるバッファでも例外を投げない', () => {
    expect(sniffImageFormat(new Uint8Array([0xff]))).toBe('unknown');
    expect(sniffImageFormat(new Uint8Array(0))).toBe('unknown');
  });
});

describe('isBrowserDecodable', () => {
  it.each(['jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] as const)(
    '%s はブラウザが自前で解ける',
    (format) => {
      expect(isBrowserDecodable(format)).toBe(true);
    },
  );

  it.each(['heic', 'tiff', 'unknown'] as const)('%s は自前で解けない', (format) => {
    expect(isBrowserDecodable(format)).toBe(false);
  });
});

describe('SUPPORTED_ACCEPT', () => {
  it('主要な拡張子を含む', () => {
    for (const extension of ['.jpg', '.png', '.webp', '.gif', '.heic', '.avif']) {
      expect(SUPPORTED_ACCEPT).toContain(extension);
    }
  });
});
