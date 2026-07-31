import { describe, expect, it } from 'vitest';
import { formatShare, runVerdict } from '../../src/annotate/read.js';

/**
 * `doDetect.sh` の集計に使う判定と整形。
 *
 * 集計そのものはスクリプト（`scripts/detect.ts`）にあるが、判定と丸めは
 * ここで測れるように純関数として切り出してある。
 */

describe('runVerdict', () => {
  it('本数が合っていれば same', () => {
    expect(runVerdict(4, 4)).toBe('same');
  });

  it('検出が期待より少なければ fewer', () => {
    expect(runVerdict(3, 4)).toBe('fewer');
  });

  it('検出が期待より多ければ more', () => {
    expect(runVerdict(6, 4)).toBe('more');
  });

  it('検出できなかった写真（0 本）は fewer', () => {
    // 検出失敗も「ランが足りない」として数える。別勘定にすると
    // 3 つの合計が枚数と合わなくなる
    expect(runVerdict(0, 4)).toBe('fewer');
  });
});

describe('formatShare', () => {
  it('件数と全体に対する割合を並べる', () => {
    expect(formatShare(32, 43)).toBe('32(74%)');
  });

  it('0 件でも割合を出す（保留 0 と 0% を同時に見せる）', () => {
    expect(formatShare(0, 43)).toBe('0(0%)');
  });

  it('全件なら 100%', () => {
    expect(formatShare(43, 43)).toBe('43(100%)');
  });

  it('母数が 0 なら割合は出さない', () => {
    // 割合が定義できない。0% と書くと「測ったが 0 だった」に見える
    expect(formatShare(0, 0)).toBe('0(-)');
  });
});
