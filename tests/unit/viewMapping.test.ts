import { describe, expect, it } from 'vitest';
import { clientToIntrinsic, coverVisibleRect } from '../../src/debug/viewMapping.js';

describe('clientToIntrinsic', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 };
  const size = { width: 800, height: 400 };

  it('表示座標を内在解像度へ拡大して変換する', () => {
    // Act: 表示上の中央
    const point = clientToIntrinsic(rect, size, 110, 70);

    // Assert: 内在解像度でも中央
    expect(point).toEqual({ x: 400, y: 200 });
  });

  it('要素の外側は範囲内へクランプする', () => {
    expect(clientToIntrinsic(rect, size, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(clientToIntrinsic(rect, size, 500, 500)).toEqual({ x: 800, y: 400 });
  });

  it('表示サイズ 0 でもゼロ除算にならない', () => {
    const collapsed = { left: 0, top: 0, width: 0, height: 0 };
    expect(clientToIntrinsic(collapsed, size, 100, 100)).toEqual({ x: 0, y: 0 });
  });
});

describe('coverVisibleRect', () => {
  const frame = { width: 640, height: 480 };

  it('縦横比が同じなら全体が見える', () => {
    expect(coverVisibleRect(frame, { width: 320, height: 240 })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
  });

  it('縦長の画面では左右が均等に切れる', () => {
    // Act: 4:3 のフレームを 1:2 の画面いっぱいに出す
    const visible = coverVisibleRect(frame, { width: 360, height: 720 });

    // Assert: 高さは全部見え、幅は 480 * (360/720) = 240 に縮む
    expect(visible.height).toBe(480);
    expect(visible.width).toBeCloseTo(240);
    expect(visible.x).toBeCloseTo((640 - 240) / 2);
    expect(visible.y).toBe(0);
  });

  it('横長の画面では上下が均等に切れる', () => {
    // Act
    const visible = coverVisibleRect(frame, { width: 1280, height: 480 });

    // Assert: 幅は全部見え、高さは 640 * (480/1280) = 240 に縮む
    expect(visible.width).toBe(640);
    expect(visible.height).toBeCloseTo(240);
    expect(visible.y).toBeCloseTo((480 - 240) / 2);
  });

  it('表示サイズが取れないときはフレーム全体を可視とみなす', () => {
    expect(coverVisibleRect(frame, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
  });
});
