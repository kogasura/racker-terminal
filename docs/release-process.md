# リリース手順書

racker-terminal のリリース時に実行する手順をまとめたものです。

## 初回セットアップ (1 回限り)

### 1. Ed25519 鍵ペア生成

```powershell
# 秘密鍵を ~/.tauri/ に生成 (パスフレーズは対話的入力)
cargo tauri signer generate -w $env:USERPROFILE/.tauri/racker-terminal.key
```

出力例:
```
Your keypair was generated successfully
Private: C:\Users\<user>\.tauri\racker-terminal.key (Keep it secret!)
Public: <base64 string>
```

### 2. 公開鍵を tauri.conf.json に貼る

`src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に、上記出力の **base64 文字列** を貼り付ける。
プレースホルダ `"REPLACE_WITH_GENERATED_PUBKEY"` を置換。

### 3. パスフレーズの保管

パスフレーズは安全な場所 (1Password 等) に保管。リリースビルド時に環境変数として渡す必要あり。

## 各リリースの手順

### Step 1. バージョン bump

3 ファイルすべてを更新:
- `src-tauri/tauri.conf.json` の `version`
- `src-tauri/Cargo.toml` の `version`
- `package.json` の `version`

```powershell
# 例: 1.1.0 → 1.1.1
# (各ファイルを手動編集)

# Cargo.lock も更新
cd src-tauri
cargo update -p racker-terminal --offline
cd ..
```

### Step 2. 環境変数設定 (リリースビルド用)

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\racker-terminal.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<パスフレーズ>"
```

### Step 3. ビルド

```powershell
npm run tauri build
```

出力先:
- インストーラ: `src-tauri/target/release/bundle/nsis/Racker Terminal_<version>_x64-setup.exe`
- 署名ファイル: `src-tauri/target/release/bundle/nsis/Racker Terminal_<version>_x64-setup.exe.sig`

### Step 4. リリースノート準備

`CHANGELOG-<version>.md` または同等のテキストファイルを用意。

> **形式の注意**:
> - エンコーディング: UTF-8 (BOM なし)
> - 改行コード: LF (`\n`)
> - 推奨サイズ: 4 KB 以内（UpdateDialog の表示領域は max-height 240px のため）
> - プレーンテキスト or Markdown シンタックス（レンダリングされず生表示）

### Step 5. manifest 生成

```powershell
npm run release:manifest -- `
  --version 1.1.1 `
  --notes-file ./CHANGELOG-1.1.1.md `
  --installer-path "src-tauri/target/release/bundle/nsis/Racker Terminal_1.1.1_x64-setup.exe" `
  --signature-path "src-tauri/target/release/bundle/nsis/Racker Terminal_1.1.1_x64-setup.exe.sig" `
  --download-url-prefix https://github.com/kogasura/racker-terminal/releases/download/v1.1.1 `
  --output ./latest.json
```

### Step 6. GitHub Release 作成

```powershell
gh release create v1.1.1 `
  "src-tauri/target/release/bundle/nsis/Racker Terminal_1.1.1_x64-setup.exe" `
  "src-tauri/target/release/bundle/nsis/Racker Terminal_1.1.1_x64-setup.exe.sig" `
  ./latest.json `
  --title "v1.1.1" `
  --notes-file ./CHANGELOG-1.1.1.md
```

### Step 7. 検証

別の PC または旧バージョンを起動し、以下を確認:
- 起動時にバッジが表示される
- バッジクリックで Dialog が開き、リリースノートが表示される
- 「今すぐ更新」でダウンロード進捗が進み、自動再起動して新バージョンで起動する

## ロールバック手順

もし問題ある版をリリースしてしまった場合:

1. 問題ある GitHub Release の `latest.json` を削除 (旧版が `latest` 扱いになる)
2. または、以前の正常版を `gh release edit` で `latest` に再指定
3. 必要なら問題版そのものを `gh release delete` で削除

## トラブルシューティング

### `tauri build` で `.sig` が生成されない

- `bundle.createUpdaterArtifacts: true` が `tauri.conf.json` にあるか確認
- 環境変数 `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` が設定されているか確認

### updater の署名検証失敗 (実機で error phase)

- `tauri.conf.json` の `pubkey` が `"REPLACE_WITH_GENERATED_PUBKEY"` のままになっていないか確認
- 公開鍵が秘密鍵とペアになっているか確認 (鍵を再生成した場合は両方更新が必要)

### バッジが出ない

- ネットワーク不通 / `latest.json` が GitHub Releases にアップロードされていない / バージョン番号が現行と同じ、のいずれか
- DevTools (Tauri なら `npm run tauri dev` のログ) で `[updater] checkForUpdate failed:` を確認
