import { describe, expect, it } from 'vitest';
import { shrinkBoxToBody } from '../../src/core/shrink.js';
import type { OrientedBox } from '../../src/core/locate.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

/**
 * ガイド枠を本体へ絞り込む。
 *
 * ガイド枠は利用者が合わせる目印なので、本体より必ず大きめに写る。
 * 枠をそのまま「検出した本体」として解析条件に渡すと、背景をバンドとして
 * 拾い、`rectify` の正規化で長軸方向の分解能まで落ちる。
 */

type Rgb = readonly [number, number, number];

/** 緑の基板。青いボディとは a\*b\* で十分離れている。 */
const BOARD: Rgb = [40, 90, 60];
const BODY: Rgb = [70, 110, 175];
const BAND_DARK: Rgb = [30, 28, 30];
const BAND_RED: Rgb = [170, 55, 45];

interface SceneSpec {
  readonly width: number;
  readonly height: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly thickness: number;
  readonly body?: Rgb;
  readonly background?: Rgb;
  /** バンドを置く位置（本体の左端からの距離）と色 */
  readonly bands?: readonly (readonly [number, Rgb])[];
}

const BAND_WIDTH = 8;

/** 画像の中央に水平に置いた抵抗器を描く。 */
function drawScene(spec: SceneSpec): RoiImage {
  const { width, height, bodyStart, bodyEnd, thickness } = spec;
  const background = spec.background ?? BOARD;
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
        data[offset + 3] = 255;
      }
    }
  };

  fill(0, width, 0, height, background);
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

  return { width, height, data };
}

/** 本体 x=150..250（長さ 100）・太さ 30 の場面。バンドは 4 本。 */
function standardScene(): RoiImage {
  return drawScene({
    width: 400,
    height: 300,
    bodyStart: 150,
    bodyEnd: 250,
    thickness: 30,
    bands: [
      [10, BAND_DARK],
      [30, BAND_RED],
      [50, BAND_DARK],
      [75, BAND_RED],
    ],
  });
}

function guideBoxOf(length: number, thickness: number): OrientedBox {
  return { centerX: 200, centerY: 150, angleDeg: 0, length, thickness };
}

describe('shrinkBoxToBody', () => {
  it('本体より太い枠は、本体の太さまで縮む', () => {
    // Arrange: 太さだけ 2 倍に外した枠
    const image = standardScene();
    const guide = guideBoxOf(100, 60);

    // Act
    const fitted = shrinkBoxToBody(guide, image);

    // Assert
    expect(fitted.thickness).toBeGreaterThan(24);
    expect(fitted.thickness).toBeLessThan(38);
  });

  it('本体より長い枠は、バンドを跨いで本体の長さまで縮む', () => {
    // Arrange: 長さだけ 1.6 倍に外した枠
    const image = standardScene();
    const guide = guideBoxOf(160, 30);

    // Act
    const fitted = shrinkBoxToBody(guide, image);

    // Assert
    expect(fitted.length).toBeGreaterThan(85);
    expect(fitted.length).toBeLessThan(120);
  });

  it('長軸・短軸ともに外した枠を、両方まとめて絞り込む', () => {
    // Arrange
    const image = standardScene();
    const guide = guideBoxOf(160, 60);

    // Act
    const fitted = shrinkBoxToBody(guide, image);

    // Assert
    expect(fitted.length).toBeGreaterThan(85);
    expect(fitted.length).toBeLessThan(120);
    expect(fitted.thickness).toBeGreaterThan(24);
    expect(fitted.thickness).toBeLessThan(38);
    // 中心と角度は動かさない（利用者が合わせた軸を信じる）。
    // ROI は元画像より粗いので、中心の一致は 1 ROI 画素ぶんまで許す
    expect(Math.abs(fitted.centerX - 200)).toBeLessThan(2);
    expect(fitted.angleDeg).toBe(0);
  });

  it('枠を本体より大きくはしない', () => {
    // Arrange: すでに本体より小さい枠
    const image = standardScene();
    const guide = guideBoxOf(60, 20);

    // Act
    const fitted = shrinkBoxToBody(guide, image);

    // Assert
    expect(fitted.length).toBeLessThanOrEqual(60);
    expect(fitted.thickness).toBeLessThanOrEqual(20);
  });

  it('本体と背景の色みが変わらない場面では、枠に触らない', () => {
    // Arrange: 本体と背景が同じ色。縮める手がかりが無い
    const image = drawScene({
      width: 400,
      height: 300,
      bodyStart: 150,
      bodyEnd: 250,
      thickness: 30,
      body: BOARD,
    });
    const guide = guideBoxOf(160, 60);

    // Act
    const fitted = shrinkBoxToBody(guide, image);

    // Assert
    expect(fitted).toEqual(guide);
  });

  it('太さを縮めても、短軸の中心は本体の軸に載ったまま', () => {
    // Arrange: 本体は画像の中央（y=150）にあり、枠だけが上下に余っている
    const image = standardScene();
    const guide = guideBoxOf(100, 60);

    // Act
    const fitted = shrinkBoxToBody(guide, image);

    // Assert: 縮めた枠が片側に寄っていないこと（1 ROI 画素ぶんまで許す）
    expect(Math.abs(fitted.centerY - 150)).toBeLessThan(2);
  });
});
