/**
 * スクリーンショットの保存先。
 *
 * 環境によって「保存できる道」が違うので、使える順に試す:
 *
 * 1. **フォルダへ直接書く**（File System Access API / Chromium 系）。
 *    フォルダは最初の 1 回だけ選んでもらい、以後は使い回す。ハンドルは
 *    文字列にできないので localStorage ではなく IndexedDB に持つ。
 * 2. **共有シート**（`navigator.share`）。iOS Safari はこれが「写真に保存」
 *    への唯一の道。ダウンロード属性では保存できない。
 * 3. ダウンロード（デスクトップ Firefox など）。
 *
 * 2 と 3 は**ユーザー操作の文脈でしか呼べない**ので、この関数までに
 * `await` を挟まないこと（画像の書き出しは同期で済ませてから呼ぶ）。
 */

const DB_NAME = 'ohm-lens';
const STORE = 'handles';
const KEY = 'screenshot-directory';

/** 権限の問い合わせ。標準の型定義にまだ無いので最小限だけ写す。 */
interface PermissionCapableHandle {
  queryPermission?: (descriptor: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: string }) => Promise<PermissionState>;
}

type DirectoryPicker = (options?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    // 保存先を覚えられなくても撮影自体は続けられる。毎回選んでもらうだけ
    request.onerror = () => {
      resolve(null);
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  const database = await openDatabase();
  if (database === null) return fallback;
  return new Promise<T>((resolve) => {
    let request: IDBRequest;
    try {
      request = run(database.transaction(STORE, mode).objectStore(STORE));
    } catch {
      resolve(fallback);
      return;
    }
    request.onsuccess = () => {
      resolve((request.result as T | undefined) ?? fallback);
    };
    request.onerror = () => {
      resolve(fallback);
    };
  });
}

function readStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  return withStore<FileSystemDirectoryHandle | null>('readonly', (store) => store.get(KEY), null);
}

async function writeStoredHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, KEY), undefined);
}

async function forgetStoredHandle(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY), undefined);
}

/** 覚えてあるフォルダがまだ書けるか確かめる。必要なら許可を取り直す。 */
async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permissions = handle as unknown as PermissionCapableHandle;
  if (typeof permissions.queryPermission !== 'function') return true;
  try {
    const state = await permissions.queryPermission({ mode: 'readwrite' });
    if (state === 'granted') return true;
    if (typeof permissions.requestPermission !== 'function') return false;
    return (await permissions.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** どこに保存したか。呼び出し側の案内文に使う。 */
export type SaveResult = 'directory' | 'share' | 'download' | 'cancelled';

/**
 * 覚えたフォルダ（無ければ選んでもらったフォルダ）へ書く。
 * 書けなければ**覚えていた内容を捨てて** null を返す（次回また選び直せる）。
 */
async function saveToDirectory(
  picker: DirectoryPicker,
  blob: Blob,
  fileName: string,
): Promise<boolean> {
  const stored = await readStoredHandle();
  let directory = stored !== null && (await ensureWritable(stored)) ? stored : null;

  if (directory === null) {
    try {
      directory = await picker({ mode: 'readwrite' });
    } catch {
      return false; // 選択をやめた
    }
  }

  try {
    const file = await directory.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    // 覚えていたフォルダが使えなくなっている（消された・権限を失った・
    // 壊れた記録）。持ち越すと以後ずっと失敗するので忘れる
    await forgetStoredHandle();
    return false;
  }

  await writeStoredHandle(directory);
  return true;
}

function canShareFile(file: File): boolean {
  return (
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  );
}

function download(blob: Blob, fileName: string): SaveResult {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // click 直後に revoke するとダウンロードが始まらない環境がある
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
  return 'download';
}

/**
 * 使える道を順に試して保存する。
 *
 * **ユーザー操作の文脈から `await` を挟まずに呼ぶこと**（共有シートと
 * ダウンロードがそれを要求する）。
 */
export async function saveImage(blob: Blob, fileName: string): Promise<SaveResult> {
  const picker = directoryPicker();
  if (picker === null) {
    const file = new File([blob], fileName, { type: blob.type });
    if (canShareFile(file)) {
      try {
        await navigator.share({ files: [file] });
        return 'share';
      } catch (error) {
        // 共有をやめただけなら、勝手にダウンロードし直さない
        if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
        return download(blob, fileName);
      }
    }
    return download(blob, fileName);
  }

  return (await saveToDirectory(picker, blob, fileName)) ? 'directory' : download(blob, fileName);
}
