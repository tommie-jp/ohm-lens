#!/usr/bin/env bash
#
# OhmLens のデバッグページを Tailscale 経由で公開する。
#
# カメラ（getUserMedia）は secure context でしか動かないので、素の HTTP で
# Tailscale IP を叩いても使えない。tailscale serve に HTTPS を終端させて
# ローカルの Vite に中継することで、スマホの実機からもカメラを試せるようにする。
#
#   使い方:  ./doStart.sh [ポート]
#   終了:    Ctrl+C（serve の設定はこのスクリプトが張った分だけ自動で戻す）
#
set -euo pipefail

cd "$(dirname "$0")"

# Vite を待ち受けさせるローカルポート。外には出さない。
readonly VITE_PORT="${VITE_PORT:-5173}"

# tailnet 側で公開する HTTPS ポート。tailscale serve が使えるのは
# 443 / 8443 / 10000 の 3 つ。他の用途と衝突しないよう既定は 10000。
readonly SERVE_PORT="${1:-${SERVE_PORT:-10000}}"

log() { printf '\033[36m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- 前提の確認 -------------------------------------------------------------

command -v tailscale >/dev/null 2>&1 || die 'tailscale が見つかりません。'

if ! tailscale status >/dev/null 2>&1; then
  die 'Tailscale が動いていません。`tailscale up` を実行してください。'
fi

readonly HOSTNAME_TS="$(tailscale status --json | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
[ -n "$HOSTNAME_TS" ] || die 'Tailscale のホスト名を取得できませんでした。'

# 他の用途で既に使われているポートを奪わない
if tailscale serve status --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin) or {}; sys.exit(0 if '${SERVE_PORT}' in (d.get('TCP') or {}) else 1)"; then
  die "ポート ${SERVE_PORT} は既に tailscale serve で使われています。
別のポートを指定してください（例: ./doStart.sh 8443）。
現在の設定は \`tailscale serve status\` で確認できます。"
fi

readonly URL="https://${HOSTNAME_TS}:${SERVE_PORT}/"

# 既に誰かが Vite のポートを使っていると、起動失敗に気づかないまま
# その別プロセスを公開してしまう。先に空きを確かめる。
if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${VITE_PORT}/" 2>/dev/null; then
  die "ポート ${VITE_PORT} は既に使われています。
先に停止するか、VITE_PORT=5174 ./doStart.sh のように別ポートを指定してください。"
fi

# --- 後始末 -----------------------------------------------------------------

cleanup() {
  local status=$?
  log 'serve の設定を戻しています…'
  # このスクリプトが張った分だけを取り消す。他の設定には触れない。
  tailscale serve --https="${SERVE_PORT}" off >/dev/null 2>&1 || true
  if [ -n "${VITE_PID:-}" ]; then
    # npm は実際の vite を孫プロセスとして起動するので、PID を kill しても
    # 孫が生き残る。setsid で独立したプロセスグループにしてあるため、
    # PID を負にしてグループごと落とす。
    kill -TERM -"${VITE_PID}" 2>/dev/null || kill "${VITE_PID}" 2>/dev/null || true
    wait "${VITE_PID}" 2>/dev/null || true
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

# --- 起動 -------------------------------------------------------------------

log "Vite を 127.0.0.1:${VITE_PORT} で起動します"
# 独立したプロセスグループで起動する。終了時にグループごと落とせるようにするため。
setsid npm run dev -- --port "${VITE_PORT}" --strictPort --host 127.0.0.1 &
VITE_PID=$!

# 立ち上がるまで待つ（最大 30 秒）。自分が起動した Vite が生きていることも見る。
vite_ready=0
for _ in $(seq 60); do
  if ! kill -0 "${VITE_PID}" 2>/dev/null; then
    die 'Vite が起動直後に終了しました。上のログを確認してください。'
  fi
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${VITE_PORT}/"; then
    vite_ready=1
    break
  fi
  sleep 0.5
done
[ "${vite_ready}" -eq 1 ] || die "Vite が ${VITE_PORT} で応答しません。"

log "tailscale serve で HTTPS を終端します（:${SERVE_PORT}）"
tailscale serve --bg --https="${SERVE_PORT}" "http://127.0.0.1:${VITE_PORT}" >/dev/null

printf '\n  \033[32m●\033[0m OhmLens が tailnet に出ました\n\n'
printf '      %s\n\n' "${URL}"
printf '  同じ tailnet の端末（スマホなど）からこの URL を開けます。\n'
printf '  HTTPS なので\033[1mカメラも使えます\033[0m。\n\n'
printf '  終了するには Ctrl+C を押してください。\n\n'

# Vite が終わるまで待つ（Ctrl+C は trap が拾う）
wait "${VITE_PID}"
