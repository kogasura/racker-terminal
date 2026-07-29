# Contributing to Racker Terminal

## 依存更新ポリシー

racker-terminal は WebView2 (Chromium) + xterm.js + portable-pty + Tauri 2 の
組み合わせで動作する。各依存は破壊的変更が起きやすいため:

1. **依存更新は専用 PR**: 1 PR = 1 依存パッケージ
2. **手動 E2E 検証必須**: nushell / WSL / PowerShell / cmd の起動確認
3. **`Cargo.lock` / `package-lock.json` をコミット**: ビルド再現性確保
4. **Rust toolchain**: リポジトリ直下の `rust-toolchain.toml` で `stable` に固定。
   `rustfmt` / `clippy` コンポーネントも同ファイルが担保するため、rustup 環境なら
   追加インストールは不要

## Lint / フォーマット

Rust 側は rustfmt と clippy で機械的にチェックする。CI（`.github/workflows/ci.yml`）が
PR ごとに実行するので、ローカルでも push 前に通しておくこと。

```
npm run fmt:rs        # 整形を適用
npm run fmt:rs:check  # 差分チェックのみ（CI と同じ）
npm run lint:rs       # clippy（警告をエラー扱い）
```

- rustfmt の設定は `src-tauri/rustfmt.toml`。stable のオプションのみ使う
- clippy に個別の設定ファイルは置いていない。既定の lint セットを
  CI で `-D warnings` によりエラー扱いにする方針
- 特定箇所だけ許容したい場合は `#[allow(clippy::...)]` を理由コメント付きで添える
  （例: `src-tauri/src/pty.rs` の `too_many_arguments`）

`npm run lint:rs` は `tauri::generate_context!` が `tauri.conf.json` の
`frontendDist` (`../dist`) をコンパイル時に読むため、事前に `npm run build` が必要。

## ビルド手順

開発:
```
npm install
npm run tauri dev
```

リリースビルド:
```
npm run tauri build
```
出力: `src-tauri/target/release/bundle/{nsis,msi}/`

## Phase / Unit について

実装は Phase × Unit で管理: `docs/phase4-plan.md` 参照。
