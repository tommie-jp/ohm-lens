import { analyzeRoi, type AnalysisResult } from '../core/pipeline.js';
import { locateResistor, type OrientedBox } from '../core/locate.js';
import { refineBoxExtent } from '../core/refine.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../core/settings.js';
import { rectify } from '../core/rectify.js';
import type { RoiImage } from '../core/bands/profile.js';
import { withOverrides, DEFAULT_PALETTE, type Palette } from '../core/color/palette.js';
import { formatLabels, loadLabels, saveLabels, type LabelMap } from './labelStore.js';
import {
  addObservations,
  matchRunsToValue,
  paletteOverrides,
  type Observations,
} from '../core/learning.js';
import { parseOhms } from '../core/value/parseOhms.js';
import { clearObservations, loadObservations, saveObservations } from './learnStore.js';
import { releaseWakeLock, requestWakeLock } from './wakeLock.js';
import {
  formatConfidence,
  formatOhms,
  formatReading,
  MIN_REPORTABLE_CONFIDENCE,
} from '../core/format.js';
import type { Band, BandColor, LabColor } from '../types.js';
import { createSampleCanvas } from './sample.js';
import { drawProfile } from './profileView.js';
import { context2d } from './canvas.js';
import { decodeImageFile } from './decodeImage.js';
import { drawDetectionOverlay, drawReadingLabel } from './detectionOverlay.js';
import { SUPPORTED_ACCEPT } from '../core/imageFormat.js';
import { listCameras, pickPreferredCamera, startCamera, type CameraSession } from './camera.js';
import { describeCameraError } from './cameraSupport.js';
import { createSmoother, pushBox, type SmootherState } from './boxSmoother.js';
import {
  applyNearFocusZoom,
  applyTorch,
  applyZoom,
  findUltraWideDeviceId,
  isFrontFacing,
  NEAR_FOCUS_ZOOM,
  readCameraCapabilities,
} from './cameraControls.js';
import { renderCameraControls, type ControlsHandle } from './cameraControlsView.js';
import { pointerToCanvas } from './viewMapping.js';

/**
 * Phase 0 の目視確認ツール。
 * 画像を読み込み、ドラッグで ROI を指定して解析結果を表示する。
 * ここだけ DOM に依存する（core/ は DOM 非依存を保つ）。
 */

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const elements = {
  liveWrap: requireElement<HTMLDivElement>('#live-wrap'),
  liveVideo: requireElement<HTMLVideoElement>('#live-video'),
  overlayCanvas: requireElement<HTMLCanvasElement>('#overlay-canvas'),
  emptyError: requireElement<HTMLParagraphElement>('#empty-error'),
  cameraControls: requireElement<HTMLDivElement>('#camera-controls'),
  fileInput: requireElement<HTMLInputElement>('#file-input'),
  pickFile: requireElement<HTMLButtonElement>('#pick-file'),
  sampleButton: requireElement<HTMLButtonElement>('#sample-button'),
  cameraButton: requireElement<HTMLButtonElement>('#camera-button'),
  captureButton: requireElement<HTMLButtonElement>('#capture-button'),
  resetButton: requireElement<HTMLButtonElement>('#reset-button'),
  cameraSelect: requireElement<HTMLSelectElement>('#camera-select'),
  emptyState: requireElement<HTMLDivElement>('#empty-state'),
  statusLine: requireElement<HTMLParagraphElement>('#status-line'),
  engineStatus: requireElement<HTMLParagraphElement>('#engine-status'),
  autoToggle: requireElement<HTMLInputElement>('#auto-toggle'),
  adaptToggle: requireElement<HTMLInputElement>('#adapt-toggle'),
  sourceCanvas: requireElement<HTMLCanvasElement>('#source-canvas'),
  roiCanvas: requireElement<HTMLCanvasElement>('#roi-canvas'),
  profileCanvas: requireElement<HTMLCanvasElement>('#profile-canvas'),
  bandsTable: requireElement<HTMLTableElement>('#bands-table'),
  bandsEmpty: requireElement<HTMLParagraphElement>('#bands-empty'),
  reading: requireElement<HTMLOutputElement>('#reading'),
  readingNote: requireElement<HTMLParagraphElement>('#reading-note'),
  readingDetail: requireElement<HTMLDListElement>('#reading-detail'),
  labelName: requireElement<HTMLInputElement>('#label-name'),
  labelJson: requireElement<HTMLPreElement>('#label-json'),
  copyLabel: requireElement<HTMLButtonElement>('#copy-label'),
  copyStatus: requireElement<HTMLSpanElement>('#copy-status'),
  saveLabel: requireElement<HTMLButtonElement>('#save-label'),
  clearLabels: requireElement<HTMLButtonElement>('#clear-labels'),
  labelCount: requireElement<HTMLSpanElement>('#label-count'),
  learnValue: requireElement<HTMLInputElement>('#learn-value'),
  learnTolerance: requireElement<HTMLSelectElement>('#learn-tolerance'),
  learnButton: requireElement<HTMLButtonElement>('#learn-button'),
  learnStatus: requireElement<HTMLParagraphElement>('#learn-status'),
  learnCounts: requireElement<HTMLParagraphElement>('#learn-counts'),
  learnExport: requireElement<HTMLButtonElement>('#learn-export'),
  learnClear: requireElement<HTMLButtonElement>('#learn-clear'),
  stickyBar: requireElement<HTMLDivElement>('#sticky-bar'),
  stickyReading: requireElement<HTMLOutputElement>('#sticky-reading'),
  stickyLearn: requireElement<HTMLButtonElement>('#sticky-learn'),
};

