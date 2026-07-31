import { describe, expect, it } from 'vitest';
import type { RoiImage } from '../../src/core/bands/profile.js';
import { toRoiImage, toTransferImage } from '../../src/debug/analysis/protocol.js';

/** 2×1 の RGBA 画像。 */
function tinyImage(): RoiImage {
  return { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) };
}

describe('toTransferImage / toRoiImage', () => {
  it('往復しても画素と寸法が変わらない', () => {
    // Arrange
    const image = tinyImage();

    // Act
    const roundTripped = toRoiImage(toTransferImage(image));

    // Assert
    expect(roundTripped.width).toBe(2);
    expect(roundTripped.height).toBe(1);
    expect([...roundTripped.data]).toEqual([...image.data]);
  });

  it('バッファ全体を指す view ならコピーせずに同じバッファを使う', () => {
    // Arrange: getImageData の結果はバッファ全体を指す（これが通常経路）
    const image = tinyImage();

    // Act
    const transfer = toTransferImage(image);

    // Assert: ゼロコピー（transfer リストに載せられる）
    expect(transfer.pixels).toBe(image.data.buffer);
  });

  it('バッファの一部を指す view は該当範囲だけを切り出す', () => {
    // Arrange: 先頭 4 バイトを別データが占める共有バッファ
    const backing = new ArrayBuffer(12);
    const data = new Uint8ClampedArray(backing, 4, 8);
    data.set([1, 2, 3, 255, 4, 5, 6, 255]);

    // Act
    const roundTripped = toRoiImage(toTransferImage({ width: 2, height: 1, data }));

    // Assert
    expect([...roundTripped.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });
});

