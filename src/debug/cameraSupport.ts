/**
 * カメラまわりの純粋な補助関数。
 *
 * `getUserMedia` の呼び出し自体はブラウザ API に触るのでテストしづらいが、
 * 「どんな制約を投げるか」「どのカメラを選ぶか」「エラーをどう説明するか」は
 * 純粋な判断なので切り出してテストする。
 */

/** 抵抗器の色帯を読むには解像度が要る。取れるだけ取っておく。 */
const IDEAL_WIDTH = 1920;

export interface VideoConstraintOptions {
  /** 使うカメラを直接指定する（デバイス一覧から選んだ場合） */
  readonly deviceId?: string;
  /**
   * deviceId 名指し時に背面カメラを強制する。iOS Safari は背面レンズの
   * deviceId を前面カメラへ誤解決することがあり、`ideal` では防げない。
   * `exact` にして誤解決を OverconstrainedError で失敗させ、呼び出し側で
   * 通常の背面カメラへフォールバックする（41-QR-search の実機検証の知見）。
   */
  readonly exactEnvironment?: boolean;
}

/**
 * `getUserMedia` に渡す映像制約を組み立てる。
 * deviceId の指定があればそちらを優先し、無ければ背面カメラを希望する。
 */
export function buildVideoConstraints(options: VideoConstraintOptions = {}): MediaTrackConstraints {
  if (options.deviceId !== undefined) {
    return {
      deviceId: { exact: options.deviceId },
      ...(options.exactEnvironment === true ? { facingMode: { exact: 'environment' } } : {}),
      width: { ideal: IDEAL_WIDTH },
    };
  }
  return { facingMode: 'environment', width: { ideal: IDEAL_WIDTH } };
}

/** 背面カメラらしいラベルの手がかり。端末ごとに表記が違うので広めに拾う。 */
const BACK_CAMERA_HINTS = ['back', 'rear', 'environment', '背面', '外側'];

/**
 * 一覧から使いたいカメラを選ぶ。
 *
 * 背面カメラらしいものを優先する（抵抗器を写すのは通常こちら）。
 * 見つからなければ最初の映像デバイス。
 */
export function pickPreferredCamera(devices: readonly MediaDeviceInfo[]): MediaDeviceInfo | null {
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  if (cameras.length === 0) return null;

  const back = cameras.find((camera) => {
    const label = camera.label.toLowerCase();
    return BACK_CAMERA_HINTS.some((hint) => label.includes(hint));
  });
  return back ?? (cameras[0] as MediaDeviceInfo);
}

/** `MediaStreamTrack.getCapabilities()` の返り値のうち、ここで見る部分。 */
export interface ColorCapabilities {
  readonly whiteBalanceMode?: readonly string[];
  readonly exposureMode?: readonly string[];
}

/**
 * ホワイトバランスと露出を手動で固定できるか。
 *
 * 固定できると色判定が安定するが、**Safari は対応していない**ので
 * 使えなければ黙って諦める（設計メモ §2 [0]）。相対分類が主防御なので、
 * これはあくまで上乗せの最適化。
 */
export function supportsManualColor(capabilities: ColorCapabilities): boolean {
  const hasManual = (modes: readonly string[] | undefined): boolean =>
    modes !== undefined && modes.includes('manual');
  return hasManual(capabilities.whiteBalanceMode) && hasManual(capabilities.exposureMode);
}

/** ホワイトバランスと露出を手動に固定する制約。 */
export function manualColorConstraints(): MediaTrackConstraints {
  return {
    advanced: [
      { whiteBalanceMode: 'manual', exposureMode: 'manual' } as MediaTrackConstraintSet,
    ],
  };
}

/** これより長いラベルは機械的な ID とみなして表示しない。 */
const MAX_LABEL_LENGTH = 40;

/**
 * カメラのラベルを表示用に整える。
 *
 * 権限を得る前や合成ストリームでは、ラベルが空だったり base64 の ID
 * だったりする。そのまま出しても意味がないので既定名にする。
 */
export function displayCameraLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed === '' || trimmed.length > MAX_LABEL_LENGTH) return 'カメラ';
  return trimmed;
}

const ERROR_MESSAGES: Record<string, string> = {
  NotAllowedError: 'カメラの使用が許可されませんでした。ブラウザの権限設定を確認してください。',
  NotFoundError: 'カメラが見つかりませんでした。接続を確認してください。',
  NotReadableError: 'カメラを開けませんでした。他のアプリが使用中かもしれません。',
  OverconstrainedError: '要求した設定に合うカメラがありませんでした。',
  SecurityError: 'カメラは HTTPS か localhost でしか使えません。',
};

/** 例外を利用者向けの説明に変換する。 */
export function describeCameraError(error: unknown): string {
  if (error instanceof Error) {
    return ERROR_MESSAGES[error.name] ?? `カメラを開始できませんでした: ${error.message}`;
  }
  return `カメラを開始できませんでした: ${String(error)}`;
}