/**
 * ステータス行の各項目。1 本の文にまとめて出す。
 * 以前は span を 4 つ並べていたが、何がどれか分からなかった。
 */
const statusParts: {
  input: string;
  detection: string;
  performance: string;
} = { input: '', detection: '', performance: '' };

function renderStatus(): void {
  const parts = [statusParts.input, statusParts.detection, statusParts.performance].filter(
    (part) => part !== '',
  );
  elements.statusLine.textContent =
    parts.length === 0 ? '画像またはカメラを選んでください。' : parts.join(' ・ ');
}

/** 選択肢に出すバンド色。 */
const BAND_COLORS: readonly BandColor[] = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green',
  'blue', 'violet', 'grey', 'white', 'gold', 'silver',
];

/** 手動修正の結果。推測を上書きして学習に回す。 */
let correctedColors: BandColor[] = [];

let source: HTMLCanvasElement | null = null;
let detectedBox: OrientedBox | null = null;
let palette: Palette | null = null;
let savedLabels: LabelMap = loadLabels();
let camera: CameraSession | null = null;
let observations: Observations = loadObservations();
let lastResult: AnalysisResult | null = null;

/**
 * 画面のモード。
 * - idle: 何も映していない（空状態とエラー表示）
 * - live: カメラのライブ映像 + オーバーレイ
 * - still: 静止画（ファイル・サンプル・キャプチャ）
 */
type Mode = 'idle' | 'live' | 'still';
let mode: Mode = 'idle';

/** 検出枠の時間平滑化。カメラを開き直すたびに作り直す。 */
let smoother: SmootherState = createSmoother();
/** オーバーレイに出す値。検出が一瞬途切れた保持フレームでも出し続ける。 */
let lastReadingText = '?';

let cameraControlsHandle: ControlsHandle | null = null;
/** 背面超広角レンズの deviceId。ストリームが生きている間に取ってキャッシュする。 */
let ultraWideId: string | null = null;

/** 学習に使うには対応付けコストがこの水準以下であること。 */
const MAX_LEARN_COST = 25;

/**
 * 現在有効なパレット。サーバの学習結果に、この場で学習した上書きを重ねる。
 */
function activePalette(): Palette | null {
  const learned = paletteOverrides(observations);
  const base = palette ?? DEFAULT_PALETTE;
  if (Object.keys(learned).length === 0) return palette;
  return withOverrides(base, learned);
}

/** 学習した色ごとの件数を表示する。 */
function renderLearnCounts(): void {
  const entries = Object.entries(observations)
    .filter(([, samples]) => (samples?.length ?? 0) > 0)
    .map(([color, samples]) => `${color} ${samples?.length ?? 0}`);
  elements.learnCounts.textContent =
    entries.length === 0 ? '学習データ: なし' : `学習データ: ${entries.join(' / ')}`;
}
let selection: Rect | null = null;
let dragStart: { x: number; y: number } | null = null;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`要素が見つかりません: ${selector}`);
  return element;
}

