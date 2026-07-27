import { describe, expect, it } from 'vitest';
import { rectify } from '../../src/core/rectify.js';
import type { RoiImage } from '../../src/core/bands/profile.js';
import type { OrientedBox } from '../../src/core/locate.js';

type Rgb = readonly [number, number, number];

/** 単色で塗りつぶした画像。 */
function solid(width: number, height: number, rgb: Rgb): RoiImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function pixelAt(image: RoiImage, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset] as number, image.data[offset + 1] as number, image.data[offset + 2] as number];
}

/** 中心に、角度つきの縦縞（バンド）を描いた画像。 */
function stripedBar(angleDeg: number, stripe: Rgb, body: Rgb): RoiImage {
  const size = 201;
  const image = solid(size, size, [255, 255, 255]);
  const center = (size - 1) / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const along = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      if (Math.abs(along) > 40 || Math.abs(across) > 12) continue;
      // 長軸方向 |along| < 8 の帯だけ縞にする
      const rgb = Math.abs(along) < 8 ? stripe : body;
      const offset = (y * size + x) * 4;
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
    }
  }
  return image;
}

const BOX: OrientedBox = {
  centerX: 100,
  centerY: 100,
  angleDeg: 0,
  length: 80,
  thickness: 24,
};

describe('rectify', () => {
  it('指定した大きさの画像を返す', () => {
    // Arrange
    const image = solid(200, 200, [210, 180, 140]);

    // Act
    const roi = rectify(image, BOX);

    // Assert
    expect(roi.width).toBe(Math.round(BOX.length));
    expect(roi.height).toBe(Math.round(BOX.thickness));
    expect(roi.data.length).toBe(roi.width * roi.height * 4);
  });

  it('長軸が水平になるよう回転する', () => {
    // Arrange: 30 度傾いた縞
    const image = stripedBar(30, [200, 30, 30], [210, 180, 140]);
    const box: OrientedBox = { centerX: 100, centerY: 100, angleDeg: 30, length: 80, thickness: 24 };

    // Act
    const roi = rectify(image, box);

    // Assert: 補正後は中央列が縞の色、端の列が本体色になる
    const middle = pixelAt(roi, Math.floor(roi.width / 2), Math.floor(roi.height / 2));
    const edge = pixelAt(roi, 2, Math.floor(roi.height / 2));
    expect(middle[0]).toBeGreaterThan(150);
    expect(middle[1]).toBeLessThan(90);
    expect(edge[1]).toBeGreaterThan(140);
  });

  it('角度 0 のときは切り出しと等価', () => {
    // Arrange
    const image = stripedBar(0, [200, 30, 30], [210, 180, 140]);

    // Act
    const roi = rectify(image, BOX);

    // Assert
    const middle = pixelAt(roi, Math.floor(roi.width / 2), Math.floor(roi.height / 2));
    expect(middle[0]).toBeGreaterThan(150);
    expect(middle[1]).toBeLessThan(90);
  });

  it('パディング率で本体の外側も含められる', () => {
    // Arrange
    const image = solid(200, 200, [210, 180, 140]);

    // Act
    const tight = rectify(image, BOX);
    const padded = rectify(image, BOX, { padding: 0.25 });

    // Assert
    expect(padded.width).toBeGreaterThan(tight.width);
    expect(padded.height).toBeGreaterThan(tight.height);
  });

  it('出力の高さを指定できる（アスペクト比は保つ）', () => {
    // Arrange
    const image = solid(200, 200, [210, 180, 140]);

    // Act
    const roi = rectify(image, BOX, { targetHeight: 48 });

    // Assert
    expect(roi.height).toBe(48);
    expect(roi.width).toBe(Math.round((BOX.length / BOX.thickness) * 48));
  });

  it('画像の外にはみ出す領域は端の画素で埋める', () => {
    // Arrange: 端ぎりぎりに中心がある
    const image = solid(60, 60, [210, 180, 140]);
    const box: OrientedBox = { centerX: 2, centerY: 2, angleDeg: 0, length: 40, thickness: 20 };

    // Act
    const roi = rectify(image, box);

    // Assert: 例外を投げず、全画素が有効な値
    expect(roi.data.every((value, index) => (index % 4 === 3 ? value === 255 : value >= 0))).toBe(
      true,
    );
  });

  it('大きさが 0 のボックスでも 1x1 以上を返す', () => {
    const image = solid(60, 60, [210, 180, 140]);
    const roi = rectify(image, { centerX: 30, centerY: 30, angleDeg: 0, length: 0, thickness: 0 });

    expect(roi.width).toBeGreaterThanOrEqual(1);
    expect(roi.height).toBeGreaterThanOrEqual(1);
  });
});
