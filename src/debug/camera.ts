import {
  analysisSize,
  createBudget,
  frameStats,
  recordFrame,
  type BudgetState,
  type FrameStats,
} from './frameBudget.js';
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


export interface CameraStatus {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** ホワイトバランスと露出を手動固定できたか */
  readonly manualColorLocked: boolean;
}

export interface CameraOptions {
  readonly deviceId?: string;
  /**
   * deviceId 名指し時に背面カメラを強制する。iOS Safari は deviceId を
   * 前面カメラへ誤解決することがあるため、超広角レンズ（接写）を開くときは
   * true にして失敗（OverconstrainedError）させる。
   */
  readonly exactEnvironment?: boolean;
  readonly analysisFps?: number;
  /** プレビューに使う video 要素。未指定なら DOM 外に生成する。 */
  readonly videoElement?: HTMLVideoElement;
  /**
   * 間引いたフレームごとに呼ばれる。縮小済みの canvas を渡す。
   *
   * Promise を返すと、その完了までを 1 フレームの処理時間として測り、
   * 完了するまで次のフレームは渡さない（解析をワーカースレッドへ
   * 追い出したときのバックプレッシャ）。
   */
  readonly onFrame: (frame: HTMLCanvasElement) => void | Promise<void>;
  /** 負荷の実測値。fps 表示と自動調整の状況を出すのに使う。 */
  readonly onStats?: (stats: FrameStats, analysisPx: number) => void;
  readonly onError: (error: unknown) => void;
}

/** 起動中のカメラ。停止するまでフレームを供給し続ける。 */
export interface CameraSession {
  readonly video: HTMLVideoElement;
  /** 映像トラック。トーチ・ズームなど applyConstraints 系の操作に使う。 */
  readonly track: MediaStreamTrack;
  readonly status: CameraStatus;
  /**
   * 解析フレームの中央だけを使う倍率（デジタルズーム）。
   * ハードウェアの zoom が効かない端末（iOS Safari）で画角を戻すのに使う。
   * プレビュー側の拡大は呼び出し側が CSS で合わせること。
   */
  setDigitalZoom(zoom: number): void;
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
 *
 * `zoom` が 1 より大きいときは中央だけを切り出す（デジタルズーム）。
 * 切り出した範囲を解析解像度いっぱいに使うので、拡大しても色帯に割ける
 * 画素は減らない。
 */
function drawScaled(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxSize: number,
  zoom: number,
): void {
  const { videoWidth, videoHeight } = video;
  const sourceWidth = videoWidth / zoom;
  const sourceHeight = videoHeight / zoom;
  const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return;
  context.drawImage(
    video,
    (videoWidth - sourceWidth) / 2,
    (videoHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
}

/**
 * カメラを開始する。停止するまでフレームを供給し続ける。
 *
 * @throws {Error} カメラを開けなかった場合（`describeCameraError` で説明できる）
 */
export async function startCamera(options: CameraOptions): Promise<CameraSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: buildVideoConstraints({
      ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      ...(options.exactEnvironment === undefined
        ? {}
        : { exactEnvironment: options.exactEnvironment }),
    }),
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  if (track === undefined) {
    stream.getTracks().forEach((t) => { t.stop(); });
    throw new Error('映像トラックを取得できませんでした');
  }

  const manualColorLocked = await tryLockColor(track);

  const video = options.videoElement ?? document.createElement('video');
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
  let budget: BudgetState = createBudget(options.analysisFps ?? DEFAULT_ANALYSIS_FPS);
  let stopped = false;
  let handle: number | null = null;
  let lastAnalysed = 0;
  let digitalZoom = 1;

  /**
   * 解析が終わるまで次のフレームを渡さない（in-flight は常に 1 本）。
   *
   * frameCanvas は使い回しなので、解析中に上書きすると解析が見ている画素と
   * 表示が食い違う。溜めずに捨てるのは、次のフレームがすぐ来る以上、
   * 待たせるより新しい画で測り直すほうが結果が新鮮になるため。
   */
  let analysing = false;

  const onFrame = (): void => {
    if (stopped) return;

    // 解析中は次のフレームを取りに行かない。空回りのコールバックで毎フレーム
    // メインスレッドを起こすと、ブラウザが省電力に入る余地を潰す。
    // 受け取りの再開は finish() が行う
    const now = performance.now();
    if (analysing || now - lastAnalysed < 1000 / budget.targetFps) {
      schedule();
      return;
    }

    {
      lastAnalysed = now;
      analysing = true;
      const started = performance.now();

      // 実測して間引き間隔と解析解像度を自動調整する。解析をワーカースレッドへ
      // 移した後も、待ち時間と転送を含めた 1 フレームの総コストを測る
      const finish = (): void => {
        analysing = false;
        if (stopped) return;
        budget = recordFrame(budget, performance.now() - started);
        const stats = frameStats(budget);
        if (stats !== null) options.onStats?.(stats, analysisSize(budget));
        // 解析中は登録を止めていたので、ここから受け取りを再開する
        schedule();
      };

      try {
        drawScaled(video, frameCanvas, analysisSize(budget), digitalZoom);
        const pending = options.onFrame(frameCanvas);
        if (pending === undefined) finish();
        else {
          pending.then(finish, (error: unknown) => {
            finish();
            options.onError(error);
          });
        }
      } catch (error) {
        finish();
        options.onError(error);
      }
    }
  };

  // rVFC は Firefox 132+ を含め主要ブラウザで使えるが、
  // 古い環境向けに setTimeout の保険を残す。
  const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';

  const schedule = (): void => {
    if (stopped) return;
    handle = hasFrameCallback
      ? video.requestVideoFrameCallback(onFrame)
      : window.setTimeout(onFrame, 1000 / budget.targetFps);
  };

  schedule();

  return {
    video,
    track,
    status,
    setDigitalZoom(zoom: number): void {
      digitalZoom = Math.max(1, zoom);
    },
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