/**
 * 画面の表示状態をモードから一括で決める。
 * hidden の個別操作をここに集め、状態の食い違いを防ぐ。
 */
function applyMode(next: Mode): void {
  mode = next;
  elements.emptyState.hidden = next !== 'idle';
  elements.liveWrap.hidden = next !== 'live';
  elements.sourceCanvas.hidden = next !== 'still';
  elements.captureButton.hidden = next !== 'live';
  elements.cameraSelect.hidden = next !== 'live';
  elements.resetButton.hidden = next !== 'still';
  elements.cameraButton.textContent =
    next === 'live' ? 'カメラを停止' : next === 'still' ? 'カメラに戻る' : 'カメラを開始';
}

function setSource(canvas: HTMLCanvasElement): void {
  source = canvas;
  applyMode('still');
  updateStickyBar();
  elements.sourceCanvas.width = canvas.width;
  elements.sourceCanvas.height = canvas.height;
  context2d(elements.sourceCanvas).drawImage(canvas, 0, 0);

  // 既定 ROI は中央の横帯。まず何か表示してから微調整できるようにする。
  selection = {
    x: 0,
    y: Math.round(canvas.height * 0.3),
    width: canvas.width,
    height: Math.max(1, Math.round(canvas.height * 0.4)),
  };
  analyzeSelection();
}

function redrawSource(): void {
  if (source === null) return;
  const context = context2d(elements.sourceCanvas);
  context.drawImage(source, 0, 0);

  // 自動検出時の枠は、バンドが確定してから analyzeSelection が描く
  if (elements.autoToggle.checked) return;
  if (selection === null) return;

  context.strokeStyle = '#00b0ff';
  context.lineWidth = 2;
  context.strokeRect(selection.x, selection.y, selection.width, selection.height);
}

/** テストのフィクスチャハーネスと揃えた ROI の切り出し条件。 */


/**
 * 解析対象の ROI を用意する。
 *
 * 自動検出が有効なら、画像全体から抵抗器を探して水平化する
 * （`tests/fixtures` と同じ経路）。無効なら選択範囲をそのまま使う。
 */
function buildRoi(auto: boolean): RoiImage | null {
  if (source === null) return null;
  const context = context2d(source, { willReadFrequently: true });

  if (auto) {
    const full = context.getImageData(0, 0, source.width, source.height);
    const image: RoiImage = { width: full.width, height: full.height, data: full.data };
    const located = locateResistor(image);
    if (located === null) {
      statusParts.detection = '抵抗器を検出できません';
      renderStatus();
      return null;
    }
    // カラーコードの並びで枠を広げ直す（バッチ・較正と同じ経路）
    const box = refineBoxExtent(located, image, refineOptions(activePalette() ?? undefined));
    detectedBox = box;
    statusParts.detection = `検出 ${box.angleDeg.toFixed(0)}° / ${Math.round(box.length)}px`;
    renderStatus();
    return rectify(image, box, ROI_OPTIONS);
  }

  detectedBox = null;
  statusParts.detection = '手動指定';
  renderStatus();
  if (selection === null || selection.width < 1 || selection.height < 1) return null;
  const roi = context.getImageData(
    Math.round(selection.x),
    Math.round(selection.y),
    Math.round(selection.width),
    Math.round(selection.height),
  );
  return { width: roi.width, height: roi.height, data: roi.data };
}

/**
 * ROI を解析し、右カラム（ROI 表示・プロファイル・バンド表・値）を更新する。
 * 静止画とライブの両経路がここを通る。
 */
function renderAnalysis(roi: RoiImage): AnalysisResult {
  elements.roiCanvas.width = roi.width;
  elements.roiCanvas.height = roi.height;
  const roiContext = context2d(elements.roiCanvas);
  const imageData = roiContext.createImageData(roi.width, roi.height);
  imageData.data.set(roi.data);
  roiContext.putImageData(imageData, 0, 0);

  // 自動検出のときは検出枠から本体の位置を渡す（バッチ・較正と同じ条件）。
  // 手動指定のときは枠が無いので、従来どおりプロファイルから推定させる。
  const effective = activePalette() ?? undefined;
  const result = analyzeRoi(roi, {
    adaptWhiteBalance: elements.adaptToggle.checked,
    ...(detectedBox === null
      ? effective === undefined
        ? {}
        : { segment: { palette: effective } }
      : analyzeOptions(detectedBox, effective)),
  });
  lastResult = result;

  drawProfile(elements.profileCanvas, result.profile, result.bands);
  renderBands(result.bands);
  renderReading(result);
  return result;
}

