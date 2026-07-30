import { describe, expect, it } from 'vitest';
import { clientToIntrinsic } from '../../src/debug/viewMapping.js';

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
