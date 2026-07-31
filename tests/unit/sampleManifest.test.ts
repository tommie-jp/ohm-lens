import { describe, expect, it } from 'vitest';
import { isTrainable, staleManifestEntries, type SampleEntry } from '../fixtures/loadSample.js';

/**
 * sample/ のマニフェストの扱い。
 *
 * sample/ は手で足したり消したりする作業用のディレクトリで、切り出しが甘い
 * 検体はそのまま消される。消しただけでマニフェストが壊れないこと、
 * 未検証の検体が黙って基準色を動かさないことの 2 点を守る。
 */

function entryOf(overrides: Partial<SampleEntry> = {}): SampleEntry {
  return {
    file: '01-1ohm.jpg',
    ohms: 1,
    tolerance: 1,
    bands: null,
    source: 'commons',
    calibrate: true,
    ...overrides,
  };
}

describe('isTrainable', () => {
  it('既定では較正の教師データに使う', () => {
    expect(isTrainable(entryOf())).toBe(true);
  });

  it('calibrate: false のエントリは較正から外す', () => {
    // Arrange: 出典から推定しただけでバンド列を人が確認していない検体
    const entry = entryOf({ calibrate: false });

    // Act / Assert
    expect(isTrainable(entry)).toBe(false);
  });

  it('バンド列を持っていても calibrate: false なら外す', () => {
    // Arrange: bands を消すだけでは期待値からの逆算で学習に入ってしまうため、
    // 除外はバンド列の有無と独立に効かせる
    const entry = entryOf({ bands: ['grey', 'red', 'orange'], calibrate: false });

    // Act / Assert
    expect(isTrainable(entry)).toBe(false);
  });
});

describe('staleManifestEntries', () => {
  it('実体の無いエントリを挙げる', () => {
    // Arrange
    const manifest = [{ file: 'a.jpg' }, { file: 'b.jpg' }, { file: 'c.jpg' }];
    const present = new Set(['a.jpg', 'c.jpg']);

    // Act
    const stale = staleManifestEntries(manifest, present);

    // Assert
    expect(stale).toEqual(['b.jpg']);
  });

  it('全部そろっていれば空', () => {
    const manifest = [{ file: 'a.jpg' }];

    expect(staleManifestEntries(manifest, new Set(['a.jpg']))).toEqual([]);
  });

  it('マニフェストが空でも壊れない', () => {
    expect(staleManifestEntries([], new Set(['a.jpg']))).toEqual([]);
  });
});
