#!/usr/bin/env bash
#
# 抵抗器の検出をバッチでデバッグする。
#
# sample/ の写真を 1 枚ずつ検出・解析し、元画像に結果を焼き込んだ画像を
# sample-detect/ に出力する。焼き込む内容:
#   - 抵抗器を囲む赤い回転四角形
#   - 各バンドの色名（赤・白・茶 …）
#   - そのバンドのカラーコード上の意味（0 / 1 / ×10 / ±5% …）
#
#   使い方:
#     ./doDetect.sh              全件
#     ./doDetect.sh 11           ファイル名に "11" を含むものだけ
#     ./doDetect.sh --clean      出力先を空にしてから実行
#     ./doDetect.sh --ascii      日本語フォントが無い環境向け（英字表示）
#
# 意味ラベルは「デコーダがそう解釈した」結果であって正解ではない。
# 誤読のときは間違った解釈がそのまま出る。それを見るための道具。
set -euo pipefail

cd "$(dirname "$0")"

readonly IN_DIR="${IN_DIR:-../sample}"
readonly OUT_DIR="${OUT_DIR:-../sample-detect}"

if [ ! -d node_modules ]; then
  printf '\033[31m✗\033[0m 依存が入っていません。先に npm install を実行してください。\n' >&2
  exit 1
fi

if [ ! -d "${IN_DIR}" ]; then
  printf '\033[31m✗\033[0m 入力ディレクトリがありません: %s\n' "${IN_DIR}" >&2
  exit 1
fi

printf '\033[36m▶\033[0m 検出デバッグを開始します\n\n'

# 実処理は TypeScript 側（scripts/detect.ts）。core の関数をそのまま呼ぶ。
# 1 枚の失敗で止めないので、失敗があっても exit 0 で終える（可視化が仕事）。
npx tsx scripts/detect.ts --in "${IN_DIR}" --out "${OUT_DIR}" "$@"
