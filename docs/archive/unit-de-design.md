# 設計書: Unit D+E — Favorites + OSC タイトル + applySettings + Rust 残追加

---

## 1. 概要・スコープ

### やること

- **Favorites（お気に入り）**: タブの spawn 設定をワンクリックで登録・起動する機能
  - `appStore` に `addFavorite` / `removeFavorite` / `spawnFavorite` の 3 アクション追加
  - `FavoritesSection` コンポーネント: Sidebar 上部に表示（折りたたみ可）
  - `TabItem` 右クリックメニューに「お気に入りに追加」を追加
- **OSC タイトル自動更新**: `term.onTitleChange` を `titleSub` として購読し、タブ名を自動更新
  - 編集中ガード: `editingId === tabId` のとき OSC を無視してユーザー編集を保護
  - 256 文字制限: `title.slice(0, 256)` で切り詰めてから `updateTabTitle` を呼ぶ
- **Settings リアクティブ反映 (`applySettings`)**: Settings 変更を全タブの xterm に broadcast
  - `TerminalRuntime` に `applySettings(settings: Settings): void` メソッド追加
  - `App.tsx` の `useAppStore.subscribe` 経路で全 runtime に broadcast
- **Rust 残追加**: back-pressure + eprintln 抑制 + 定数集約

### やらないこと（後続ユニット送り）

- お気に入りの永続化（Phase 3 送り、persist ON 対象）
- Settings 編集 UI（Phase 3 送り）
- D&D（Unit F）
- StrictMode/HMR 復活（Unit H）
- `Tab.title` を「ユーザー編集 title」と「OSC title」に分離（Phase 3 設計書に記録のみ）

---

## 2. Favorites の状態遷移

```
[お気に入り登録]
    |
    |-- TabItem 右クリック → 「お気に入りに追加」
    |        |
    |        v
    |   addFavorite({ title, shell, cwd, env })
    |        |
    |        v
    |   favorites[] に push, 新 id を返す
    |
    v
[FavoritesSection に表示]
    |
    |-- 左クリック / 右クリック「ここから spawn」
    |        |
    |        v
    |   spawnFavorite(favId)
    |        |
    |        v
    |   createTab(undefined, { title, shell, cwd, env }) を内部呼び出し
    |   activeTabId を新タブに設定
    |   新タブ ID を返す
    |
    |-- 右クリック「削除」
             |
             v
        removeFavorite(favId)
             |
             v
        favorites[] から除去（spawn 済みタブには影響しない）
```

### 設計上の注意

- `spawnFavorite` は `createTab` を内部で呼び出すため、グループ解決ロジックは `createTab` に委譲する
- お気に入り削除後も、そのお気に入りから spawn 済みのタブは独立コピーとして存続する
- Phase 2 はメモリ内のみ。Phase 3 で persist ON 対象として `favorites` を `partialize` する

---

## 3. applySettings broadcast シーケンス

```
ユーザー (または手動 setState) が settings を変更
    |
    v
useAppStore の状態が更新される
    |
    v
App.tsx の useEffect 内 useAppStore.subscribe が反応
    |
    |-- state.settings === prev → no-op（参照変化なし）
    |
    |-- state.settings !== prev → 全 runtime に broadcast
             |
             v
        getAllRuntimes() → TerminalRuntime[]
             |
             v
        r.applySettings(state.settings) を全 runtime に呼ぶ
             |
             v
        term.options.fontSize = settings.fontSize
        term.options.fontFamily = settings.fontFamily
        term.options.scrollback = settings.scrollback
```

### 設計判断

- `subscribeWithSelector` middleware は導入しない（Zustand v5 標準 API のみ使用）
- 前回値比較（`state.settings === prev`）で settings の参照変化のみに反応させる
- フォント変更後の `fitAddon.fit()` 明示呼び出しは不要（xterm 内部の Canvas renderer が再計算する）
- Phase 2 段階では Settings 編集 UI はないため、手動 `store.setState` でのみ検証可能

