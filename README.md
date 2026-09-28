# Racker Terminal

**Windows で Claude Code を回すためのターミナル。**

プロジェクトごとの起動設定をワンクリックで開き、アプリを再起動しても **Claude のセッションの続きから**復元します。

<!-- SCREENSHOT: ここにメインスクリーンショット (docs/images/hero.png) を挿入 -->

- **Windows 専用**（Windows 10 1809+ / Windows 11）
- **Electron ではありません** — Tauri 2（WebView2 + Rust）製
- **アカウント登録なし・テレメトリなし・クラウド送信なし** — 設定は端末内に閉じます

## できること

**縦にフォルダ、横にタブ。** 左サイドバーにはグループ（フォルダ）だけが縦に並び、選んだグループのタブが画面上部に横並びで出ます。タブが増えてもサイドバーは伸びません。

**お気に入りでワンクリック起動。** シェル種別・起動ディレクトリ・引数・環境変数をひとまとめに保存できます。`Ctrl+Shift+1〜9` で 1〜9 番目を直接開けます。WSL なら distro とディレクトリを選ぶだけで、`-d` や `--cd` は自動で組み立てられます。

**再起動しても Claude の続きから。** タブが復元されるとき、前回の claude セッションを自動で再開します。自分で `claude` と打ったタブも追跡対象です（[但し書き](docs/usage.md#claude-code-の自動起動)）。PC を再起動するたびに `cd` して `claude --resume` を打ち直す作業が消えます。

**Claude が呼んでいるタブが光る。** ステータスドットが Claude の状態で変わります。**Claude Code 自身が申告している状態**を読んでいるので、画面の見た目に頼った推測ではありません。

| 表示 | 状態 | 意味 |
|---|---|---|
| 青のリング（速い明滅） | 応答待ち | 権限確認やプロンプトであなたの返事を待っている |
| オレンジのリング | 実行中 | モデルが応答中、またはコマンドを実行中 |
| 緑のリング | 完了 | 処理が終わった。タブを開くまで残る |

グループ行にも集約表示されるので、いま見ていないフォルダの分まで気付けます（優先度は 応答待ち > 実行中 > 完了）。表示中でないタブが応答待ち・完了になると**デスクトップ通知**も出ます。

**いま何で動いているかが下に出る。** 画面下部の 1 行に、モデル・reasoning effort・コンテキスト消費量と、プランの使用量（5 時間 / 週次）が出ます。

```
Opus 5  high  ▮▮▮▯▯ 55k / 200k (28%)                    5h 13%   週 22%
```

Claude Code の中で同じことを知るには `/status` や `/usage` を打つ必要があり、そのたびに会話が途切れます。Racker はタブの外側にいるので、邪魔せずに出しておけます。

**そのほか。**

- **画面内容の復元** — 直近 1000 行を保存し、再起動時に書き戻します（プロセスは復活しません）
- **PR バッジ** — 作業ディレクトリのブランチに対応する PR の状態をタブに出します（`gh` が使える環境のみ）
- **Windows / WSL の面倒を吸収** — `Ctrl+Enter` で改行送出、ファイルをドロップするとパスを type（WSL タブは `/mnt/c/...` へ自動変換）、`Ctrl+クリック` で URL を開く、`Ctrl+C` で選択コピー（選択なしは SIGINT）

他のターミナルとの比較は [docs/comparison.md](docs/comparison.md) を参照してください。

## インストール

[リリースページ](https://github.com/kogasura/racker-terminal/releases/latest)から `Racker Terminal_<version>_x64-setup.exe` をダウンロードして実行します。

### ⚠️ SmartScreen の警告が出ます（想定どおりです）

コード署名をしていないため、初回起動時に警告が出ます。「詳細情報」→「実行」で進めてください。

**怪しいから止められているのではなく、署名証明書を購入していない個人開発アプリすべてに出る警告です。** 不安ならソースは全公開なので、クローンして `npm run tauri build` で自分でビルドできます。配布経路は GitHub Releases のみです。

### 必要環境

- Windows 10 (build 1809) 以降 / Windows 11
- WebView2 ランタイム（Windows 11 はプリインストール、Windows 10 は自動ダウンロード）
- フォント **MonaspiceNe NF** はバンドル済み（Cascadia Code / Consolas にフォールバック）
- Claude Code の自動起動を使う場合: `claude` が PATH にあること

### アップデート

起動時と 1 時間ごとに自動で確認します。新しいバージョンがあるとタイトルバーに更新ボタンが出ます。設定ダイアログの「バージョン情報」からも手動で確認できます。詳細は [docs/auto-update.md](docs/auto-update.md)。

## 使い方

**お気に入り** — よく使うシェル構成を保存してワンクリックで開けます。登録はタブを右クリック →「お気に入りに追加」か、サイドバーの `+ Add Favorite` から。

**Claude Code の自動起動** — お気に入りの編集画面で ON にすると、そのお気に入りから開いたタブで `claude` が自動起動し、再起動後はセッションの続きから再開します。

**フォルダを選んで開く** — サイドバー下部の 📁 からシェルを選ぶと、フォルダ選択ダイアログが開きます。お気に入りに登録せず臨時のフォルダを開く導線です。

**エクスプローラーの右クリックから開く** — インストーラーが右クリックメニューに「Racker Terminal で開く」を追加します。フォルダ・フォルダ背景・ドライブに対応。起動中なら新しいウィンドウを増やさず、既存のウィンドウにタブを足します。

> Windows 11 では「その他のオプションを表示」（`Shift+F10`）の中に出ます。右クリック直後の新しいメニューに出すにはコード署名が必要で、現在は未対応です。

設定項目の詳細、引数・環境変数の書き方、Claude セッション復元の但し書きは **[docs/usage.md](docs/usage.md)** にまとめてあります。

## キーボードショートカット

| ショートカット | 動作 |
|---|---|
| `Ctrl+T` | 既定タブ（既定のお気に入り）を開く |
| `Ctrl+Shift+T` | 閉じたタブを復元（最大 10 個、再起動でクリア） |
| `Ctrl+Shift+W` | アクティブタブを閉じる |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 次 / 前のタブへ移動 |
| `Ctrl+Shift+1〜9` | お気に入りの 1〜9 番目を開く |
| `Ctrl+C` | 選択範囲をコピー（選択なしのときは SIGINT） |
| `Ctrl+V` | クリップボードから貼り付け |
| `Ctrl+Enter` | 改行を挿入（ESC+CR。Mac の `Option+Enter` 相当） |
| `Ctrl+クリック` | URL を既定ブラウザで開く（`http:` / `https:` のみ） |

## 知っておいてほしいこと

- **Racker を閉じると、タブで動かしていたプロセスも終了します。** 強制終了やクラッシュでも同じです（Job Object で OS にまとめて片付けさせています）。閉じた後も動かし続けたいものは、タブの中ではなくサービスやタスクスケジューラに置いてください。
- **お気に入りの環境変数は平文で保存されます。** API キー・パスワード等の機密値は入れないでください（[詳細](docs/usage.md#機密値の取り扱い注意)）。
- ペイン分割・SSH / リモート接続・マルチウィンドウはありません。設定項目も意図的に絞っています。

## 開発

前提: Windows 11、Node.js 22、Rust stable、nushell (`nu`) が PATH にあること。

```sh
npm install
npm run tauri dev
```

| | |
|---|---|
| 殻 | Tauri 2（WebView2 + Rust） |
| UI | React 19 + TypeScript + Vite + Tailwind CSS v4 |
| 端末描画 | [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm)（WebGL renderer + Canvas フォールバック） |
| PTY | Rust [portable-pty](https://crates.io/crates/portable-pty)（ConPTY 経由） |
| IPC | Tauri v2 Channel API |

```sh
npm run test:run    # フロントエンド (vitest)
npm run lint:ts     # eslint
cd src-tauri && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
```

フロントエンドの設計方針（Root / Passive View / イベントのバブリング / ステートマシン）は **[src/architecture/README.md](src/architecture/README.md)** にまとめてあります。新しく機能を足すときはそちらを読んでから書いてください。

関連ドキュメント: [互換性マトリクス](docs/compatibility-matrix.md) / [リリースプロセス](docs/release-process.md) / [自動更新](docs/auto-update.md)

初期の設計経緯は `docs/phase1-plan.md` 〜 `docs/phase4-plan.md` に残してあります（v1.0 までの記録で、現状とは差があります）。

各バージョンの変更点は `CHANGELOG-<version>.md` を参照してください。

## バグ報告

[GitHub Issues](https://github.com/kogasura/racker-terminal/issues) にお願いします。再現手順・OS バージョン (`winver`)・シェル種別（nushell / pwsh / wsl 等）を含めると助かります。