function analyzeSelection(): void {
  if (mode !== 'still' || source === null) return;

  redrawSource();

  const roi = buildRoi(elements.autoToggle.checked);
  if (roi === null) return;

  drawOverlay(renderAnalysis(roi));
}

/**
 * ライブ映像の 1 フレームを解析してオーバーレイを描き直す。
 *
 * プレビューは video 要素がそのまま映し続けるので、映像は描き直さない。
 * 手動 ROI はフレームサイズが自動調整で変わると絶対座標が破綻するため、
 * ライブ中は常に自動検出を使う。描画には平滑化した枠を使い、解析には
 * 生の検出枠を使う（平滑遅れを色帯読み取りに持ち込まない）。
 */
function analyzeLiveFrame(frame: HTMLCanvasElement): void {
  source = frame;
  updateStickyBar();

  detectedBox = null;
  const roi = buildRoi(true);
  const result = roi === null ? null : renderAnalysis(roi);
  if (result !== null) lastReadingText = formatReading(result.reading);

  const smoothed = pushBox(smoother, detectedBox);
  smoother = smoothed.state;
  drawLiveOverlay(frame, smoothed.box, result);
}

/**
 * ライブ用オーバーレイ。透明 canvas に枠・バンド・値だけを描く。
 *
 * canvas の内在解像度を毎回解析フレームに合わせるので、検出座標
 * （解析フレーム座標系）を変換なしでそのまま描ける。CSS 側は video と
 * 同じ矩形に引き伸ばされる（アスペクト比が同じなのでズレない）。
 */
function drawLiveOverlay(
  frame: HTMLCanvasElement,
  box: OrientedBox | null,
  result: AnalysisResult | null,
): void {
  const overlay = elements.overlayCanvas;
  if (overlay.width !== frame.width || overlay.height !== frame.height) {
    overlay.width = frame.width;
    overlay.height = frame.height;
  }
  const context = context2d(overlay);
  context.clearRect(0, 0, overlay.width, overlay.height);
  if (box === null) return;

  // 保持フレーム（検出が一瞬途切れた間）はバンドが無いので枠と値だけ描く
  drawDetectionOverlay(context, box, result?.bands ?? [], { rectify: ROI_OPTIONS });
  drawReadingLabel(context, box, lastReadingText);
}

/**
 * 検出結果を元画像に焼き込む。
 *
 * 「どこを抵抗器と見なし、どの帯を何色と読んだか」を写真の上で確認できる
 * ようにする。バンドの座標は ROI 列番号なので、`roiMapping` の逆変換で
 * 元画像に戻してから描く。
 */
function drawOverlay(result: AnalysisResult): void {
  if (detectedBox === null) return;

  // extent でスライスした場合、Band の列番号は ROI 基準のままなので
  // そのまま逆変換できる（roiMapping のテストで固定済み）
  drawDetectionOverlay(context2d(elements.sourceCanvas), detectedBox, result.bands, {
    rectify: ROI_OPTIONS,
  });
}

function renderBands(bands: readonly Band[]): void {
  const body = elements.bandsTable.tBodies[0];
  if (body === undefined) return;

  correctedColors = bands.map((band) => band.color);

  body.replaceChildren();
  elements.bandsEmpty.hidden = bands.length > 0;
  elements.bandsTable.hidden = bands.length === 0;

  bands.forEach((band, index) => {
    const row = body.insertRow();
    row.insertCell().textContent = String(index + 1);

    const guessCell = row.insertCell();
    guessCell.append(swatchFor(band.color), band.color);

    const editCell = row.insertCell();
    editCell.append(colorSelect(index, band.color));

    row.insertCell().textContent = `${band.start}–${band.end}`;
    row.insertCell().textContent = String(band.end - band.start);
    row.insertCell().textContent = formatConfidence(band.confidence);
  });

  renderLabelJson();
}

