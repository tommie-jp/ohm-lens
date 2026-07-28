/**
 * OhmLens 全体で共有する型定義。
 * core/ は DOM に依存しないため、ここでも DOM 型は使わない。
 */

/** 抵抗カラーコードの色名。本体色（背景として除去する対象）を含む。 */
export type BandColor =
  | 'black'
  | 'brown'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'violet'
  | 'grey'
  | 'white'
  | 'gold'
  | 'silver';

/** 抵抗器の本体色。バンドではなく背景として扱う。 */
export type BodyColor = 'beige' | 'lightblue' | 'greywhite' | 'olive';

/** CIELAB (D65) の色。culori の Lab オブジェクトと相互変換する。 */
export interface LabColor {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** 1D カラープロファイルの 1 サンプル（ROI 長軸方向の 1 列ぶん）。 */
export interface ProfileSample {
  /** ROI 長軸方向の位置（0 が左端） */
  readonly x: number;
  readonly lab: LabColor;
}

/** 分類済みのバンド 1 本。 */
export interface Band {
  readonly color: BandColor;
  /** ROI 長軸方向の開始位置（含む） */
  readonly start: number;
  /** ROI 長軸方向の終了位置（含まない） */
  readonly end: number;
  /**
   * 分類の確信度 0..1。最近傍色との ΔE2000 と次点との差から算出する。
   * 1 に近いほど確実。
   */
  readonly confidence: number;
}

/** E 系列。許容差バンドから決定する。 */
export type ESeries = 'E24' | 'E96';

/** 読み取り方向。バンド列を左右どちらから読むか。 */
export type ReadDirection = 'ltr' | 'rtl';

/** 抵抗値の読み取り結果。 */
export interface ResistorReading {
  /** 抵抗値 [Ω]。E 系列スナップ後の値。 */
  readonly ohms: number;
  /** 許容差 [%]。許容差バンドが無い場合は null。 */
  readonly tolerance: number | null;
  /** 温度係数 [ppm/K]。6 バンドのときのみ。 */
  readonly tempCoefficient: number | null;
  /** 読み取り方向 */
  readonly direction: ReadDirection;
  /** 全体の確信度 0..1 */
  readonly confidence: number;
  /** スナップに使った E 系列 */
  readonly series: ESeries;
  /** スナップ前の生の値 [Ω]。較正とデバッグ用。 */
  readonly rawOhms: number;
}
