import { describe, expect, it } from 'vitest';
import {
  bandCorners,
  bodyColumns,
  imageToRoi,
  labelAnchor,
  labelSide,
  roiGeometry,
  roiToImage,
} from '../../src/core/roiMapping.js';
import type { OrientedBox } from '../../src/core/locate.js';

const BOX: OrientedBox = {
  centerX: 200,
  centerY: 150,
  angleDeg: 0,
  length: 120,
  thickness: 40,
};

const TILTED: OrientedBox = { ...BOX, angleDeg: 30 };

describe('roiGeometry', () => {
  it('パディングなし・拡縮なしなら ROI の大きさは箱と同じ', () => {
    const geometry = roiGeometry(BOX, {});

    expect(geometry.width).toBe(120);
    expect(geometry.height).toBe(40);
    expect(geometry.scale).toBe(1);
  });

  it('targetHeight を指定すると縦がその値になる', () => {
    const geometry = roiGeometry(BOX, { targetHeight: 40 });

    expect(geometry.height).toBe(40);
    expect(geometry.width).toBe(120);
  });

  it('パディングを入れると外側に広がる', () => {
    const geometry = roiGeometry(BOX, { padding: 0.25 });

    expect(geometry.width).toBeGreaterThan(120);
    expect(geometry.height).toBeGreaterThan(40);
  });

  it('rectify と同じ大きさになる（式の二重管理を避けるための確認）', async () => {
    // Arrange: 実際に rectify した結果と突き合わせる
    const { rectify } = await import('../../src/core/rectify.js');
    const image = {
      width: 400,
      height: 300,
      data: new Uint8ClampedArray(400 * 300 * 4),
    };
    const options = { padding: 0.06, targetHeight: 40 };

    // Act
    const roi = rectify(image, TILTED, options);
    const geometry = roiGeometry(TILTED, options);

    // Assert
    expect(geometry.width).toBe(roi.width);
    expect(geometry.height).toBe(roi.height);
  });
});

describe('roiToImage / imageToRoi — 往復', () => {
  it.each([
    ['角度 0・素のまま', BOX, {}],
    ['角度 30・素のまま', TILTED, {}],
    ['角度 -25・パディングあり', { ...BOX, angleDeg: -25 }, { padding: 0.1 }],
    ['角度 30・拡縮あり', TILTED, { targetHeight: 80 }],
    ['角度 45・パディング + 拡縮', { ...BOX, angleDeg: 45 }, { padding: 0.06, targetHeight: 40 }],
  ] as [string, OrientedBox, { padding?: number; targetHeight?: number }][])(
    '%s で ROI → 元画像 → ROI が元に戻る',
    (_name, box, options) => {
      // Arrange
      const geometry = roiGeometry(box, options);
      const points = [
        { x: 0, y: 0 },
        { x: geometry.width / 2, y: geometry.height / 2 },
        { x: geometry.width - 1, y: geometry.height - 1 },
        { x: 3, y: geometry.height - 2 },
      ];

      for (const point of points) {
        // Act
        const image = roiToImage(box, options, point.x, point.y);
        const back = imageToRoi(box, options, image.x, image.y);

        // Assert: 誤差 1px 未満
        expect(back.x).toBeCloseTo(point.x, 6);
        expect(back.y).toBeCloseTo(point.y, 6);
      }
    },
  );

  it('ROI の中心は箱の中心に写る', () => {
    // Arrange
    const geometry = roiGeometry(TILTED, { padding: 0.06, targetHeight: 40 });

    // Act
    const center = roiToImage(
      TILTED,
      { padding: 0.06, targetHeight: 40 },
      geometry.width / 2,
      geometry.height / 2,
    );

    // Assert
    expect(center.x).toBeCloseTo(TILTED.centerX, 6);
    expect(center.y).toBeCloseTo(TILTED.centerY, 6);
  });

  it('角度 0 のとき ROI の X 方向は元画像の X 方向', () => {
    // Arrange / Act
    const left = roiToImage(BOX, {}, 0, BOX.thickness / 2);
    const right = roiToImage(BOX, {}, BOX.length, BOX.thickness / 2);

    // Assert
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(right.x).toBeGreaterThan(left.x);
  });

  it('角度 90 のとき ROI の X 方向は元画像の Y 方向', () => {
    // Arrange
    const box: OrientedBox = { ...BOX, angleDeg: 90 };

    // Act
    const start = roiToImage(box, {}, 0, box.thickness / 2);
    const end = roiToImage(box, {}, box.length, box.thickness / 2);

    // Assert
    expect(start.x).toBeCloseTo(end.x, 6);
    expect(end.y).toBeGreaterThan(start.y);
  });
});

describe('bandCorners', () => {
  it('バンド範囲の四隅を元画像座標で返す', () => {
    // Arrange
    const band = { start: 10, end: 30 };

    // Act
    const corners = bandCorners(BOX, {}, band);

    // Assert
    expect(corners).toHaveLength(4);
    // 角度 0 なので X は帯の範囲、Y は箱の上下に収まる
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(BOX.centerX - BOX.length / 2 - 1);
      expect(corner.x).toBeLessThanOrEqual(BOX.centerX + BOX.length / 2 + 1);
    }
  });

  it('傾いた箱では四隅も傾く', () => {
    // Arrange / Act
    const corners = bandCorners(TILTED, {}, { start: 10, end: 30 });

    // Assert: 上辺の 2 点は Y が異なる（水平ではない）
    expect(Math.abs((corners[0] as { y: number }).y - (corners[1] as { y: number }).y)).toBeGreaterThan(1);
  });

  it('順序は左上→右上→右下→左下（多角形として閉じる）', () => {
    // Arrange / Act
    const corners = bandCorners(BOX, {}, { start: 10, end: 30 });

    // Assert: 角度 0 なら上辺 2 点の Y が小さい
    const ys = corners.map((corner) => corner.y);
    expect((ys[0] as number)).toBeLessThan(ys[3] as number);
    expect((ys[1] as number)).toBeLessThan(ys[2] as number);
  });
});

