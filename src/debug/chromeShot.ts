/**
 * 画面の作り物（バージョン・占有率グラフ・読み値・ボタン）を画像に焼く。
 *
 * スクリーンショットは映像とオーバーレイ canvas しか合成できなかった。
 * ボタンや数値は DOM なので、`html-to-image`（SVG の foreignObject に
 * DOM を埋めて描く）でラスタライズして重ねる。
 *
 * **ラスタライズは非同期。** 保存（共有シート・ダウンロード）はユーザー操作の
 * 文脈からしか呼べないので、撮影の瞬間に待つわけにいかない
 * （`saveTarget.ts` の注意書き）。押し込みの時点で焼き始めておき、指を離す
 * までに間に合ったものだけを使う。間に合わなければ映像とオーバーレイだけで
 * 保存する（撮れないより、作り物が写らないほうがまし）。
 */

/** 焼き上がりを待つ引き換え券。撮影時に `canvas` を見て、あれば使う。 */
export interface ChromeShot {
  /** 焼き上がった画像。まだなら null。 */
  canvas: HTMLCanvasElement | null;
}

/**
 * 焼いている間だけ付けるクラス。背景色を透ける（style.css 側）。
 * 塗ったまま焼くと、映像の上に重ねたときに実写が真っ黒に潰れる。
 */
const CAPTURING_CLASS = 'capturing';

/**
 * 焼くのに使うモジュール。**撮影のときしか要らないので動的に読む**
 * （起動時のバンドルに載せると 13kB ぶん、使わない人まで払うことになる）。
 */
let loader: Promise<typeof import('html-to-image')> | null = null;

/**
 * モジュールを先に取っておく。ライブを開いた時点で呼ぶ。
 *
 * 押し込みから読み始めると、初回だけ取得の待ちが焼き上がりに乗って
 * 「間に合わなかった」になりやすい。
 */
export function preloadChromeShot(): void {
  loader ??= import('html-to-image');
}

/**
 * 画面の作り物を焼き始める。返り値はその場で使える器で、
 * 焼き上がると `canvas` が埋まる。
 *
 * @param node 焼く範囲（ライブ表示の全体。ボタン行まで含める）
 */
export function captureChrome(node: HTMLElement): ChromeShot {
  const shot: ChromeShot = { canvas: null };

  preloadChromeShot();
  document.body.classList.add(CAPTURING_CLASS);

  void (loader as Promise<typeof import('html-to-image')>)
    .then(({ toCanvas }) =>
      toCanvas(node, {
        // 映像は foreignObject では描けない（空になる）。下に敷いた実写を
        // そのまま見せたいので、初めから対象から外す
        filter: (target) => !(target instanceof HTMLVideoElement),
        // 端末の画素密度は無視する。出力は映像の解像度に合わせて伸ばすので、
        // ここで倍率を上げても最終画質は変わらず、焼く時間だけ延びる
        pixelRatio: 1,
      }),
    )
    .then(
      (canvas) => {
        shot.canvas = canvas;
      },
      (error: unknown) => {
        // 作り物が写らないだけで撮影自体は続けられる
        console.warn('画面の作り物を焼けませんでした', error);
      },
    )
    .finally(() => {
      document.body.classList.remove(CAPTURING_CLASS);
    });

  return shot;
}
