import {
  buildVideoConstraints,
  displayCameraLabel,
  manualColorConstraints,
  pickPreferredCamera,
  supportsManualColor,
  type ColorCapabilities,
} from './cameraSupport.js';

/**
 * Web カメラの取得とフレーム供給。
 *
 * 設計メモ §2 [0] の方針に従う:
 * - フレーム同期は `requestVideoFrameCallback`（setInterval / rAF は使わない）
 * - ホワイトバランスと露出は固定できる環境でだけ固定する（Safari は非対応）
 *
 * 解析は 1 フレームごとにやると重いので、指定した間隔まで間引く。
 */

/** 解析に回すフレームの最大レート。設計メモの想定は 5〜10fps。 */
const DEFAULT_ANALYSIS_FPS = 8;

/** 解析用に縮小する長辺の画素数。フィクスチャハーネスと揃えてある。 */
const ANALYSIS_MAX_SIZE = 800;

export interface CameraStatus {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** ホワイトバランスと露出を手動固定できたか */
  readonly manualColorLocked: boolean;
}

export interface CameraOptions {
  readonly deviceId?: string;
  readonly analysisFps?: number;
  /** 間引いたフレームごとに呼ばれる。縮小済みの canvas を渡す。 */
  readonly onFrame: (frame: HTMLCanvasElement) => void;
  readonly onError: (error: unknown) => void;
}

/** 起動中のカメラ。停止するまでフレームを供給し続ける。 */
export interface CameraSession {
  readonly video: HTMLVideoElement;
  readonly status: CameraStatus;
  stop(): void;
}

/** WB / 露出の固定を試みる。できなければ黙って諦める。 */
async function tryLockColor(track: MediaStreamTrack): Promise<boolean> {
  const capabilities = track.getCapabilities?.() as ColorCapabilities | undefined;
  if (capabilities === undefined || !supportsManualColor(capabilities)) return false;

  try {
    await track.applyConstraints(manualColorConstraints());
    return true;
  } catch {
    return false;
  }
}

/**
 * 映像フレームを解析しやすい大きさの canvas に写す。
 * 元解像度のまま解析すると重いので長辺を抑える。
 */
function drawScaled(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
  const { videoWidth, videoHeight } = video;
  const scale = Math.min(1, ANALYSIS_MAX_SIZE / Math.max(videoWidth, videoHeight));
  const width = Math.max(1, Math.round(videoWidth * scale));
  const height = Math.max(1, Math.round(videoHeight * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return;
  context.drawImage(video, 0, 0, width, height);
}

/**
 * カメラを開始する。停止するまでフレームを供給し続ける。
 *
 * @throws {Error} カメラを開けなかった場合（`describeCameraError` で説明できる）
 */
export async function startCamera(options: CameraOptions): Promise<CameraSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: buildVideoConstraints(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  if (track === undefined) {
    stream.getTracks().forEach((t) => { t.stop(); });
    throw new Error('映像トラックを取得できませんでした');
  }

  const manualColorLocked = await tryLockColor(track);

  const video = document.createElement('video');
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  await video.play();

  const settings = track.getSettings();
  const status: CameraStatus = {
    label: displayCameraLabel(track.label),
    width: settings.width ?? video.videoWidth,
    height: settings.height ?? video.videoHeight,
    manualColorLocked,
  };

  const frameCanvas = document.createElement('canvas');
  const minInterval = 1000 / (options.analysisFps ?? DEFAULT_ANALYSIS_FPS);
  let stopped = false;
  let handle: number | null = null;
  let lastAnalysed = 0;

  const onFrame = (): void => {
    if (stopped) return;

    const now = performance.now();
    if (now - lastAnalysed >= minInterval) {
      lastAnalysed = now;
      try {
        drawScaled(video, frameCanvas);
        options.onFrame(frameCanvas);
      } catch (error) {
        options.onError(error);
      }
    }
    schedule();
  };

  // rVFC は Firefox 132+ を含め主要ブラウザで使えるが、
  // 古い環境向けに setTimeout の保険を残す。
  const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';

  const schedule = (): void => {
    if (stopped) return;
    handle = hasFrameCallback
      ? video.requestVideoFrameCallback(onFrame)
      : window.setTimeout(onFrame, minInterval);
  };

  schedule();

  return {
    video,
    status,
    stop(): void {
      stopped = true;
      if (handle !== null) {
        if (hasFrameCallback) video.cancelVideoFrameCallback(handle);
        else window.clearTimeout(handle);
      }
      stream.getTracks().forEach((t) => { t.stop(); });
      video.srcObject = null;
    },
  };
}

/** 利用できるカメラの一覧。ラベルは権限を得たあとでないと空になる。 */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput');
}

export { pickPreferredCamera };
