# 設計書: Unit C — InlineEdit + 右クリックメニュー + restart/recyclePty

---

## 1. 概要・スコープ

### やること

- **InlineEdit コンポーネント**: タブ名・グループ名のサイドバー内インライン編集（自作 input 切替式、IME 対応）
- **右クリックメニュー**: `@radix-ui/react-context-menu` を導入
  - タブ用: リネーム / 複製 / 閉じる
  - グループ用: リネーム / 新規タブを追加 / グループを閉じる（最後の 1 個は disabled）
- **タブ複製 (`duplicateTab`)**: 同一グループ内に shell/cwd/env を引き継いで新規 spawn、title に " (copy)" 付与
- **タブリネーム (`updateTabTitle`)**: trim + 64 文字制限
- **restart ボタン + `recyclePty`**: crashed タブの復活時に xterm を維持して PTY のみ差し替え（scrollback 保全）
- **`contextMenuOpen` フラグ**: ContextMenu が開いている間、TerminalPane のキーバインドを suspend

### やらないこと（後続ユニット送り）

- お気に入りの登録・spawn・UI（Unit D+E）
- OSC タイトル自動更新（Unit D+E）
- D&D（Unit F）
- StrictMode/HMR 復活（Unit H）

---

## 2. InlineEdit の状態遷移図

```
[表示モード]
    |
    |-- ダブルクリック ------> [編集モード]
    |                               |
    |-- 右クリック「リネーム」 ---> [編集モード]
    |                               |
    |                  +--- Enter (isComposing=false) ---+
    |                  |                                 |
    |                  +--- blur / 外クリック -----------+---> onCommit(value) -> [表示モード]
    |                  |                                 |
    |                  +--- IME Enter (isComposing=true) -> (無視、IME 確定のみ)
    |                  |
    |                  +--- Escape ------------------> stopEditing() -> [表示モード]
    |                               |                  (元タイトル維持)
    |                               |
    |                    IME 中の Escape → stopEditing() (IME キャンセル同等)
    |
    |-- D&D 開始時 (Unit F で実装) -> stopEditing() -> [表示モード]
```

### 実装の要点

- `editingId === id` が true のとき input を表示、false のとき span を表示
- `onCompositionStart/End` で `isComposing` フラグ（ref）を管理
- `onKeyDown` 内で必ず `e.stopPropagation()` を呼ぶ（Sidebar の Enter/Space ヘッダ操作との競合防止）
- 確定時: `onCommit(value)` + `stopEditing()`
- キャンセル時: `stopEditing()` のみ（value はリセットしない。次回編集開始時に title から再同期される）
- `useEffect([isEditing])`: isEditing=true になった瞬間に `setValue(title)` + `input.focus()` + `select()`

---

## 3. ContextMenu 構造とフラグ管理

### コンポーネント構造

```tsx
<ContextMenu.Root onOpenChange={(open) => setContextMenuOpen(open)}>
  <ContextMenu.Trigger disabled={isEditing} asChild>
    <div>{/* タブ/グループ本体 */}</div>
  </ContextMenu.Trigger>

  <ContextMenu.Portal>
    <ContextMenu.Content className="context-menu__content">
      <ContextMenu.Item onSelect={...}>リネーム</ContextMenu.Item>
      <ContextMenu.Item onSelect={...}>複製</ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item className="...--danger" onSelect={...}>閉じる</ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
```

### `contextMenuOpen` フラグ管理

1. `ContextMenu.Root` の `onOpenChange` で `setContextMenuOpen(open)` を呼ぶ
2. `TerminalPane` の `attachCustomKeyEventHandler` 内で以下を確認する:

```typescript
// ContextMenu が開いている間はキーバインドを suspend
if (useAppStore.getState().contextMenuOpen) return true;
```

### 編集中の ContextMenu 無効化

- `<ContextMenu.Trigger disabled={isEditing}>` で編集中の右クリックを無効化する
- これにより InlineEdit と ContextMenu の UX 競合を防ぐ

---

## 4. recyclePty のシーケンス図

```
ユーザー: "Click to restart" ボタンをクリック
     |
     v
TerminalPane.handleRestart()
     |
     +-- setTabStatus(tabId, 'spawning')   [UI: crashed → spawning]
     |
     +-- recyclePty(tabId, opts, onError)
             |
             v
         terminalRegistry.recyclePty()
             |
             +-- entry = runtimes.get(tabId)
             |   (なければ return)
             |
             +-- void runtime.ptyHandle?.dispose()   [旧 PTY を fire-and-forget で解放]
             |   (xterm インスタンスは維持 → scrollback 保全)
             |
             +-- runtime.resetForRecycle()
             |   (ptyHandle = null, spawning = false にリセット)
             |
             +-- runtime.startSpawn(opts, onError)
                     |
                     +-- (spawn 失敗) --> onError(msg) --> setTabStatus(tabId, 'crashed')
                     |
                     +-- (spawn 成功) --> callbacks.onLive(ptyId)
                                              |
                                              v
                                         createRuntime 時の onLive
                                         = setTabStatus(tabId, 'live', ptyId)
                                              |
                                              v
                                         [UI: spawning → live]
```

