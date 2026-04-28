# Racker Terminal

Windows 専用の自作ターミナルアプリ。内部（端末描画・PTY）は成熟ライブラリを使い、UI だけを自分好みに作り込む方針。

## Status

**Phase 4 進行中 (2026-04-25〜) / Unit P4-G + P4-A 完了。**

- **Phase 1**: Tauri 2 + React 19 + xterm.js + portable-pty で nushell が起動・入出力できる最小構成
- **Phase 2**: 縦サイドバー（グループ + タブ 2 階層）、InlineEdit、右クリックメニュー、お気に入り、Ctrl+Tab 等のキーボードショートカット、D&D、OSC タイトル自動更新、StrictMode/HMR 復活
- **Phase 3 (絞り込み)**: WebGL renderer 復活、detached thread リーク撲滅、spawning タイムアウト、IME 改善、e.code ベースキーバインド、異常終了の網羅検証
- **Phase 4 (進行中)**: 永続化 (zustand persist)、Tab.title 構造分離 (P4-A)、お気に入り改善 (P4-G)、Settings UI、配布（インストーラー）など — [phase4-plan.md](docs/phase4-plan.md)

### 永続化される情報

| 情報 | 永続化 | 備考 |
|---|---|---|
| タブ・グループ・お気に入りの構成 | ✅ | localStorage に保存 |
| shell / cwd / 環境変数 | ✅ | 起動時に再 spawn |
| ユーザー編集したタブ名 (userTitle) | ✅ | OSC タイトルより優先 |
| Settings (フォント等) | ✅ | |
| scrollback (PTY 出力履歴) | ❌ | PTY と一蓮托生のため復元不可 |
| 実行中状態 (active タブ・編集中) | ❌ | ランタイム情報 |
| shell 側の OSC タイトル | ❌ | 起動後に shell が再送信 |

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
| キーボード | Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+Shift+W |
| D&D | `@dnd-kit` でタブ並び替え + グループ間移動 |
| restart | crashed タブで scrollback 維持しつつ PTY 差し替え |
| Rust 側 | 2 スレッド reader + flush + child watcher、back-pressure (4MB) |

詳細は [phase2-plan.md](docs/phase2-plan.md) / [phase3-plan.md](docs/phase3-plan.md) と各 Unit 設計書 (`docs/unit-*-design.md`) 参照。

### テスト

| 種別 | Phase 2 完成 | Phase 3 完成 |
|---|---|---|
| Frontend (vitest) | 131 | **142** |
| Rust (cargo test) | 10 | **10** |

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
