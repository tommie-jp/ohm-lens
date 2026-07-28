#!/usr/bin/env bash
#
# OhmLens を GitHub Pages へ公開する。
#
# 実際のビルドとアップロードは GitHub Actions（.github/workflows/pages.yml）が
# 行う。このスクリプトがやるのは、その前後の面倒を引き受けること:
#
#   1. 公開してよい状態か確かめる（ブランチ・作業ツリー・Pages の設定）
#   2. 非公開リポジトリ側の学習パレットを公開ビルドへ同期する
#   3. 手元で typecheck / lint / test / build を通す（通らなければ push しない）
#   4. push して、Actions の完了を見届け、公開 URL が本当に応答するか叩く
#
# push が公開の引き金なので、押し戻せる最後の地点は「3 を通ること」になる。
# 検証を飛ばしたいときだけ --skip-checks を使う。
#
#   使い方:  ./doDeploy.sh [オプション]
#   確認だけ: ./doDeploy.sh --dry-run
#
set -euo pipefail

cd "$(dirname "$0")"

# 公開 URL。カスタムドメイン（ohmlens.tommie.jp）へ移ったらここを変える。
# あわせて src/debug/public/CNAME を置くこと。
readonly PAGES_URL="${PAGES_URL:-https://tommie-jp.github.io/ohm-lens/}"

# 学習パレットの取得元。非公開の作業用リポジトリ側にある。
readonly PALETTE_SRC="${PALETTE_SRC:-../sample/palette.json}"
readonly PALETTE_DEST='src/debug/public/palette.json'

# 公開するブランチ。ここ以外からは流させない。
readonly DEPLOY_BRANCH='main'

# Pages は push から反映まで十数秒かかることがある。この秒数まで待つ。
readonly VERIFY_TIMEOUT=60

log() { printf '\033[36m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
OhmLens を GitHub Pages へ公開します。

  使い方: ./doDeploy.sh [オプション]

  オプション:
    -h, --help        この説明を表示して終了する
        --dry-run     push の直前まで実行して止まる（検証と差分の確認だけ）
        --skip-checks typecheck / lint / test を飛ばす（build は飛ばさない）
        --no-watch    push したら Actions の完了を待たずに終了する
        --no-palette  学習パレットの同期を行わない

  環境変数:
    PAGES_URL         公開 URL（既定: ${PAGES_URL}）
    PALETTE_SRC       パレットの取得元（既定: ${PALETTE_SRC}）

  例:
    ./doDeploy.sh                何を公開するか確かめながら通しで実行
    ./doDeploy.sh --dry-run      push せずに検証とパレット差分だけ見る
    ./doDeploy.sh --skip-checks  CI で検証済みのものを急いで出す

  このスクリプトは勝手に stash / commit --all / force push をしません。
  未コミットの変更があるときは、何もせず止まります。
USAGE
}

# --- 引数 -------------------------------------------------------------------

dry_run=0
skip_checks=0
watch_run=1
sync_palette=1

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --dry-run) dry_run=1 ;;
    --skip-checks) skip_checks=1 ;;
    --no-watch) watch_run=0 ;;
    --no-palette) sync_palette=0 ;;
    *) die "不明なオプション: $1（./doDeploy.sh --help）" ;;
  esac
  shift
done

# --- 前提の確認 -------------------------------------------------------------

log '公開してよい状態か確かめています'

command -v gh >/dev/null 2>&1 || die 'gh が見つかりません。GitHub CLI を入れてください。'
gh auth status >/dev/null 2>&1 || die 'gh がログインしていません。`gh auth login` を実行してください。'
[ -d node_modules ] || die '依存が入っていません。先に npm install を実行してください。'

readonly BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "${BRANCH}" = "${DEPLOY_BRANCH}" ] \
  || die "現在のブランチは ${BRANCH} です。公開は ${DEPLOY_BRANCH} からのみ行えます。"

# 未コミットの変更があると「何を公開したのか」が後から追えなくなる。
# 勝手に stash せず、判断はユーザーに返す。
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  die '未コミットの変更があります。コミットするか元に戻してから実行してください。'
fi