function swatchFor(color: BandColor): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = color === 'grey' ? 'gray' : color;
  return swatch;
}

/** バンド 1 本ぶんの色を選び直すプルダウン。 */
function colorSelect(index: number, selected: BandColor): HTMLSelectElement {
  const select = document.createElement('select');
  for (const color of BAND_COLORS) {
    const option = document.createElement('option');
    option.value = color;
    option.textContent = color;
    option.selected = color === selected;
    select.append(option);
  }
  select.addEventListener('change', () => {
    correctedColors[index] = select.value as BandColor;
    renderLabelJson();
  });
  return select;
}

/** labels.json に貼り付けられる形で、保存済みラベルをまとめて出す。 */
function renderLabelJson(): void {
  const count = Object.keys(savedLabels).length;
  elements.labelCount.textContent = count === 0 ? '保存済み 0 件' : `保存済み ${count} 件`;

  const current =
    correctedColors.length === 0
      ? ''
      : `現在の修正: ${JSON.stringify(elements.labelName.value.trim() || '<ファイル名>')}: ` +
        `${JSON.stringify(correctedColors)}\n\n`;

  elements.labelJson.textContent =
    count === 0 && correctedColors.length === 0
      ? '（バンドを検出すると表示されます）'
      : `${current}${formatLabels(savedLabels)}`;
}

/** 現在の修正内容を保存済みラベルに追加する。 */
function saveCurrentLabel(): void {
  const name = elements.labelName.value.trim();
  if (name === '' || correctedColors.length === 0) {
    elements.copyStatus.textContent = 'ファイル名とバンドが必要です';
    return;
  }
  savedLabels = { ...savedLabels, [name]: [...correctedColors] };
  saveLabels(savedLabels);
  elements.copyStatus.textContent = `${name} を保存しました`;
  renderLabelJson();
}

/**
 * 学習済みパレットを読み込む。
 *
 * dev では vite.config.ts のプラグインが隣の作業用リポジトリの
 * sample/palette.json を配信し、本番では public/ に置いたコピーが配信される。
 * パスを相対にしているのは、GitHub Pages のプロジェクトページのように
 * サブパス配下に置かれても引けるようにするため。
 */
async function loadPaletteFromServer(): Promise<void> {
  try {
    const response = await fetch('./palette.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as { colors?: Record<string, LabColor> };
    const colors = parsed.colors ?? {};
    const count = Object.keys(colors).length;
    if (count === 0) {
      elements.engineStatus.textContent = '共有パレット: なし（既定の基準色）';
      return;
    }
    palette = withOverrides(DEFAULT_PALETTE, colors as Parameters<typeof withOverrides>[1]);
    elements.engineStatus.textContent = `共有パレット: ${count} 色を適用中`;
  } catch {
    elements.engineStatus.textContent = '共有パレット: なし（既定の基準色）';
  }
}

function renderReading(result: AnalysisResult): void {
  const text = formatReading(result.reading);
  elements.reading.textContent = text;
  elements.stickyReading.textContent = text;

  // 「?」だけだと理由が分からないので、何と読めたか・なぜ出さないかを添える
  if (result.reading === null) {
    elements.readingNote.textContent =
      result.bands.length === 0 ? 'バンドを検出できません' : '値として解釈できません';
  } else if (result.reading.confidence < MIN_REPORTABLE_CONFIDENCE) {
    elements.readingNote.textContent =
      `確信度 ${formatConfidence(result.reading.confidence)} が低いため未確定` +
      `（候補 ${formatOhms(result.reading.ohms)}）`;
  } else {
    elements.readingNote.textContent = `確信度 ${formatConfidence(result.reading.confidence)}`;
  }

  const rows: [string, string][] = [];
  if (result.reading !== null) {
    const reading = result.reading;
    const suppressed =
      reading.confidence < MIN_REPORTABLE_CONFIDENCE
        ? `（閾値未満: ${formatOhms(reading.ohms)}）`
        : '';
    rows.push(
      ['確信度', `${formatConfidence(reading.confidence)}${suppressed}`],
      ['読み取り方向', reading.direction],
      ['E系列', reading.series],
      ['スナップ前', `${reading.rawOhms} Ω`],
    );
    if (reading.tempCoefficient !== null) {
      rows.push(['温度係数', `${reading.tempCoefficient} ppm/K`]);
    }
  }
  if (result.anchor !== null) rows.push(['本体色アンカー', formatLab(result.anchor)]);

  elements.readingDetail.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    elements.readingDetail.append(dt, dd);
  }
}

