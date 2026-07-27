# OhmLens

Web カメラに映した抵抗器の抵抗値を、リアルタイムで映像にオーバーレイ表示する Web アプリ。

Author: [tommie.jp](https://tommie.jp) ([@tommie-jp](https://github.com/tommie-jp))

- **当面の URL**: `https://ohmlens.tommie.jp`
- **方針**: ブラウザ完結（クライアントサイド推論）、サーバ不要
- **Status**: Phase 0（色帯解析コアロジック）着手前

## 仕組み

「**NN で位置を検出** → **古典 CV で色帯を読む**」のハイブリッド 2 段パイプライン。
値の算出を決定的アルゴリズムにすることで、精度とデバッグ性を両立する。

```text
getUserMedia
  └→ requestVideoFrameCallback でフレーム取得
      └→ createImageBitmap → Worker へ transfer
          ├→ [1] 物体検出   : ONNX Runtime Web + YOLO(OBB)
          ├→ [2] 回転補正   : OpenCV.js warpAffine
          ├→ [3] 色帯解析   : Lab + ΔE2000 最近傍
          └→ [4] 値の確定   : 方向判定 → E24/E96 スナップ
              └→ postMessage でメインスレッドへ
                  ├→ [5] トラッキング : IoU マッチング + 時間方向多数決
                  └→ [6] 描画        : <video> + 重ねた <canvas>
```

| スレッド | 担当 | 頻度 |
| ---------- | ------ | ------ |
| メイン | 映像表示、Canvas オーバーレイ、トラッキング | 60fps |
| Worker | 物体検出、色帯解析 | 5〜10fps |

## 技術スタック

| 用途 | 採用 |
| ------ | ------ |
| 映像取得 | WebRTC `getUserMedia` / `requestVideoFrameCallback` |
| 推論 | [onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/)（WebGPU / WASM EP） |
| 古典 CV | [@techstark/opencv-js](https://github.com/TechStark/opencv-js)（Phase 0 限定。以降は OffscreenCanvas 2D で代替） |
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

**Phase 0 を飛ばさないこと。** 最初から YOLO を入れると、精度が出ないときに検出が悪いのか色判定が悪いのかを切り分けられなくなる。

## リポジトリ構成

| パス | 内容 |
| ------ | ------ |
| [docs/01-設計.md](docs/01-設計.md) | 設計メモ（アーキテクチャ、ライブラリ選定、ホスティング、ネーミング調査） |
| [docs/02-実装計画.md](docs/02-実装計画.md) | 実装計画（Phase 0 のタスク分解、リポジトリ構成、リスク） |
| `diagrams/` | ブロック図・状態遷移図（PlantUML ソースと生成 PNG） |
| [CHANGELOG.md](CHANGELOG.md) | 変更履歴 |

## ライセンス

[MIT](LICENSE) © 2026 tommie.jp
