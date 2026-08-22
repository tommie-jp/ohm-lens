# OhmLens

> [!WARNING]
> **本プロジェクトはまだ実験中で、実用レベルに達していません。**
> 読み取り結果は怪しいです。

Web カメラに映した抵抗器の抵抗値を、リアルタイムで映像にオーバーレイ表示する Web アプリ。

Author: [tommie.jp](https://tommie.jp) ([@tommie-jp](https://github.com/tommie-jp))

- **公開先**: [tommie-jp.github.io/ohm-lens](https://tommie-jp.github.io/ohm-lens/)
- **方針**: ブラウザ完結（クライアントサイド推論）、サーバ不要
- **Status**: Phase 0（静止画での色帯読み取り）を実装中

## 開発

```bash
npm install
npm run dev        # デバッグページ（カメラ / 画像ファイル / 合成サンプルで解析）
npm test           # 単体テスト
npm run coverage   # カバレッジ（core/ を対象、閾値 80%）
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
```

カメラは HTTPS か localhost でのみ使えます（secure context 必須）。
スマホの実機で試すときは HTTPS で配信してください（`./doStart.sh` は
Tailscale で HTTPS 配信するための補助スクリプトです）。

公開は `./doDeploy.sh` が行います（手元で検証 → push → GitHub Actions で
ビルド・配信）。`--dry-run` で push の直前まで確認できます。

## 対応する画像形式

| 形式 | ブラウザ | Node（テスト） |
| ------ | ---------- | ---------------- |
| JPEG / PNG / WebP / GIF / AVIF | ✅ 標準機能 | ✅ sharp |
| HEIC / HEIF | ✅ WASM デコーダを動的読み込み | ✅ sharp |
| TIFF | ❌ 非対応（明示エラー） | ✅ sharp |

形式は拡張子ではなく**マジックバイト**で判定します。HEIC のデコーダ
（libheif の WASM、約 3MB）は HEIC を選んだときだけ読み込みます。

## 値で学習（基準色の較正）

映っている抵抗の**正解値をタイプするだけ**で基準色を較正できます。

1. カメラで抵抗を映す（または写真を読み込む）
2. 「値で学習」に値を入力（`4.7k` `220` `1M` `4k7` など）、許容差を選ぶ
3. 「この値で学習」を押す

値から逆算したバンド列を検出結果に対応付け、色ごとの実写 Lab を蓄積します。
3 件たまった色から基準色が実写側に置き換わり、その場で読み取りに反映されます。
学習データは localStorage に残ります。

## スマホとカメラ

- 640px 以下では縦一列のレイアウトになり、結果と学習ボタンが画面下部の
  固定バーに出ます
- 解析は 8fps まで間引き、長辺 800px に縮小してから処理します。負荷は
  自動調整され、実測値（fps / 処理時間 / 解析解像度）を画面上部に出します
- 画面消灯を抑止し（Screen Wake Lock）、タブ復帰時にカメラを取り直します
- 背面カメラを優先し、複数ある場合はプルダウンで切り替えられます

## 検出のデバッグ（doDetect.sh）

```bash
./doDetect.sh -h    # 説明（オプションと出力内容の一覧）
```

検体画像に検出結果（抵抗器の回転四角形・各バンドの枠と番号・バンド一覧表・
中心線プロファイル・色空間の平面図）を焼き込んだ画像と、1 行 1 枚のサマリを
出力します。さらに細かく見るための単発スクリプトは `scripts/dbg*.ts` にあります。

## 仕組み

「**NN で位置を検出** → **古典 CV で色帯を読む**」のハイブリッド 2 段パイプライン。
値の算出を決定的アルゴリズムにすることで、精度とデバッグ性を両立します。

```text
getUserMedia
  └→ requestVideoFrameCallback でフレーム取得
      └→ Worker へ transfer
          ├→ [1] 物体検出   : ONNX Runtime Web + YOLO(OBB)
          ├→ [2] 回転補正   : OpenCV.js warpAffine
          ├→ [3] 色帯解析   : Lab + ΔE2000 最近傍
          └→ [4] 値の確定   : 方向判定 → E24/E96 スナップ
              └→ postMessage でメインスレッドへ
                  ├→ [5] トラッキング : IoU マッチング + 時間方向多数決
                  └→ [6] 描画        : <video> + 重ねた <canvas>
```

## 技術スタック

| 用途 | 採用 |
| ------ | ------ |
| 映像取得 | WebRTC `getUserMedia` / `requestVideoFrameCallback` |
| 推論 | [onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/)（WebGPU / WASM EP） |
| 古典 CV | [@techstark/opencv-js](https://github.com/TechStark/opencv-js)（Phase 0 限定） |
| モデル学習 | [Ultralytics YOLO](https://docs.ultralytics.com/)（detect / obb） |
| 色差計算 | [culori](https://culorijs.org/)（Lab / ΔE2000） |
| トラッキング | 自前 IoU 実装 |

## 開発ロードマップ

| Phase | 内容 | ねらい |
| ------- | ------ | -------- |
| 0 | 静止画 1 枚を OpenCV.js のみで処理（白背景・水平配置前提） | 色帯読み取りロジックを完成させる |
| 1 | リアルタイム化（単一抵抗器） | パイプラインとフレーム同期の確立 |
| 2 | 複数対応 + トラッキング + 時間方向投票 | 表示の安定化 |
| 3 | YOLO(OBB) 導入 | 任意背景・任意角度への対応 |
| 4 | PWA 化、WebGPU 最適化、モデル量子化 | 実用速度とオフライン動作 |

## ドキュメント

- [docs/](docs/) — 設計メモ、実装計画、検討・計測の記録（番号順）
- [CHANGELOG.md](CHANGELOG.md) — 変更履歴

## ライセンス

[MIT](LICENSE) © 2026 tommie.jp