function formatLab(lab: LabColor): string {
  return `L* ${lab.l.toFixed(1)} / a* ${lab.a.toFixed(1)} / b* ${lab.b.toFixed(1)}`;
}

async function loadFile(file: File): Promise<void> {
  stopCamera();
  statusParts.input = `${file.name} を読み込み中…`;
  renderStatus();
  const decoded = await decodeImageFile(file);
  elements.labelName.value = file.name;
  statusParts.input =
    `${file.name}（${decoded.format.toUpperCase()}` + (decoded.converted ? '・変換済' : '') + '）';
  renderStatus();
  setSource(decoded.canvas);
}

/** 画像かカメラが載っていれば、下部の固定バーを出す。 */
function updateStickyBar(): void {
  elements.stickyBar.hidden = source === null;
}

function stopCamera(): void {
  camera?.stop();
  camera = null;
  cameraControlsHandle?.clear();
  cameraControlsHandle = null;
  if (mode === 'live') applyMode('idle');
  statusParts.input = '';
  statusParts.performance = '';
  renderStatus();
  void releaseWakeLock();
}

/** カメラ一覧をプルダウンに反映する（ラベルは権限取得後でないと空になる）。 */
async function refreshCameraList(): Promise<void> {
  const cameras = await listCameras();
  elements.cameraSelect.replaceChildren();
  cameras.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label === '' ? `カメラ ${index + 1}` : device.label;
    elements.cameraSelect.append(option);
  });
  const preferred = pickPreferredCamera(cameras);
  if (preferred !== null) elements.cameraSelect.value = preferred.deviceId;
}

async function beginCamera(deviceId?: string, options: { macro?: boolean } = {}): Promise<void> {
  stopCamera();
  statusParts.input = 'カメラを起動中…';
  statusParts.performance = '';
  renderStatus();

  try {
    camera = await startCamera({
      videoElement: elements.liveVideo,
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(options.macro === true ? { exactEnvironment: true } : {}),
      onFrame: analyzeLiveFrame,
      onStats: (stats, analysisPx) => {
        statusParts.performance = `${stats.fps.toFixed(1)}fps ${stats.meanMs.toFixed(0)}ms ${analysisPx}px`;
        renderStatus();
      },
      onError: (error) => {
        console.error(error);
      },
    });
  } catch (error) {
    statusParts.input = describeCameraError(error);
    renderStatus();
    elements.emptyError.textContent = describeCameraError(error);
    applyMode('idle');
    return;
  }

  elements.emptyError.textContent = '';
  smoother = createSmoother();
  lastReadingText = '?';
  applyMode('live');
  void requestWakeLock();
  const { status } = camera;
  statusParts.input = `${status.label} ${status.width}×${status.height}`;
  renderStatus();
  elements.engineStatus.textContent =
    (elements.engineStatus.textContent ?? '') +
    (status.manualColorLocked ? ' / WB・露出を固定できました' : ' / WB・露出は自動（固定不可）');
  await refreshCameraList();
  await setupCameraControls();
}

/**
 * トーチ・ズーム・接写のボタン行を capability に応じて出す。
 * ラベル（超広角の検出に使う）は権限取得後でないと空なので、カメラが
 * 起動してから呼ぶ。非対応の端末では行ごと出ない（それが正常）。
 */
async function setupCameraControls(): Promise<void> {
  if (camera === null) return;
  const track = camera.track;
  const capabilities = readCameraCapabilities(track);
  ultraWideId = await findUltraWideDeviceId();

  cameraControlsHandle = renderCameraControls(
    elements.cameraControls,
    capabilities,
    ultraWideId !== null,
    {
      onTorch: (on) => (camera === null ? Promise.resolve(false) : applyTorch(camera.track, on)),
      onZoom: async (level) => {
        if (camera !== null) await applyZoom(camera.track, level);
      },
      onMacro: (on) => toggleMacro(on),
    },
  );
}

