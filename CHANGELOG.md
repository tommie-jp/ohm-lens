# Changelog

このプロジェクトの変更履歴。

## [Unreleased]

### Phase 0 実装（Step 0-1〜0-6）

- Vite + TypeScript + Vitest + ESLint のスキャフォールドと GitHub Actions CI
- `core/` に色帯解析パイプラインを実装（DOM 非依存、Worker でそのまま使える）
  - `color/` — sRGB↔Lab65 変換、ΔE2000、基準色テーブル、本体色アンカーによる
    色順応補正
  - `bands/` — 1D カラープロファイル抽出（列ごとの中央値）、本体色除去と
    ランのラベリング、Lab + ΔE2000 分類
  - `value/` — IEC 60062 カラーコード表、E24/E96 スナップ、読み取り方向判定、
    バンド列デコード
- 静止画デバッグページ（`src/debug/`）— 各段階の可視化と合成サンプル生成
- 確信度が閾値未満のときは値を出さず「?」を表示する（設計メモ §2 [5]）
- テスト 215 件、カバレッジ 99.6%

### セットアップ

- リポジトリ初期化（README / CLAUDE.md / ディレクトリ構成）
- MIT ライセンスを追加
- 設計メモ `docs/01-設計.md` を取り込み、README / CLAUDE.md を OhmLens の
  実内容（ブラウザ完結の Web アプリ）に合わせて更新
- 実装計画 `docs/02-実装計画.md` を追加（Phase 0 の TDD タスク分解、
  リポジトリ構成、出口条件、リスク）
- アーキテクチャ・ライブラリ検証レビュー（2026-07-27）を設計メモに反映：
  WB ロック非対応環境（Safari）向けの相対色分類、OpenCV.js の Phase 0 限定化、
  YOLO26 NMS-free、E系列スナップ順序、WebGPU Baseline 到達