### 設計上の注意

- `forceDisposeRuntime` は使わない（xterm ごと破棄すると scrollback が失われる）
- `ptyHandle` はクロージャ変数のため外部から直接 null にできない
  → `resetForRecycle()` メソッドで内部から null + spawning=false にリセットする
- `startSpawn` の内部 `callbacks.onLive` は `createRuntime` 時に渡したコールバックが使われる
  → `recyclePty` に独自の `onLive` を渡す必要はない

---

## 5. updateTabTitle / duplicateTab の実装メモ

### updateTabTitle

```typescript
updateTabTitle(tabId, title) {
  const trimmed = title.trim().slice(0, 64);
  if (trimmed.length === 0) return;  // 空文字列は no-op（元タイトル維持）
  set(state => {
    const tab = state.tabs[tabId];
    if (!tab) return {};  // 存在しない tabId は no-op
    return { tabs: { ...state.tabs, [tabId]: { ...tab, title: trimmed } } };
  });
}
```

### duplicateTab

```typescript
duplicateTab(tabId) {
  const newTabId = newId();
  let inserted = false;
  set(state => {
    const src = state.tabs[tabId];
    if (!src) return {};  // 存在しない tabId → null を返すための早期リターン

    const newTab = {
      id: newTabId,
      groupId: src.groupId,
      title: `${src.title} (copy)`,
      shell: src.shell, cwd: src.cwd, env: src.env,
      status: 'spawning' as const,
    };

    // 元タブの直後に挿入
    const updatedGroups = state.groups.map(g => {
      if (g.id !== src.groupId) return g;
      const idx = g.tabIds.indexOf(tabId);
      const newTabIds = [...g.tabIds];
      newTabIds.splice(idx === -1 ? newTabIds.length : idx + 1, 0, newTabId);
      return { ...g, tabIds: newTabIds };
    });

    inserted = true;
    return { groups: updatedGroups, tabs: { ...state.tabs, [newTabId]: newTab }, activeTabId: newTabId };
  });
  return inserted ? newTabId : null;
}
```

---

## 6. 検証シナリオ VC01〜VC10

| # | シナリオ | 期待結果 |
|---|---|---|
| VC01 | タブ名をダブルクリック | InlineEdit が表示され入力欄にフォーカスが当たる |
| VC02 | 編集中に Enter | 新タイトルが確定される（IME 確定 Enter を除く） |
| VC03 | 編集中に Escape | 元タイトルに戻る |
| VC04 | 編集中に他タブをクリック（blur） | 新タイトルが確定される |
| VC05 | IME（日本語変換）中に Enter | IME 確定のみ行われ、InlineEdit は確定しない |
| VC06 | タブを右クリック → リネーム | InlineEdit が起動する |
| VC07 | タブを右クリック → 複製 | 同グループの直後に " (copy)" タブが追加される |
| VC08 | タブを右クリック → 閉じる | removeTab が呼ばれタブが削除される |
| VC09 | グループ名を右クリック → リネーム / 新規タブ / グループを閉じる | 各アクションが正常に動作する |
| VC10 | nushell exit → crashed → restart ボタン | 同 xterm に新プロンプトが表示され scrollback が保持される |
| VC11 | ContextMenu 開いている間に Ctrl+Tab | タブ切替が効かない（suspend 確認） |
| VC12 | 編集中に右クリック | ContextMenu が開かない（Trigger disabled） |

---

## 7. 後続ユニット送り

| 機能 | 後続ユニット |
|---|---|
| D&D 開始時の `stopEditing()` 呼び出し | Unit F（`onDragStart` 側の責務） |
| お気に入りの右クリックメニュー（ここから spawn / 削除） | Unit D+E |
| OSC タイトルと updateTabTitle の競合（フリッカー問題） | Phase 3（title を「ユーザー編集 title」と「OSC title」に分離） |
| StrictMode 復活後の recyclePty 動作確認 | Unit H |
| scrollback の永続化 | 実施しない（PTY 出力と一蓮托生のため。Phase 3 設計書に明記） |