/**
 * 接写（超広角レンズ）の切替。
 *
 * レンズの変更はトラックの開き直しが必要（トーチ・ズームと違い
 * applyConstraints では効かない）。iOS は 2 カメラ同時オープンを拒むため、
 * beginCamera が先に旧トラックを止めてから開く。開いた後に前面カメラへ
 * 誤解決されていないか検証し、駄目なら通常の背面カメラへ戻す。
 */
async function toggleMacro(on: boolean): Promise<void> {
  if (!on || ultraWideId === null) {
    await beginCamera();
    return;
  }

  await beginCamera(ultraWideId, { macro: true });
  if (camera === null || isFrontFacing(camera.track)) {
    await beginCamera(); // 超広角を開けなかった。通常の背面カメラで続ける
    return;
  }

  // 超広角は 0.5x 相当で画角が広すぎるので、1x 近くへクロップし直す
  await applyNearFocusZoom(camera.track);
  cameraControlsHandle?.setMacro(true);
  cameraControlsHandle?.setZoom(NEAR_FOCUS_ZOOM);
}

/**
 * クリップボードへコピーする。失敗したら手動選択できるよう表示に落とす。
 * iOS Safari はユーザー操作の文脈から外れると writeText を拒否するため、
 * 「コピーできない」で終わらせず必ず取り出せる経路を残す。
 */
function copyOrShow(text: string, target: HTMLElement, status: HTMLElement): void {
  const fallback = (): void => {
    target.textContent = text;
    status.textContent = 'コピーできなかったので下に表示しました（長押しで選択）';
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  if (typeof navigator.clipboard?.writeText !== 'function') {
    fallback();
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      status.textContent = 'コピーしました';
    },
    fallback,
  );
}

function learnFromCurrent(): void {
  if (lastResult === null || lastResult.runs.length === 0) {
    elements.learnStatus.textContent = '先に抵抗を検出してください';
    return;
  }

  const ohms = parseOhms(elements.learnValue.value);
  if (ohms === null) {
    elements.learnStatus.textContent = '値を解釈できません（例: 4.7k, 220, 1M）';
    return;
  }
  const toleranceRaw = elements.learnTolerance.value;
  const tolerance = toleranceRaw === 'none' ? null : Number.parseFloat(toleranceRaw);

  const match = matchRunsToValue(
    lastResult.runs.map((run) => ({ lab: run.lab, start: run.start, end: run.end })),
    ohms,
    tolerance,
    activePalette() ?? DEFAULT_PALETTE,
  );
  if (match === null) {
    elements.learnStatus.textContent =
      'この値のバンド列と対応付けできませんでした（バンド数を確認してください）';
    return;
  }
  if (match.cost > MAX_LEARN_COST) {
    elements.learnStatus.textContent =
      `対応付けの確度が低いため学習しません（コスト ${match.cost.toFixed(1)}）。映りを変えて再試行してください`;
    return;
  }

  observations = addObservations(observations, match.assignments);
  saveObservations(observations);
  const note = match.toleranceObserved ? '' : '（許容差バンドは検出できず、数字・倍率のみ）';
  elements.learnStatus.textContent =
    `学習しました: ${match.sequence.join('-')}${note}`;
  renderLearnCounts();
  analyzeSelection(); // 学習直後のパレットで読み直す
}

elements.learnButton.addEventListener('click', learnFromCurrent);

elements.stickyLearn.addEventListener('click', () => {
  // 入力欄が畳まれた位置にあってもすぐ打てるように、まず focus を移す
  if (elements.learnValue.value.trim() === '') {
    elements.learnValue.scrollIntoView({ behavior: 'smooth', block: 'center' });
    elements.learnValue.focus();
    return;
  }
  learnFromCurrent();
});

elements.learnValue.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') learnFromCurrent();
});

elements.learnExport.addEventListener('click', () => {
  const text = JSON.stringify(
    { generatedFrom: 'browser learning', colors: paletteOverrides(observations) },
    null,
    2,
  );
  copyOrShow(text, elements.labelJson, elements.learnStatus);
});

elements.learnClear.addEventListener('click', () => {
  observations = {};
  clearObservations();
  renderLearnCounts();
  elements.learnStatus.textContent = '学習データを消去しました';
  analyzeSelection();
});

elements.cameraButton.addEventListener('click', () => {
  if (camera !== null) {
    stopCamera();
    return;
  }
  void beginCamera();
});

