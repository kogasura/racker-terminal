# 自動更新機能の設計

## 概要

racker-terminal v1.1+ は Tauri 公式の `@tauri-apps/plugin-updater` を使用した自動更新機能を備えています。
起動時に GitHub Releases の `latest.json` をチェックし、新バージョンがあれば
ユーザー承認の上でダウンロード・インストール・再起動を行います。

## アーキテクチャ

```
[App.tsx 起動時 useEffect]
       ↓ runUpdateCheck() 1 回
[lib/updater.ts wrapper]
       ↓ @tauri-apps/plugin-updater
[Tauri Rust runtime]
       ↓ HTTPS GET
[GitHub Releases /latest.json]
       ↓ Update | null
[appStore: updateInfo セット, updatePhase='available']
       ↓ TitleBar が subscribe → バッジ表示
[ユーザーがバッジクリック]
       ↓ openUpdateDialog()
[UpdateDialog: notes 表示 → 「今すぐ更新」]
       ↓ downloadAndInstall(progressCb)
[updatePhase: downloading → installing → 再起動]
```

## 状態遷移

`updatePhase` の状態遷移を表で記載:

| from | event | to |
|---|---|---|
| idle | runUpdateCheck() 実行 | checking |
| checking | check() resolved with null | idle |
| checking | check() resolved with Update | available |
| available | startUpdateInstall() 実行 | downloading |
| downloading | progress event | downloading (継続) |
| downloading | onProgress Finished | installing |
| installing | relaunch() 後 | (プロセス終了) |
| downloading/installing | 例外発生 | error |
| error | startUpdateInstall() (リトライ) | downloading |
| error | resetUpdateError() | idle |

## エンドポイント

`https://github.com/kogasura/racker-terminal/releases/latest/download/latest.json`

## 鍵管理ポリシー

- 秘密鍵は `%USERPROFILE%/.tauri/racker-terminal.key` に保管 (gitignore 済み)
- パスフレーズはユーザーが管理 (1Password 等の安全な場所に保管推奨)
- 公開鍵は `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に直接埋め込み
- **絶対に秘密鍵を git にコミットしないこと**

## 既知の制約

- **NSIS インストーラーのみ対応** (MSI は v1.1 で廃止済み)
- **SmartScreen 警告**: コード署名証明書 (Authenticode) を購入していないため、
  各更新インストール時に SmartScreen 警告が出ます。「詳細情報 → 実行」で続行可能
- **チェックは起動時 1 回のみ**: 起動中の長時間運用では自動的に再チェックしません
- **ダウンロード中の中断**: ダウンロード中に Dialog は閉じられません (UI ガード)

## 設定値

- `installMode: "passive"`: NSIS インストーラーが UI 最小・進捗バーのみで実行されます
- 配布形式: NSIS のみ (`bundle.targets: ["nsis"]`)
- updater 用署名アーティファクト生成: `bundle.createUpdaterArtifacts: true`
