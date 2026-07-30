/**
 * カメラの capability 制御（トーチ・ズーム・接写用レンズ選択）。
 *
 * 41-QR-search の録画画面（qr-search/src/lib/video/cameraSelection.ts）から
 * 移植。そこでの実機検証で得た知見:
 *
 * - iOS Safari は focusMode / focusDistance（手動フォーカス）の
 *   MediaTrackConstraints に対応しない。iOS の「マクロ（近接）」は実体が
 *   **超広角レンズ**なので、手動フォーカスの代わりに**レンズそのものを
 *   超広角へ選び直す**ことで近接撮影を実現する。
 * - トーチ（ライト）と zoom は**トラックを開き直さずに** applyConstraints で
 *   効く。どちらも getCapabilities() で対応端末だけ操作を出す。
 * - レンズの選び直し（接写）は旧トラックを**先に止めてから**開き直す
 *   （iOS は 2 カメラ同時オープンで NotReadableError になる）。
 */

// 背面超広角カメラのラベル。iOS Safari は "Back Ultra Wide Camera"、日本語 UI や
// 一部 Android は「超広角」。どちらでも拾えるようにする。
const ULTRA_WIDE_LABEL = /ultra.?wide|超広角/i;

// 超広角は 0.5x 相当で画角が広すぎる。zoom 対応端末なら 1x 近くへクロップし直す。
export const NEAR_FOCUS_ZOOM = 2;

// ズームボタンの段階。スライダーは作り込みすぎなので代表的な倍率だけ出す。
export const ZOOM_STEPS: readonly number[] = [1, 2, 4];

/**
 * 端末の最大ズームで出せる段階を返す。1 段階だけ（= ズーム非対応相当）なら
 * 空配列を返し、呼び出し側はボタンを出さない。
 */
export function zoomLevelsFor(maxZoom: number): number[] {
  const levels = ZOOM_STEPS.filter((step) => step <= maxZoom);
  return levels.length > 1 ? levels : [];
}

// torch / zoom は標準の TS DOM 型に無い（実験的 API）。必要な形だけを最小に写す。
interface ExtendedCapabilities {
  readonly torch?: boolean;
  readonly zoom?: { readonly min: number; readonly max: number };
}
interface ExtendedConstraintSet {
  readonly torch?: boolean;
  readonly zoom?: number;
}

/** 現在のトラックが持つトーチ・ズームの対応状況。UI の出し分けに使う。 */
export interface CameraCapabilities {
  readonly torch: boolean;
  readonly zoom: { readonly min: number; readonly max: number } | null;
}

function readCapabilities(track: MediaStreamTrack): ExtendedCapabilities | undefined {
  return track.getCapabilities?.() as ExtendedCapabilities | undefined;
}

function applyExtended(track: MediaStreamTrack, set: ExtendedConstraintSet): Promise<void> {
  return track.applyConstraints({
    advanced: [set as unknown as MediaTrackConstraintSet],
  } as MediaTrackConstraints);
}

/** トラックのトーチ・ズーム対応を読む。getCapabilities 未実装なら両方なしとする。 */
export function readCameraCapabilities(track: MediaStreamTrack): CameraCapabilities {
  const capabilities = readCapabilities(track);
  const zoom =
    capabilities?.zoom && typeof capabilities.zoom.max === 'number'
      ? { min: capabilities.zoom.min, max: capabilities.zoom.max }
      : null;
  return { torch: capabilities?.torch === true, zoom };
}

/**
 * 背面超広角カメラの deviceId を返す。見つからない・列挙できない端末では null
 * （= 接写ボタンを出さない）。PC や多くの Android、旧 iPhone はここで null になる。
 * ラベルは getUserMedia の権限を得た後でないと空なので、カメラ起動後に呼ぶこと。
 */
export async function findUltraWideDeviceId(): Promise<string | null> {
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return null;
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    // 列挙できないなら接写は諦める（通常カメラで読めれば十分）
    return null;
  }
  const match = devices.find(
    (device) => device.kind === 'videoinput' && ULTRA_WIDE_LABEL.test(device.label),
  );
  return match?.deviceId ?? null;
}

/**
 * 開けたトラックが前面（自撮り）カメラかどうか。iOS Safari には deviceId を
 * 前面に誤解決する癖があり、超広角を名指しで開いた後の検証に使う。
 * getSettings の facingMode を第一に、無ければラベルで判定。どちらも取れなければ
 * 前面とは断定しない（誤検出でフォールバックを空回りさせない）。
 */
export function isFrontFacing(track: MediaStreamTrack): boolean {
  const facing = track.getSettings?.().facingMode;
  if (facing !== undefined && facing !== '') return facing === 'user';
  return /front|前面/i.test(track.label);
}

/**
 * zoom を対応範囲内で適用し、実際に適用した値を返す。**非対応なら null**
 * （何もしない）。接写の初期ズームとズームボタンの両方がこれを使う。
 */
export async function applyZoom(track: MediaStreamTrack, value: number): Promise<number | null> {
  const zoom = readCapabilities(track)?.zoom;
  if (!zoom) return null;
  const target = Math.min(Math.max(value, zoom.min), zoom.max);
  try {
    await applyExtended(track, { zoom: target });
    return target;
  } catch {
    // zoom 指定が拒まれても解析自体は続く。無視
    return null;
  }
}

/**
 * 超広角トラックの画角を zoom で 1x 近くへ寄せる（接写に入ったときの初期値）。
 * **zoom 非対応なら何もしない**（applyZoom が null を返すだけ）。
 */
export async function applyNearFocusZoom(track: MediaStreamTrack): Promise<void> {
  await applyZoom(track, NEAR_FOCUS_ZOOM);
}

/** トーチ（ライト）を点灯/消灯し、実際に適用できたかを返す。**非対応なら false**。 */
export async function applyTorch(track: MediaStreamTrack, on: boolean): Promise<boolean> {
  if (readCapabilities(track)?.torch !== true) return false;
  try {
    await applyExtended(track, { torch: on });
    return true;
  } catch {
    // トーチ指定が拒まれても解析は続く。点いていない扱いにする
    return false;
  }
}