elements.captureButton.addEventListener('click', () => {
  if (camera === null || source === null) return;
  // 現在のフレームを複製してから止める。止めた後も解析・ラベル付けを続けられる。
  const frozen = document.createElement('canvas');
  frozen.width = source.width;
  frozen.height = source.height;
  context2d(frozen).drawImage(source, 0, 0);
  stopCamera();
  elements.labelName.value = '';
  statusParts.input = 'カメラ静止画';
  renderStatus();
  setSource(frozen);
});

elements.cameraSelect.addEventListener('change', () => {
  void beginCamera(elements.cameraSelect.value);
});

elements.fileInput.accept = SUPPORTED_ACCEPT;

elements.fileInput.addEventListener('change', () => {
  const file = elements.fileInput.files?.[0];
  if (file === undefined) return;
  loadFile(file).catch((error: unknown) => {
    console.error(error);
    statusParts.input = `読み込めませんでした: ${String(error)}`;
    renderStatus();
  });
});

/** 画像選択は隠した input を代理で押す（見た目を揃えるため）。 */
elements.pickFile.addEventListener('click', () => {
  elements.fileInput.click();
});

elements.sampleButton.addEventListener('click', () => {
  stopCamera();
  statusParts.input = '合成サンプル';
  renderStatus();
  setSource(createSampleCanvas());
});

/** 入力をやり直す。空状態に戻して選び直せるようにする。 */
elements.resetButton.addEventListener('click', () => {
  stopCamera();
  source = null;
  detectedBox = null;
  lastResult = null;
  applyMode('idle');
  elements.fileInput.value = '';
  statusParts.input = '';
  statusParts.detection = '';
  renderStatus();
  updateStickyBar();
  elements.reading.textContent = '?';
  elements.stickyReading.textContent = '?';
  elements.readingNote.textContent = '';
});

elements.adaptToggle.addEventListener('change', analyzeSelection);

elements.labelName.addEventListener('input', renderLabelJson);

elements.autoToggle.addEventListener('change', analyzeSelection);

elements.saveLabel.addEventListener('click', saveCurrentLabel);

elements.clearLabels.addEventListener('click', () => {
  savedLabels = {};
  saveLabels(savedLabels);
  elements.copyStatus.textContent = '保存済みラベルを消去しました';
  renderLabelJson();
});

elements.copyLabel.addEventListener('click', () => {
  copyOrShow(formatLabels(savedLabels), elements.labelJson, elements.copyStatus);
});

elements.sourceCanvas.addEventListener('pointerdown', (event) => {
  if (source === null) return;
  elements.sourceCanvas.setPointerCapture(event.pointerId);
  dragStart = pointerToCanvas(elements.sourceCanvas, event);
});

elements.sourceCanvas.addEventListener('pointermove', (event) => {
  if (dragStart === null) return;
  const current = pointerToCanvas(elements.sourceCanvas, event);
  selection = {
    x: Math.min(dragStart.x, current.x),
    y: Math.min(dragStart.y, current.y),
    width: Math.abs(current.x - dragStart.x),
    height: Math.abs(current.y - dragStart.y),
  };
  redrawSource();
});

elements.sourceCanvas.addEventListener('pointerup', (event) => {
  if (dragStart === null) return;
  elements.sourceCanvas.releasePointerCapture(event.pointerId);
  dragStart = null;
  analyzeSelection();
});

/**
 * タブが背面に回るとカメラのストリームは止まり、Wake Lock も解除される。
 * 復帰時に取り直す（iOS Safari では特に顕著）。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (camera === null) return;
  void requestWakeLock();
  if (camera.video.paused) void camera.video.play().catch(() => undefined);
});

void loadPaletteFromServer();
renderLabelJson();
renderLearnCounts();

/**
 * 既定でカメラを開く（権限プロンプトはロード直後に出る）。
 * 拒否・カメラなし・HTTP のときは空状態に戻り、ボタンから静止画も選べる。
 * NotAllowedError 後の再試行はボタン経由（iOS Safari はユーザー操作の
 * 文脈の方が成功しやすい）。
 */
function canAutoStart(): boolean {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

if (canAutoStart()) {
  void beginCamera();
} else {
  elements.emptyError.textContent = 'カメラは HTTPS か localhost でしか使えません。';
}
