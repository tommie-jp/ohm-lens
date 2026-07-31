/**
 * スクリーンショットの保存先。
 *
 * 保存先のフォルダは**最初の 1 回だけ選んでもらい**、以後はそれを使い回す。
 * File System Access API のディレクトリハンドルは文字列にできないので、
 * localStorage ではなく IndexedDB に構造化複製で持つ。
 *
 * この API は Chromium 系にしか無い。iOS Safari や Firefox では従来どおり
 * ダウンロードに落とす（保存先はブラウザの設定に従う＝毎回は聞かれない）。
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

async function readStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  const database = await openDatabase();
  if (database === null) return null;
  return new Promise((resolve) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    request.onsuccess = () => {
      resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    };
    request.onerror = () => {
      resolve(null);
    };
  });
}

async function writeStoredHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await openDatabase();
  if (database === null) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(handle, KEY);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      resolve();
    };
  });
}

/** 覚えてあるフォルダがまだ書けるか確かめる。必要なら許可を取り直す。 */
async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permissions = handle as unknown as PermissionCapableHandle;
  if (typeof permissions.queryPermission !== 'function') return true;
  const state = await permissions.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return true;
  if (typeof permissions.requestPermission !== 'function') return false;
  return (await permissions.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/**
 * 保存先のフォルダを用意する。覚えてあればそれを返し、無ければ選んでもらう。
 * 選択をやめた・この API が無い場合は null（ダウンロードに落とす）。
 *
 * @throws ユーザー操作の文脈から外れて呼ぶと選択ダイアログを出せない
 */
export async function resolveSaveDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = directoryPicker();
  if (picker === null) return null;

  const stored = await readStoredHandle();
  if (stored !== null && (await ensureWritable(stored))) return stored;

  try {
    const chosen = await picker({ mode: 'readwrite' });
    await writeStoredHandle(chosen);
    return chosen;
  } catch {
    // 選択をやめた。今回はダウンロードに落とす（次回また聞く）
    return null;
  }
}

/** どこに保存したか。呼び出し側の案内文に使う。 */
export type SaveResult = 'directory' | 'download';

/** フォルダが決まっていればそこへ、無ければダウンロードとして書き出す。 */
export async function saveBlob(
  blob: Blob,
  fileName: string,
  directory: FileSystemDirectoryHandle | null,
): Promise<SaveResult> {
  if (directory !== null) {
    const file = await directory.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
    return 'directory';
  }

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
