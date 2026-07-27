/**
 * 画面消灯の抑止。
 *
 * スマホで抵抗を映しながら値を入力する間、画面が消えると作業が途切れる。
 * Screen Wake Lock API は Safari 16.4+ / Chrome 84+ で使えるが、非対応でも
 * 支障はないので黙って諦める。
 *
 * ロックはタブが背面に回ると OS 側で解除されるため、復帰時に取り直す。
 */

let sentinel: WakeLockSentinel | null = null;

/** Wake Lock が使える環境か。 */
export function isWakeLockSupported(): boolean {
  return 'wakeLock' in navigator;
}

/** 画面消灯を抑止する。取得できなければ false。 */
export async function requestWakeLock(): Promise<boolean> {
  if (!isWakeLockSupported() || sentinel !== null) return sentinel !== null;

  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    return true;
  } catch {
    // 権限やバッテリーセーバーで拒否されることがある。機能を止める理由はない。
    return false;
  }
}

/** 抑止を解除する。 */
export async function releaseWakeLock(): Promise<void> {
  const current = sentinel;
  sentinel = null;
  if (current === null) return;
  try {
    await current.release();
  } catch {
    // 既に解除済みなら何もしない
  }
}
