# Contributing to Racker Terminal

## 依存更新ポリシー

racker-terminal は WebView2 (Chromium) + xterm.js + portable-pty + Tauri 2 の
組み合わせで動作する。各依存は破壊的変更が起きやすいため:

1. **依存更新は専用 PR**: 1 PR = 1 依存パッケージ
2. **手動 E2E 検証必須**: nushell / WSL / PowerShell / cmd の起動確認
3. **`Cargo.lock` / `package-lock.json` をコミット**: ビルド再現性確保
4. **Rust toolchain**: 本リポジトリでは `rust-toolchain.toml` 未設定。stable で動作確認済み

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
