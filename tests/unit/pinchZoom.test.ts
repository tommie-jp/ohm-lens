import { describe, expect, it } from 'vitest';
import {
  pinchZoom,
  touchDistance,
  MAX_PINCH_ZOOM,
  MIN_PINCH_ZOOM,
} from '../../src/debug/pinchZoom.js';

describe('touchDistance', () => {
  it('2 点間の距離を返す', () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
  });

  it('同じ点なら 0', () => {
    expect(touchDistance({ clientX: 7, clientY: 7 }, { clientX: 7, clientY: 7 })).toBe(0);
  });
});

describe('pinchZoom', () => {
  it('指を広げた比率だけ倍率を上げる', () => {
    // Act: 100px の開きが 200px になった
    expect(pinchZoom(1, 100, 200)).toBe(2);
  });

  it('開始時の倍率を土台にする（続けてピンチできる）', () => {
    expect(pinchZoom(2, 100, 150)).toBe(3);
  });

  it('指を狭めれば倍率が下がる', () => {
    expect(pinchZoom(4, 200, 100)).toBe(2);
  });

  it('等倍より下には下げない', () => {
    expect(pinchZoom(1, 200, 50)).toBe(MIN_PINCH_ZOOM);
  });

  it('上限でクランプする', () => {
    expect(pinchZoom(4, 100, 1000)).toBe(MAX_PINCH_ZOOM);
  });

  it('上限は指定できる', () => {
    expect(pinchZoom(1, 100, 1000, 3)).toBe(3);
  });

  it('開始距離が 0 なら倍率を変えない（ゼロ除算にしない）', () => {
    expect(pinchZoom(2, 0, 100)).toBe(2);
  });
});
