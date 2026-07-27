# ohm-lens

ハードウェア・電子工作プロジェクト。

Author: [tommie.jp](https://tommie.jp) ([@tommie-jp](https://github.com/tommie-jp))

> **Status**: 初期化直後。概要・回路・実装の詳細はこれから記述する。

## 概要

TODO: このプロジェクトが何を作るものかを記述する。

## リポジトリ構成

| パス | 内容 |
| ------ | ------ |
| `docs/` | 設計メモ、検討事項、部品選定、測定結果 |
| `diagrams/` | 回路図・ブロック図（PlantUML ソースと生成 PNG） |
| `CHANGELOG.md` | 変更履歴 |

## 開発メモ

- 図は PlantUML で管理する。`.puml` を編集したら PNG を再生成する。

  ```bash
  cd diagrams && plantuml *.puml
  ```

- 末尾が `-ignore.md` のファイルはローカル専用メモで、git 管理外。
