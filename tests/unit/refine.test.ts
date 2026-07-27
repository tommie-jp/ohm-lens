import { describe, expect, it } from 'vitest';
import { refineBoxExtent } from '../../src/core/refine.js';
import type { OrientedBox } from '../../src/core/locate.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

type Rgb = readonly [number, number, number];

const CARPET: Rgb = [70, 58, 48];
const BODY: Rgb = [170, 70, 60];
const BAND_DARK: Rgb = [35, 30, 28];
const BAND_LIGHT: Rgb = [215, 212, 205];
const LEAD: Rgb = [150, 150, 152];

interface SceneSpec {
  readonly width: number;
  readonly height: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly thickness: number;
  /** 本体色（既定は赤いボディ） */
  readonly body?: Rgb;
  /** 背景色（既定は暗いカーペット） */
  readonly background?: Rgb;
  /** バンドを置く位置（本体の左端からの距離）と色 */
  readonly bands?: readonly (readonly [number, Rgb])[];
  /** 本体の外に伸びるリード線を描くか */
  readonly leads?: boolean;
}

const BAND_WIDTH = 10;

/** 水平に置いた抵抗器を描く。 */
function drawScene(spec: SceneSpec): RoiImage {
  const { width, height, bodyStart, bodyEnd, thickness } = spec;
  const background = spec.background ?? CARPET;
  const body = spec.body ?? BODY;
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

  fill(0, width, 0, height, background);
  if (spec.leads === true) {
    fill(0, width, centerY - thickness * 0.12, centerY + thickness * 0.12, LEAD);
  }
  fill(bodyStart, bodyEnd, centerY - thickness / 2, centerY + thickness / 2, body);
  for (const [at, rgb] of spec.bands ?? []) {
    fill(
      bodyStart + at,
      bodyStart + at + BAND_WIDTH,
      centerY - thickness / 2,
      centerY + thickness / 2,
      rgb,
    );
  }

  for (let i = 0; i < width * height; i += 1) data[i * 4 + 3] = 255;
  return { width, height, data };
}

const SCENE: SceneSpec = {
  width: 480,
  height: 220,
  bodyStart: 100,
  bodyEnd: 380,
  thickness: 80,
  bands: [
    [30, BAND_DARK],
    [80, BAND_LIGHT],
    [130, BAND_DARK],
    [180, BAND_LIGHT],
    [230, BAND_DARK],
  ],
};

const TRUE_BOX: OrientedBox = {
  centerX: (SCENE.bodyStart + SCENE.bodyEnd) / 2,
  centerY: SCENE.height / 2,
  angleDeg: 0,
  length: SCENE.bodyEnd - SCENE.bodyStart,
  thickness: SCENE.thickness,
};

/** 本体の右側だけを覆う仮の枠。 */
const RIGHT_HALF: OrientedBox = {
  ...TRUE_BOX,
  centerX: TRUE_BOX.centerX + TRUE_BOX.length / 4,
  length: TRUE_BOX.length / 2,
};

describe('refineBoxExtent', () => {
  it('本体の右半分しか捉えていない枠を、本体色をたどって左へ伸ばす', () => {
    // Arrange
    const image = drawScene(SCENE);

    // Act
    const refined = refineBoxExtent(RIGHT_HALF, image);

    // Assert: 本体の長さに近づき、中心も本体の中心へ寄る
    expect(refined.length).toBeGreaterThan(TRUE_BOX.length * 0.8);
    expect(Math.abs(refined.centerX - TRUE_BOX.centerX)).toBeLessThan(TRUE_BOX.length * 0.15);
  });

  it('バンド（短い別色）は跨いで進む', () => {
    // Arrange: バンドを 5 本置いた場面で、左端のバンドより外まで伸びること
    const image = drawScene(SCENE);

    // Act
    const refined = refineBoxExtent(RIGHT_HALF, image);

    // Assert: 最初のバンド（本体左端 + 30）より左まで到達している
    const left = refined.centerX - refined.length / 2;
    expect(left).toBeLessThan(SCENE.bodyStart + 30);
  });

  it('リード線（長く続く別色）で止まる', () => {
    // Arrange: 本体の外へリード線が伸びている
    const image = drawScene({ ...SCENE, leads: true });

    // Act
    const refined = refineBoxExtent(RIGHT_HALF, image);

    // Assert: リード線まで飲み込まない
    expect(refined.length).toBeLessThan(TRUE_BOX.length * 1.25);
  });

  it('本体と背景の色が近いときは伸ばさない', () => {
    // Arrange: 背景も本体もほぼ同じベージュ（色で追えない）
    const image = drawScene({
      ...SCENE,
      background: [200, 176, 140],
      body: [205, 180, 144],
      bands: [],
    });

    // Act
    const refined = refineBoxExtent(RIGHT_HALF, image);

    // Assert
    expect(refined).toEqual(RIGHT_HALF);
  });

  it('すでに正しい枠はほとんど動かさない', () => {
    // Arrange
    const image = drawScene(SCENE);

    // Act
    const refined = refineBoxExtent(TRUE_BOX, image);

    // Assert
    expect(refined.length).toBeGreaterThan(TRUE_BOX.length * 0.9);
    expect(refined.length).toBeLessThan(TRUE_BOX.length * 1.15);
  });

  it('太さと角度は変えない', () => {
    // Arrange
    const image = drawScene(SCENE);

    // Act
    const refined = refineBoxExtent(RIGHT_HALF, image);

    // Assert
    expect(refined.thickness).toBe(RIGHT_HALF.thickness);
    expect(refined.angleDeg).toBe(RIGHT_HALF.angleDeg);
  });

  it('伸ばした結果がカラーコードとして成立しないなら元の枠を返す', () => {
    // Arrange: バンドが 1 本もない棒。伸ばしてもカラーコードにならない
    const image = drawScene({ ...SCENE, bands: [] });

    // Act
    const refined = refineBoxExtent(RIGHT_HALF, image);

    // Assert
    expect(refined).toEqual(RIGHT_HALF);
  });
});
