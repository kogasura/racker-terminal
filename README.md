# Racker Terminal

Windows 専用の自作ターミナルアプリ。内部（端末描画・PTY）は成熟ライブラリを使い、UI だけを自分好みに作り込む方針。

## インストール

リリースページから `Racker Terminal_<version>_x64-setup.exe` (NSIS) をダウンロード。
ダブルクリックでインストール → スタートメニューから起動。

### 必要環境
- Windows 10 (build 1809) 以降 / Windows 11
- WebView2 ランタイム (Windows 11 はプリインストール、Windows 10 は自動 download)
- フォント: **MonaspiceNe NF はバンドル済**。Cascadia Code / Consolas にフォールバック可能

### コード署名

v1.x では未署名。Windows Defender SmartScreen の警告が出る可能性あり。
警告画面で「詳細情報」→「実行」で起動可能。

### アップデート

**v1.1 以降は起動時に自動で更新確認します。** 新しいバージョンがある場合、タイトルバーに更新ボタンが表示されます。クリックするとリリースノートを確認した上で承認制でダウンロード・インストール・再起動が行われます。

詳細は [docs/auto-update.md](docs/auto-update.md) を参照。

### v1.0.x で MSI 版を使っていた方へ

v1.1 から MSI インストーラーは廃止し、NSIS インストーラー (`setup.exe`) のみの配布になりました。
NSIS の `setup.exe` を実行すると新しい場所に v1.1 がインストールされます (旧 MSI 版とは別の場所)。
旧 MSI 版が不要になった場合は Windows の「設定 → アプリ → インストールされているアプリ」から
"Racker Terminal" の旧バージョン (1.0.x) をアンインストールしてください。

## Status

**Phase 4 完了 (v1.0) / Unit P4-A + P4-B-1 + P4-B-2 + P4-D + P4-G + P4-H + P4-I + P4-J + P4-K 完了。**

- **Phase 1**: Tauri 2 + React 19 + xterm.js + portable-pty で nushell が起動・入出力できる最小構成
- **Phase 2**: 縦サイドバー（グループ + タブ 2 階層）、InlineEdit、右クリックメニュー、お気に入り、Ctrl+Tab 等のキーボードショートカット、D&D、OSC タイトル自動更新、StrictMode/HMR 復活
- **Phase 3 (絞り込み)**: WebGL renderer 復活、detached thread リーク撲滅、spawning タイムアウト、IME 改善、e.code ベースキーバインド、異常終了の網羅検証
- **Phase 4 (完了)**: 永続化 (P4-A)、お気に入り改善 (P4-G)、D&D 拡張 (P4-B-1)、Settings UI + frameless window + 背景透過 (P4-B-2)、既定シェル + 新規タブ UX (P4-H)、プロファイルテンプレート (P4-I)、シェル引数サポート (P4-J)、WSL distro 自動検出 (P4-K)、配布インストーラー (P4-D) — [phase4-plan.md](docs/phase4-plan.md)

### 永続化される情報

- ✅ タブ・グループ・お気に入りの構成
- ✅ shell / cwd / 環境変数 (env)
- ✅ ユーザー編集したタブ名 (userTitle)
- ✅ Settings (フォント等)

| 情報 | 永続化 | 備考 |
|---|---|---|
| タブ・グループ・お気に入りの構成 | ✅ | localStorage に保存 |
| shell / cwd / 環境変数 | ✅ | 起動時に再 spawn |
| ユーザー編集したタブ名 (userTitle) | ✅ | OSC タイトルより優先 |
| Settings (フォント等) | ✅ | |
| scrollback (PTY 出力履歴) | ❌ | PTY と一蓮托生のため復元不可 |
| 実行中状態 (active タブ・編集中) | ❌ | ランタイム情報 |
| shell 側の OSC タイトル | ❌ | 起動後に shell が再送信 |

### ⚠️ 機密値の取り扱い注意