describe('labelAnchor', () => {
  it('バンド中心から短軸の外側にずれた位置を返す', () => {
    // Arrange / Act
    const anchor = labelAnchor(BOX, {}, { start: 10, end: 30 }, 20);

    // Assert: 角度 0 なので上方向（Y が小さい側）へ出る
    expect(anchor.y).toBeLessThan(BOX.centerY);
    expect(anchor.x).toBeCloseTo(roiToImage(BOX, {}, 20, 0).x, 6);
  });

  it('オフセットを大きくするとさらに離れる', () => {
    const near = labelAnchor(BOX, {}, { start: 10, end: 30 }, 10);
    const far = labelAnchor(BOX, {}, { start: 10, end: 30 }, 40);

    expect(far.y).toBeLessThan(near.y);
  });

  it('傾いた箱では法線方向にずれる（基準は箱の縁）', () => {
    // Arrange / Act
    const anchor = labelAnchor(TILTED, {}, { start: 10, end: 30 }, 30);
    // 縁（ROI の y=0）が基準。中心線ではない
    const onEdge = roiToImage(TILTED, {}, 20, 0);

    // Assert: 法線方向にちょうど offset ぶん離れている
    expect(Math.hypot(anchor.x - onEdge.x, anchor.y - onEdge.y)).toBeCloseTo(30, 6);
  });
});

describe('bodyColumns', () => {
  it('パディングなしなら ROI 全体が本体', () => {
    // Arrange / Act
    const columns = bodyColumns(BOX, {});

    // Assert
    expect(columns.start).toBe(0);
    expect(columns.end).toBe(120);
  });

  it('パディングぶんだけ内側に入った範囲を返す', () => {
    // Arrange: padding 0.25 → ROI 幅は 120 * 1.5 = 180、本体は中央の 120
    // Act
    const columns = bodyColumns(BOX, { padding: 0.25 });

    // Assert
    expect(columns.start).toBeCloseTo(30, 0);
    expect(columns.end).toBeCloseTo(150, 0);
  });

  it('targetHeight で拡縮しても ROI 座標として整合する', () => {
    // Arrange
    const options = { padding: 0.25, targetHeight: 40 };
    const geometry = roiGeometry(BOX, options);

    // Act
    const columns = bodyColumns(BOX, options);

    // Assert: 本体は ROI の中央 2/3（1 / 1.5）を占める
    expect(columns.start / geometry.width).toBeCloseTo(1 / 6, 2);
    expect(columns.end / geometry.width).toBeCloseTo(5 / 6, 2);
  });

  it('余白を指定すると本体の外側へ広がる（バンドは肩に載るため）', () => {
    // Arrange / Act
    const columns = bodyColumns(BOX, { padding: 0.25 }, 0.1);

    // Assert: 本体長 120 の 10% ずつ外へ
    expect(columns.start).toBeCloseTo(18, 0);
    expect(columns.end).toBeCloseTo(162, 0);
  });

  it('余白を広げても ROI の外には出ない', () => {
    // Arrange / Act
    const columns = bodyColumns(BOX, { padding: 0.05 }, 0.5);
    const geometry = roiGeometry(BOX, { padding: 0.05 });

    // Assert
    expect(columns.start).toBe(0);
    expect(columns.end).toBe(geometry.width);
  });
});

describe('labelSide / labelAnchor — 注釈を出す向き', () => {
  it('水平な抵抗器では下側', () => {
    // Arrange / Act
    const side = labelSide(BOX);
    const anchor = labelAnchor(BOX, {}, { start: 10, end: 30 }, 20, side);

    // Assert
    expect(anchor.y).toBeGreaterThan(BOX.centerY);
  });

  it('垂直な抵抗器では右側', () => {
    // Arrange: 長軸が下向き（90 度）
    const vertical: OrientedBox = { ...BOX, angleDeg: 90 };

    // Act
    const anchor = labelAnchor(vertical, {}, { start: 10, end: 30 }, 20, labelSide(vertical));

    // Assert
    expect(anchor.x).toBeGreaterThan(vertical.centerX);
  });

  it('長軸が上向き（-90 度）でも右側', () => {
    const vertical: OrientedBox = { ...BOX, angleDeg: -90 };

    const anchor = labelAnchor(vertical, {}, { start: 10, end: 30 }, 20, labelSide(vertical));

    expect(anchor.x).toBeGreaterThan(vertical.centerX);
  });

  it('上下逆さま（180 度）でも下側', () => {
    const upsideDown: OrientedBox = { ...BOX, angleDeg: 180 };

    const anchor = labelAnchor(upsideDown, {}, { start: 10, end: 30 }, 20, labelSide(upsideDown));

    expect(anchor.y).toBeGreaterThan(upsideDown.centerY);
  });

  it('オフセットを大きくするとさらに離れる', () => {
    const side = labelSide(BOX);
    const near = labelAnchor(BOX, {}, { start: 10, end: 30 }, 10, side);
    const far = labelAnchor(BOX, {}, { start: 10, end: 30 }, 40, side);

    expect(far.y).toBeGreaterThan(near.y);
  });
});
