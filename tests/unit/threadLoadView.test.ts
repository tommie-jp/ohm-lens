import { describe, expect, it } from 'vitest';
import { formatLoad, scaleFor, type LoadSeries } from '../../src/debug/threadLoadView.js';

function seriesOf(...history: number[]): LoadSeries {
  return { history, color: '#000', fill: '#000' };
}

describe('scaleFor', () => {
  it('小さい負荷では上限を絞る（底に貼り付いて読めなくなるのを防ぐ）', () => {
    expect(scaleFor([seriesOf(0.01, 0.14)])).toBe(0.25);
  });

  it('段を超えたら 1 つ上へ上げる', () => {
    expect(scaleFor([seriesOf(0.26)])).toBe(0.5);
    expect(scaleFor([seriesOf(0.51)])).toBe(1);
  });

  it('全系列の山で決める（メインとワーカーで目盛りを揃える）', () => {
    expect(scaleFor([seriesOf(0.02), seriesOf(0.4)])).toBe(0.5);
  });

  it('履歴が空でも段を返す', () => {
    expect(scaleFor([seriesOf()])).toBe(0.25);
    expect(scaleFor([])).toBe(0.25);
  });
});

describe('formatLoad', () => {
  it('割合を百分率にする', () => {
    expect(formatLoad(0)).toBe('0%');
    expect(formatLoad(0.5)).toBe('50%');
    expect(formatLoad(1)).toBe('100%');
  });

  it('小数は丸める（映像に重ねるので桁を増やさない）', () => {
    expect(formatLoad(0.126)).toBe('13%');
  });
});