log 'リモートの状態を取得しています'
git fetch --quiet origin "${DEPLOY_BRANCH}"

readonly LOCAL_SHA="$(git rev-parse HEAD)"
readonly REMOTE_SHA="$(git rev-parse "origin/${DEPLOY_BRANCH}")"
readonly BASE_SHA="$(git merge-base HEAD "origin/${DEPLOY_BRANCH}")"

if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ] && [ "${BASE_SHA}" != "${REMOTE_SHA}" ]; then
  die "origin/${DEPLOY_BRANCH} に手元へ取り込んでいないコミットがあります。
先に \`git pull --rebase\` してください（このスクリプトは force push しません）。"
fi

readonly REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

# Pages の配信元が Actions になっていないと、push しても何も公開されない。
# 「成功したのに古いままだ」で悩まないよう、先に見ておく。
# Pages が無効なとき gh は 404 の JSON を stdout に出すので、値をそのまま
# 画面に出さず、既知の値だけを見る。
readonly PAGES_SETTINGS_URL="https://github.com/${REPO}/settings/pages"
build_type="$(gh api "repos/${REPO}/pages" --jq .build_type 2>/dev/null || true)"

case "${build_type}" in
  workflow) : ;;
  legacy)
    die "GitHub Pages がブランチ配信になっています。
Settings → Pages → Source を「GitHub Actions」に変えてから再実行してください。
  ${PAGES_SETTINGS_URL}"
    ;;
  *)
    die "GitHub Pages が有効になっていません。
Settings → Pages → Source を「GitHub Actions」にしてから再実行してください。
  ${PAGES_SETTINGS_URL}"
    ;;
esac

# --- 学習パレットの同期 -----------------------------------------------------

palette_committed=0

if [ "${sync_palette}" -eq 1 ]; then
  if [ ! -f "${PALETTE_SRC}" ]; then
    # 非公開リポジトリを clone していない環境でも公開はできるようにする。
    # その場合はコミット済みのパレットがそのまま使われる。
    warn "パレットの取得元が見つかりません: ${PALETTE_SRC}"
    warn "コミット済みの ${PALETTE_DEST} をそのまま使います。"
  elif cmp -s "${PALETTE_SRC}" "${PALETTE_DEST}"; then
    log '学習パレットは公開ビルドと同じ内容です'
  else
    log '学習パレットに差分があります'
    diff -u "${PALETTE_DEST}" "${PALETTE_SRC}" || true
    cp "${PALETTE_SRC}" "${PALETTE_DEST}"

    if [ "${dry_run}" -eq 1 ]; then
      warn '--dry-run のため、コミットせずに作業ツリーへ反映だけしました。'
    else
      # このファイルだけをコミットする。他の変更には触れない
      # （そもそも作業ツリーが clean であることは確認済み）。
      git add "${PALETTE_DEST}"
      git commit --quiet --message 'chore: 学習パレットを公開ビルドへ反映'
      palette_committed=1
      log 'パレットの更新をコミットしました'
    fi
  fi
fi

# --- 手元での検証 -----------------------------------------------------------

if [ "${skip_checks}" -eq 1 ]; then
  warn 'typecheck / lint / test を飛ばします（--skip-checks）'
else
  log '型を確認しています'
  npm run --silent typecheck
  log 'lint を実行しています'
  npm run --silent lint
  log 'テストを実行しています'
  npm test --silent
fi

log 'ビルドしています'
npm run --silent build

[ -f dist/index.html ] || die 'dist/index.html が生成されていません。'

# base が '/' に戻ると、プロジェクトページ（/ohm-lens/ 配下）では最初の
# スクリプト読み込みから壊れる。公開前にここで止める。
if grep -qE '(src|href)="/' dist/index.html; then
  grep -nE '(src|href)="/' dist/index.html >&2
  die "dist/index.html に絶対パスの参照があります。
vite.config.ts の base が './' になっているか確認してください。"
fi

[ -f dist/palette.json ] || warn 'dist/palette.json がありません。公開版は既定の基準色で動きます。'

log '手元の検証を通りました'

# --- push -------------------------------------------------------------------

if [ "${dry_run}" -eq 1 ]; then
  printf '\n  \033[33m●\033[0m --dry-run のため push しません\n\n'
  if [ "${LOCAL_SHA}" = "${REMOTE_SHA}" ] && [ "${palette_committed}" -eq 0 ]; then
    printf '      公開待ちのコミットはありません。\n\n'
  else
    printf '      公開されるはずだったコミット:\n\n'
    git --no-pager log --oneline "origin/${DEPLOY_BRANCH}..HEAD" | sed 's/^/        /'
    printf '\n'
  fi
  exit 0
fi

if [ "$(git rev-parse HEAD)" = "${REMOTE_SHA}" ]; then
  # 差分がないときでも、ワークフローを直接起動すれば出し直せる。
  log "origin/${DEPLOY_BRANCH} と同じ内容です。ワークフローを直接起動します"
  gh workflow run pages.yml --ref "${DEPLOY_BRANCH}"
else
  log "origin/${DEPLOY_BRANCH} へ push します"
  git --no-pager log --oneline "origin/${DEPLOY_BRANCH}..HEAD" | sed 's/^/    /'
  git push origin "${DEPLOY_BRANCH}"
fi

readonly PUSHED_SHA="$(git rev-parse HEAD)"

# --- Actions を見届ける -----------------------------------------------------

if [ "${watch_run}" -eq 0 ]; then
  printf '\n  \033[32m●\033[0m push しました（--no-watch のため待ちません）\n\n'
  printf '      進行状況: https://github.com/%s/actions/workflows/pages.yml\n\n' "${REPO}"
  exit 0
fi

log 'デプロイのワークフローを探しています'

run_id=''
for _ in $(seq 30); do
  run_id="$(gh run list --workflow=pages.yml --branch="${DEPLOY_BRANCH}" \
    --limit=5 --json databaseId,headSha \
    --jq "[.[] | select(.headSha == \"${PUSHED_SHA}\")] | first | .databaseId" 2>/dev/null || true)"
  [ -n "${run_id}" ] && [ "${run_id}" != 'null' ] && break
  sleep 2
done

if [ -z "${run_id}" ] || [ "${run_id}" = 'null' ]; then
  warn 'ワークフローの実行を特定できませんでした。ブラウザで確認してください。'
  printf '      https://github.com/%s/actions/workflows/pages.yml\n' "${REPO}"
  exit 1
fi

log "実行を見届けています（run ${run_id}）"
gh run watch "${run_id}" --exit-status \
  || die "デプロイに失敗しました。ログ: gh run view ${run_id} --log-failed"

# --- 公開を確認する ---------------------------------------------------------

log '公開 URL の応答を確認しています'

verified=0
for _ in $(seq $((VERIFY_TIMEOUT / 3))); do
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PAGES_URL}")" = '200' ]; then
    verified=1
    break
  fi
  sleep 3
done

if [ "${verified}" -eq 1 ]; then
  log "${PAGES_URL} が 200 を返しました"
else
  warn "${PAGES_URL} がまだ応答しません。反映に時間がかかることがあります。"
fi

# パレットが本当に配信されているか（Phase 2 が効いているか）を実地で見る。
palette_url="${PAGES_URL%/}/palette.json"
palette_colors="$(curl -sS --max-time 10 "${palette_url}" 2>/dev/null \
  | python3 -c 'import json,sys; print(len((json.load(sys.stdin) or {}).get("colors") or {}))' 2>/dev/null || echo 0)"

if [ "${palette_colors}" -gt 0 ]; then
  log "学習パレットが配信されています（${palette_colors} 色）"
else
  warn '学習パレットを取得できませんでした。公開版は既定の基準色で動きます。'
fi

# --- 完了 -------------------------------------------------------------------

printf '\n  \033[32m●\033[0m OhmLens を公開しました\n\n'
printf '      %s\n\n' "${PAGES_URL}"
printf '  カメラは HTTPS なので実機でも使えます。\n'
printf '  \033[1m実機（iPhone Safari など）でのカメラ起動と HEIC 読み込みは、\n'
printf '  ビルドが通っただけでは確かめられません。手で見てください。\033[0m\n\n'
