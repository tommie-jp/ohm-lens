# GitHub Pages での公開

Phase 0 の成果物を実際に触れる場所に置く。デプロイ先は GitHub Pages、
公開の入口は `doDeploy.sh`。

## 決めたこと

| 項目 | 決定 |
| ------ | ------ |
| 配信先 | GitHub Pages（Source = GitHub Actions） |
| URL | まず `https://tommie-jp.github.io/ohm-lens/`、後で `https://ohmlens.tommie.jp` |
| ビルド成果物の置き場 | Actions のアーティファクト（`gh-pages` ブランチは作らない） |
| 学習パレット | 公開リポジトリの `src/debug/public/palette.json` に置く |
| Vite の `base` | `'./'`（相対パス） |

## なぜアーティファクト方式か

`dist/` は `.gitignore` 済み。`gh-pages` ブランチ方式にすると生成物をコミット
する運用に逆戻りする。Source を GitHub Actions にしておけば、認証情報を手元に
持たずに済み、CI と同じ手順でビルドされるので「手元では出たが CI で壊れる」が
起きない。

## なぜ `base: './'` か

Vite の既定（`base: '/'`）でビルドすると `dist/index.html` の参照が
`<script src="/assets/….js">` と絶対パスになり、プロジェクトページ
（`/ohm-lens/` 配下）では最初のスクリプト読み込みから壊れる。

相対パスにしておけば、プロジェクトページとカスタムドメイン直下のどちらでも
**同じ成果物がそのまま動く**。カスタムドメインへの移行時にビルド設定を触らずに
済むのが主な理由。

この設定が将来巻き戻ると公開してから気づくことになるので、`dist/index.html` に
絶対パス参照が無いことを **`doDeploy.sh` と pages.yml の両方で検査**している。

`fetch('/palette.json')` も同じ理由で `'./palette.json'` に変えた。

## 学習パレットの扱い

`palette.json` は非公開の作業用リポジトリ（`44-ohm-lens/sample/`）にあり、
dev サーバーでは `vite.config.ts` のプラグインが配信している。このプラグインは
`apply: 'serve'` なので**ビルド成果物には含まれない**。そのまま公開すると
既定の基準色で動き、較正の効果が消える。

そこで公開リポジトリの `src/debug/public/palette.json` にコピーを置く。中身は
Lab 値 8 色のみで元画像を含まないため、非公開素材の再配布にはならない。

同期は `doDeploy.sh` が行い、差分があれば単独のコミットにする。dev では
プラグイン側が優先されるので、**dev で見えている色と公開版の色が一致するとは
限らない**。この同期を挟むことでズレを防いでいる。

## cross-origin isolation について

[01-設計.md](01-設計.md) §8 のとおり、**GitHub Pages ではカスタムヘッダを
設定できない**ので COOP/COEP を張れず、`SharedArrayBuffer` が使えない。

Phase 0 の依存（`culori` / `heic-to`）はいずれも `SharedArrayBuffer` を
必要としないため、現時点では制約にならない。効いてくるのは Phase 2 で
onnxruntime-web の WASM マルチスレッドを使うときで、そこで
Cloudflare Pages などヘッダを設定できる基盤へ移す判断が要る。

**現時点の判断**: Phase 0/1 は GitHub Pages で出す。移行はマルチスレッドが
必要になった時点で行う。オリジンが変わるとカメラ許可・localStorage が
リセットされるため、移行はカスタムドメイン
（`ohmlens.tommie.jp`）を先に張ってから基盤だけ差し替える形にすると傷が浅い。

## カスタムドメインへの移行手順

1. `src/debug/public/CNAME` に `ohmlens.tommie.jp` の 1 行を置く
2. DNS に `CNAME ohmlens → tommie-jp.github.io` を追加
3. Settings → Pages でカスタムドメインを登録し、Enforce HTTPS を有効にする
4. `doDeploy.sh` の `PAGES_URL` 既定値を変える

`base` が相対なのでビルド設定の変更は不要。

## 公開後に手で確かめること

ビルドが通っただけでは確かめられないものがある。

- [ ] 実機（iPhone Safari など）でカメラが起動する
- [ ] HEIC ファイルを選ぶと動的チャンクが読める（相対 base の要確認点）
- [ ] 「設定」の表示が `共有パレット: 8 色を適用中` になっている

## 既知の問題

「サンプルで試す」（合成画像）が `?`／`バンドを検出できません` を返す。
dev サーバーでも同じ結果になるため**公開作業とは無関係の既存の挙動**だが、
写真を持たない初回訪問者が最初に押すボタンなので、公開前に直す価値がある。
