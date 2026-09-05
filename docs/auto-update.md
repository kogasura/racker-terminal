# 自動更新機能の設計

## 概要

racker-terminal v1.1+ は Tauri 公式の `@tauri-apps/plugin-updater` を使用した自動更新機能を備えています。
Chrome 風のバックグラウンド DL フローを採用しており、起動時に GitHub Releases の `latest.json` をチェックし、
新バージョンがあれば **ユーザーに通知することなく自動でバックグラウンド DL** します。
DL 完了後にバッジを表示し、ユーザーが再起動を承認したときにインストール・再起動を行います。

## アーキテクチャ

```
[App.tsx 起動時 useEffect]
       ↓ runUpdateCheck() (起動時 1 回 + 以降 1 時間ごと)
[lib/updater.ts wrapper]
       ↓ checkForUpdate() → @tauri-apps/plugin-updater
[Tauri Rust runtime]
       ↓ HTTPS GET
[GitHub Releases /latest.json]
       ↓ UpdateAvailable
[appStore: updatePhase='downloading', 自動で downloadUpdate() 開始]
       ↓ バックグラウンドで DL (UI 変化なし)
[DL 完了 → updatePhase='ready']
       ↓ TitleBar が subscribe → バッジ表示
[ユーザーがバッジクリック]
       ↓ openUpdateDialog()
[UpdateDialog: DL 済みメッセージ + notes + 「今すぐ再起動」]
       ↓ applyUpdate() → installAndRelaunch()
[updatePhase: installing → 再起動]
```

## 状態遷移 (Chrome 風バックグラウンド DL フロー)

`updatePhase` の状態遷移を表で記載:

| from | event | to |
|---|---|---|
| idle | runUpdateCheck() 実行 | checking |
| checking | checkForUpdate() → null | idle |
| checking | checkForUpdate() → UpdateAvailable | downloading |
| downloading | downloadUpdate() 進行中 | downloading (継続、UI 変化なし) |
| downloading | downloadUpdate() 完了 | ready |
| downloading | downloadUpdate() 失敗 | idle (silently fail、次回起動でリトライ) |
| ready | runUpdateCheck() (定期チェック) → pending より新しい版あり | ready (裏で DL して pending を差し替え) |
| ready | runUpdateCheck() (定期チェック) → 新しい版なし / 取得失敗 | ready (pending 維持) |
| ready | applyUpdate() 実行 | installing |
| installing | installAndRelaunch() 後 | (プロセス終了) |
| installing | 例外発生 | error |
| error | applyUpdate() (リトライ) | installing |
| error | resetUpdateError() | idle |

### pendingUpdateHandle のライフサイクル

`pendingUpdateHandle` (モジュールスコープ変数) は以下のタイミングで管理される:
- check 成功で更新あり → set
- DL 失敗 → null クリア
- applyUpdate 成功 → relaunch でプロセス終了 (実質クリア)
- applyUpdate 失敗 (error phase) → 保持 (リトライのため)
- resetUpdateError → null クリア
- ready のまま待機中に、より新しいリリースを検出 → **その DL 完了後に差し替え**

### ready 中の差し替え (なぜ必要か)

racker は起動しっぱなしで使われるため、DL 済みバッジが何日も放置されることがある。
その間に出たリリースを拾わないと、バッジから入るのは常に「気付いた時点の次の版」になり、
**再起動のたびに 1 バージョンずつしか上がらない**。

そのため `runUpdateCheck()` は phase が `'ready'` のときも no-op にせず、
`refreshPendingUpdate()` (appStore.ts) を通す:

1. `checkForUpdate()` で最新 manifest を取り直す
2. `compareVersions()` で pending より新しいときだけ DL する
3. **DL 完了後**に `pendingUpdateHandle` / `updateInfo` を差し替える

DL 中に失敗しても、すでに DL 済みの古い pending がそのまま残るので「更新できる状態」を失わない。
差し替え中の再入は `refreshingPendingUpdate` フラグで防ぐ。phase は `'ready'` のまま動かさないので、
バッジは出したままになる。

## バッジ表示条件

```ts
const showBadge = updatePhase === 'ready' || updatePhase === 'error';
```

- `'downloading'` 中はバッジ非表示（完全無音）
- `'ready'`: 「↑」アイコン、ツールチップ「再起動して更新を適用」
- `'error'`: 「!」アイコン、ツールチップ「アップデートエラー」

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
- **チェック間隔は 1 時間**: 起動時に 1 回、以降は 1 時間ごと。リリース直後に
  「今すぐ再起動」を押した場合、最大 1 時間前の版が入ることがあります (次回チェックで最新に追いつきます)
- **`'error'` phase では再チェックしない**: インストールに失敗した状態は保持され、
  ユーザーがリトライするか `resetUpdateError()` で idle に戻すまで新しい版を取りに行きません
- **バックグラウンド DL 失敗は無音**: DL エラーはユーザーに通知せず idle に戻し、次回起動でリトライします

## 設定値

- `installMode: "passive"`: NSIS インストーラーが UI 最小・進捗バーのみで実行されます
- 配布形式: NSIS のみ (`bundle.targets: ["nsis"]`)
- updater 用署名アーティファクト生成: `bundle.createUpdaterArtifacts: true`
