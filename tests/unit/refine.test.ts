import { describe, expect, it } from 'vitest';
import { refineBoxByBands } from '../../src/core/refine.js';
import type { OrientedBox } from '../../src/core/locate.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

type Rgb = readonly [number, number, number];

const BODY: Rgb = [205, 178, 132];
const BACKGROUND: Rgb = [250, 250, 250];
const BAND_COLORS: Rgb[] = [
  [150, 60, 40],
  [40, 40, 40],
  [190, 60, 50],
  [60, 90, 170],
  [190, 150, 40],
  [70, 130, 80],
];

interface SceneSpec {
  readonly width: number;
  readonly height: number;
  /** 本体の長軸方向の範囲 */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly thickness: number;
  /** バンドの本数。等間隔・等幅で並べる */
  readonly bands: number;
  readonly bandWidth: number;
}

/** 水平に置いた抵抗器を描く（バンドは等間隔）。 */
function drawResistor(spec: SceneSpec): RoiImage {
  const { width, height, bodyStart, bodyEnd, thickness, bands, bandWidth } = spec;
  const data = new Uint8ClampedArray(width * height * 4);
  const centerY = height / 2;

  const fill = (x0: number, x1: number, y0: number, y1: number, rgb: Rgb): void => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, Math.round(y1)); y += 1) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, Math.round(x1)); x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
      }
    }
  };

  fill(0, width, 0, height, BACKGROUND);
  fill(bodyStart, bodyEnd, centerY - thickness / 2, centerY + thickness / 2, BODY);

  // バンドは本体の中央 70% に等間隔で置く
  const span = (bodyEnd - bodyStart) * 0.7;
  const first = bodyStart + (bodyEnd - bodyStart) * 0.15;
  const pitch = bands > 1 ? span / bands : span;
  for (let index = 0; index < bands; index += 1) {
    const at = first + pitch * index;
    fill(
      at,
      at + bandWidth,
      centerY - thickness / 2,
      centerY + thickness / 2,
      BAND_COLORS[index % BAND_COLORS.length] as Rgb,
    );
  }

  for (let i = 0; i < width * height; i += 1) data[i * 4 + 3] = 255;
  return { width, height, data };
}

const SCENE: SceneSpec = {
  width: 400,
  height: 200,
  bodyStart: 80,
  bodyEnd: 320,
  thickness: 80,
  bands: 5,
  bandWidth: 12,
};

const TRUE_BOX: OrientedBox = {
  centerX: (SCENE.bodyStart + SCENE.bodyEnd) / 2,
  centerY: SCENE.height / 2,
  angleDeg: 0,
  length: SCENE.bodyEnd - SCENE.bodyStart,
  thickness: SCENE.thickness,
};

describe('refineBoxByBands', () => {
  it('本体の右半分しか捉えていない枠を、バンドの並びから広げる', () => {
    // Arrange: 正しい枠の右半分だけを覆う仮の枠
    const image = drawResistor(SCENE);
    const half: OrientedBox = {
      ...TRUE_BOX,
      centerX: TRUE_BOX.centerX + TRUE_BOX.length / 4,
      length: TRUE_BOX.length / 2,
    };

    // Act
    const refined = refineBoxByBands(half, image);

    // Assert: 本体の長さに近づき、中心も本体の中心へ寄る
    expect(refined.length).toBeGreaterThan(half.length * 1.5);
    expect(Math.abs(refined.centerX - TRUE_BOX.centerX)).toBeLessThan(
      Math.abs(half.centerX - TRUE_BOX.centerX),
    );
  });

  it('すでに正しい枠はほとんど動かさない', () => {
    // Arrange
    const image = drawResistor(SCENE);

    // Act
    const refined = refineBoxByBands(TRUE_BOX, image);

    // Assert
    expect(refined.length).toBeGreaterThan(TRUE_BOX.length * 0.85);
    expect(refined.length).toBeLessThan(TRUE_BOX.length * 1.2);
    expect(Math.abs(refined.centerX - TRUE_BOX.centerX)).toBeLessThan(TRUE_BOX.length * 0.1);
  });

  it('バンドが見つからない画像では枠を変えない', () => {
    // Arrange: 一様な背景だけ
    const data = new Uint8ClampedArray(400 * 200 * 4).fill(250);
    const image: RoiImage = { width: 400, height: 200, data };

    // Act
    const refined = refineBoxByBands(TRUE_BOX, image);

    // Assert
    expect(refined).toEqual(TRUE_BOX);
  });

  it('傾いた抵抗器でも長軸方向にだけ伸ばす', () => {
    // Arrange: 30 度傾けた同じ場面を、傾いた仮の枠で見る
    const image = drawResistor(SCENE);
    const tilted: OrientedBox = {
      ...TRUE_BOX,
      angleDeg: 0,
      centerX: TRUE_BOX.centerX + TRUE_BOX.length / 4,
      length: TRUE_BOX.length / 2,
    };

    // Act
    const refined = refineBoxByBands(tilted, image);

    // Assert: 太さと角度は変えない
    expect(refined.thickness).toBe(tilted.thickness);
    expect(refined.angleDeg).toBe(tilted.angleDeg);
  });
});