---

## 4. OSC タイトルガードの仕組み

```
term.onTitleChange(title) が発火
    |
    v
titleSub コールバック内
    |
    |-- isDisposed === true → no-op（dispose 後の書き込みを防ぐ）
    |
    |-- editingId === tabId → no-op（ユーザー編集中は OSC を無視）
    |
    v
updateTabTitle(tabId, title.slice(0, 256))
    |
    v
tabs[tabId].title が更新される（trim + 64 文字制限は updateTabTitle 内で適用）
```

### 編集中ガードの根拠

- ユーザーが InlineEdit でタブ名を編集中に nushell 等が OSC タイトルを書き込む場合がある
- `editingId === tabId` のとき `updateTabTitle` を呼ばないことで、入力中のテキストが上書きされる UX を防ぐ
- Phase 3 で `Tab.title` を「ユーザー編集 title」と「OSC title」に分離する余地を残す（設計上の負債として記録）

### dispose 後のガード

- `isDisposed` チェックで `dispose()` 後の遅延コールバックを無害化する
- `titleSub.dispose()` を `dispose()` 内で呼んで購読を解除する

---

## 5. Rust 残追加の設計

### 5.1 back-pressure (`raw_buf`)

- 上限: `RAW_BUF_LIMIT_BYTES = 4 * 1024 * 1024`（4MB）
- 超えたら: 古い半分（`raw_buf.len() / 2`）を `drain` で破棄し `[output truncated]` マーカーを挿入
- 位置: read スレッドの `raw_buf.extend_from_slice` 直後
- 目的: `yes` / `find /` 等の暴走出力による OOM を防ぐ
- マーカーは Rust 側で Data イベントとして注入（Frontend は単なる文字列として受領）

### 5.2 `dbg_log!` マクロ

- `#[cfg(debug_assertions)]` で囲む代わりにローカルマクロを定義して全 `eprintln!` を置換
- release ビルドでログが漏れないよう制御する
- Phase 3 で telemetry 収集が必要になったら `tracing` クレートへ移行を検討

### 5.3 定数集約

- `TINY_READ_THRESHOLD = 256`: tiny read 判定のバイト数閾値
- `TINY_READ_MIN_INTERVAL_MS = 2`: tiny read 判定の最小間隔（ミリ秒）
- `RAW_BUF_LIMIT_BYTES = 4 * 1024 * 1024`: raw_buf の OOM 上限

---

## 6. 検証シナリオ VD01〜VD07

| # | シナリオ | 期待結果 |
|---|---|---|
| VD01 | 起動時に Favorites セクションが表示される（初期は空） | 「お気に入りはまだありません」プレースホルダーが表示される |
| VD02 | タブ右クリック → 「お気に入りに追加」 | Favorites セクションにお気に入りが登録される |
| VD03 | Favorite クリック | 新タブが spawn され、shell/cwd/env が引き継がれる |
| VD04 | Favorite 右クリック → 「削除」 | Favorites セクションからお気に入りが消える |
| VD05 | nushell で `printf '\033]0;TestTitle\007'` を実行 | タブ名が "TestTitle" に変わる |
| VD06 | タブ名を編集中に OSC を発火させる | 編集中の入力が壊れない（OSC が無視される） |
| VD07 | `store.setState({ settings: { fontSize: 16, ... } })` | 全タブの xterm フォントサイズが即時変わる |

---

## 7. 後続ユニット送り

| 機能 | 後続ユニット |
|---|---|
| お気に入りの永続化（persist ON） | Phase 3 |
| Settings 編集 UI（フォントサイズ・テーマ切替） | Phase 3 |
| `Tab.title` の「ユーザー編集 title」と「OSC title」分離 | Phase 3 |
| D&D（タブ/グループの並び替え） | Unit F |
| StrictMode/HMR 確認 | Unit H |
| `applySettings` で `fitAddon.fit()` が必要か否かの検証 | Phase 3（Settings UI 導入後） |
