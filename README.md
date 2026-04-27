# Racker Terminal

Windows 専用の自作ターミナルアプリ。内部（端末描画・PTY）は成熟ライブラリを使い、UI だけを自分好みに作り込む方針。

## Status

**Phase 2 (UI 本命) 完成 (2026-04-27) / Phase 3 で永続化・配布へ。**

- **Phase 1**: Tauri 2 + React 19 + xterm.js + portable-pty で nushell が起動・入出力できる最小構成
- **Phase 2**: 縦サイドバー（グループ + タブ 2 階層）、InlineEdit、右クリックメニュー、お気に入り、Ctrl+Tab 等のキーボードショートカット、D&D、OSC タイトル自動更新、StrictMode/HMR 復活
- **Phase 3**: 永続化、Tab.title 構造分離、WebGL renderer、Settings UI、配布（インストーラー）など — [phase3-plan.md](docs/phase3-plan.md)

### Phase 2 ハイライト

| 機能 | 実装 |
|---|---|
| 複数タブ | TerminalPane visibility 切替 + terminalRegistry refcount で StrictMode 耐性 |
| グループ | Sidebar / GroupSection / TabItem の 2 階層、折りたたみ |
| インライン編集 | 自作 input 切替式（IME 対応） |
| 右クリックメニュー | `@radix-ui/react-context-menu` |
| お気に入り | shell/cwd/env を保存して再 spawn |
| OSC タイトル | shell の `\033]0;...\007` を自動反映、編集中ガード |
| キーボード | Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+Shift+W |
| D&D | `@dnd-kit` でタブ並び替え + グループ間移動 |
| restart | crashed タブで scrollback 維持しつつ PTY 差し替え |
| Rust 側 | 2 スレッド reader + flush + child watcher、back-pressure (4MB) |

詳細は [phase2-plan.md](docs/phase2-plan.md) と各 Unit 設計書 (`docs/unit-*-design.md`) 参照。

### テスト

| 種別 | 件数 |
|---|---|
| Frontend (vitest) | 131 |
| Rust (cargo test) | 10 |

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
3. **永続化**: アプリ再起動時にタブ・グループ・お気に入りを復元 — Phase 3
4. **タブのスリープ化**: 作業を寝かせる専用「sleep」グループ — Phase 3 で要否再検討

設計書: [phase1-plan.md](docs/phase1-plan.md) / [phase2-plan.md](docs/phase2-plan.md) / [phase3-plan.md](docs/phase3-plan.md)

## 制約 / 方針

- Windows 専用、クロスプラットフォーム非対応
- ユーザー設定項目は最小限（押し付けるデフォルト）
- ペイン分割なし、シングルウィンドウ