`env` (環境変数) は **localStorage に平文 JSON で保存** されます。
WebView2 の DevTools や `%LOCALAPPDATA%\<app>\EBWebView\` の LevelDB から読み取れる可能性があります。
**API キー・パスワード・個人トークン等の機密値は env に入れないでください**。
将来 (Phase 5+) で OS keyring (Windows Credential Manager 等) への退避を検討中です。

### Phase 4 ハイライト (v1.0)

| 機能 | 実装 |
|---|---|
| 永続化 (P4-A) | `zustand/middleware/persist` で localStorage に状態保存。アプリ再起動後もタブ・グループ・設定が復元される |
| Tab.title 構造分離 (P4-A) | `userTitle` (手動編集) と `oscTitle` (shell の OSC) に分離 |
| お気に入り改善 (P4-G) | OSC 7 で cwd を動的追跡、手動登録 UI、編集メニュー |
| D&D 拡張 (P4-B-1) | グループ並び替え、Favorites 並び替え、折りたたみグループへの auto-expand drop、新規グループとして drop |
| **Settings UI (P4-B-2)** | サイドバーフッタの ⚙ ボタンから設定ダイアログを開く。フォントサイズ・フォントファミリ・スクロールバック・透明度を GUI で変更可能 |
| **frameless window (P4-B-2)** | `decorations: false` + カスタム TitleBar (最小化/最大化/閉じる + ドラッグ領域) |
| **背景透過 (P4-B-2)** | `transparent: true` + Settings で透明度 0.7〜1.0 を調整。xterm.js の theme.background を rgba で制御 |
| **配布 (P4-D)** | nsis (setup.exe) インストーラー生成。MonaspiceNe NF (woff2) をバンドル — フォント未インストール環境でも正しく描画。v1.1 で MSI 廃止、自動更新導入 |

### Phase 3 ハイライト

| 機能 | 実装 |
|---|---|
| WebGL renderer 復活 | `setupWebglRenderer` ヘルパー + `onContextLoss` で Canvas フォールバック |
| detached thread リーク撲滅 | Drop で reader/flush/watch を直接 join (Phase 1 の detached spawn 撤廃) |
| spawning タイムアウト | 10 秒経過で自動 crashed (EDR 環境対応) |
| IME 改善 | `term.textarea` の compositionstart/end + `attachCustomKeyEventHandler` の `e.isComposing` 二重ガード |
| e.code 切替 | CapsLock / AZERTY / 非 ASCII レイアウト対応 |
| 異常終了検証 | Ctrl-D / Exit / taskkill / ssh 切断 / タスクマネージャ強制終了の網羅性確認 |

### Phase 2 ハイライト (継続)

| 機能 | 実装 |
|---|---|
| 複数タブ | TerminalPane visibility 切替 + terminalRegistry refcount で StrictMode 耐性 |
| グループ | Sidebar / GroupSection / TabItem の 2 階層、折りたたみ |
| インライン編集 | 自作 input 切替式（IME 対応） |
| 右クリックメニュー | `@radix-ui/react-context-menu` |
| お気に入り | shell/cwd/env を保存して再 spawn |
| OSC タイトル | shell の `\033]0;...\007` を自動反映、編集中ガード |
| キーボード | Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+Shift+W / Ctrl+Shift+T |
| D&D | `@dnd-kit` でタブ並び替え + グループ間移動 |
| restart | crashed タブで scrollback 維持しつつ PTY 差し替え |
| Rust 側 | 2 スレッド reader + flush + child watcher、back-pressure (4MB) |

詳細は [phase2-plan.md](docs/phase2-plan.md) / [phase3-plan.md](docs/phase3-plan.md) と各 Unit 設計書 (`docs/unit-*-design.md`) 参照。

## キーボードショートカット

| ショートカット | 動作 |
|---|---|
| `Ctrl+T` | 既定タブを開く |
| `Ctrl+Shift+T` | 閉じたタブを復元（最大 10 個まで履歴保持、再起動でクリア） |
| `Ctrl+Shift+W` | アクティブタブを閉じる |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 次/前のタブへ移動 |
| `Ctrl+Shift+1〜9` | お気に入り 1-9 番目を開く |
| `Ctrl+V` | クリップボードから貼り付け |

### テスト

| 種別 | Phase 2 完成 | Phase 3 完成 | Phase 4 完成 (v1.0) |
|---|---|---|---|
| Frontend (vitest) | 131 | **142** | **295** |
| Rust (cargo test) | 10 | **10** | **19** |

互換性マトリクス: [compatibility-matrix.md](docs/compatibility-matrix.md)

## 技術スタック

| 層 | 採用 |
|---|---|
| 殻 | Tauri 2（WebView2 + Rust） |
| UI | React 19 + TypeScript + Vite + Tailwind CSS v4 |
| 端末描画 | [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm) |
| PTY | Rust [portable-pty](https://crates.io/crates/portable-pty)（ConPTY 経由） |
| IPC | Tauri v2 Channel API |

## 起動

前提: Windows 11、Node.js 20+、Rust stable、nushell (`nu`) が PATH にある。

```sh
npm install
npm run tauri dev
```

## 要件（UI 本命）

1. **タブのグループ化**: 縦サイドバーで折りたたみ可能なグループ + タブの 2 階層 — Phase 2 完了
2. **お気に入り**: ワンクリックで頻用プロジェクトを新規タブ起動 — Phase 2 完了
3. **WebGL renderer**: パフォーマンス向上、Canvas フォールバック付き — Phase 3 完了
4. **永続化**: アプリ再起動時にタブ・グループ・お気に入りを復元 — Phase 4
5. **配布**: msi/exe インストーラー — Phase 4
6. **タブのスリープ化**: 作業を寝かせる専用「sleep」グループ — Phase 4 で要否再検討

設計書: [phase1-plan.md](docs/phase1-plan.md) / [phase2-plan.md](docs/phase2-plan.md) / [phase3-plan.md](docs/phase3-plan.md)

## 制約 / 方針

- Windows 専用、クロスプラットフォーム非対応
- ユーザー設定項目は最小限（押し付けるデフォルト）
- ペイン分割なし、シングルウィンドウ

## Bug Report

問題があれば [GitHub Issues](https://github.com/kogasura/racker-terminal/issues) に報告してください。
再現手順・OS バージョン (`winver`)・shell 種別 (nushell / pwsh / wsl 等) を含めると助かります。
