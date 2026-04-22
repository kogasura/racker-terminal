# Racker Terminal

Windows 専用の自作ターミナルアプリ。内部（端末描画・PTY）は成熟ライブラリを使い、UI だけを自分好みに作り込む方針。

## Status

**Phase 1 (基盤) 完了 / Phase 2 以降で UI 本命を開発予定。**

- Phase 1: Tauri 2 + React 19 + xterm.js + portable-pty で nushell が起動・入出力できる最小構成
- Phase 2: 縦サイドバー（グループ + タブ 2 階層）、D&D、右クリックメニュー、お気に入り、sleep グループ
- Phase 3: テーマ、フォント埋め込み、永続化、インストーラー

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

1. **タブのグループ化**: 縦サイドバーで折りたたみ可能なグループ + タブの 2 階層
2. **タブのスリープ化**: 作業を寝かせる専用「sleep」グループ
3. **お気に入り**: ワンクリックで頻用プロジェクトを新規タブ起動

詳細は [設計書](docs/phase1-plan.md) 参照。

## 制約 / 方針

- Windows 専用、クロスプラットフォーム非対応
- ユーザー設定項目は最小限（押し付けるデフォルト）
- ペイン分割なし、シングルウィンドウ
