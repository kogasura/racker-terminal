# 設計書: Unit H — StrictMode/HMR 復活 + forceDisposeAll + memory leak テスト

---

## 1. 概要・スコープ

Phase 2 の最終ユニット。Phase 1 で WebView2 二重マウント crash 対策として無効化していた
**StrictMode と HMR を復活**させ、`terminalRegistry` の参照カウント設計が実際に機能することを確認する。

これにより Phase 2 が完全に閉じる。

### Phase 2 Unit H でやること

- **StrictMode 有効化** (`src/main.tsx`)
- **HMR 有効化** (`vite.config.ts` の `hmr: false` 削除)
- **`forceDisposeAll()` 実装** (`src/lib/terminalRegistry.ts`)
- **HMR の `import.meta.hot.dispose` hook で `forceDisposeAll()` を呼ぶ** (`src/components/TerminalPane.tsx`)
- **memory leak テスト追加** (`src/lib/terminalRegistry.test.ts`)
- **docs/phase2-plan.md §4 Unit H に実装結果を反映**

### Phase 3 送り（スコープ外）

- WebGL renderer 復活（WebView2 での native crash 前科あり）
- 永続化 (persist middleware)
- グループ自体の D&D
- Tab.title の userTitle/oscTitle 分離

---

## 2. forceDisposeAll の実装と HMR hook

### 2.1 forceDisposeAll

```ts
export function forceDisposeAll(): void {
  // Map をコピーしてから dispose（dispose 中に Map が変化しないように）
  const entries = Array.from(runtimes.entries());
  for (const [tabId, entry] of entries) {
    entry.runtime.dispose();
    runtimes.delete(tabId);
  }
}
```

**責務**:
- すべての runtime を即時破棄して registry を空にする
- HMR の `import.meta.hot.dispose` hook から呼び、HMR 更新時に xterm/PTY がリークするのを防ぐ
- `dispose()` の呼び出し順序は §3.2 の規約通り（各 runtime の dispose() が担う）

**forceDisposeRuntime との違い**:
- `forceDisposeRuntime(tabId)`: 特定タブのみ即時破棄（タブ削除時）
- `forceDisposeAll()`: 全タブを一括破棄（HMR 時）

### 2.2 HMR hook の配置

`TerminalPane.tsx` の冒頭に配置する。モジュールトップレベルの条件分岐で実行される。

```ts
if (import.meta.hot) {
  // HMR 更新前に全 runtime を強制破棄して xterm/PTY のリークを防ぐ
  import.meta.hot.dispose(() => {
    forceDisposeAll();
  });
  // 全 reload に倒す（terminalRegistry の参照カウント前提を維持）
  import.meta.hot.invalidate();
}
```

**実行順序**:
1. HMR 更新検知 → `dispose(callback)` の callback が走る → `forceDisposeAll()` で runtime 全クリーンアップ
2. その後 `invalidate()` で full reload
3. リロード後は registry が空の状態から起動

**import.meta.hot の型について**:
- `import.meta.hot.dispose` は Vite の HMR API。dispose callback は HMR 更新「直前」に実行される（公式仕様）
- `invalidate()` を併用すると最終的に full reload になるが、その前に `dispose()` で cleanup が走る

---

## 3. StrictMode 復活戦略

### 3.1 全体方針

`terminalRegistry` の参照カウント方式（`acquireRuntime` / `releaseRuntime` + `queueMicrotask`）が
StrictMode の二重 mount → cleanup → mount サイクルを吸収する。

StrictMode サイクル:
```
mount-1:   acquireRuntime(tabId, init) → refs=1, init() 呼ばれる
cleanup-1: releaseRuntime(tabId) → refs=0, queueMicrotask で dispose 予約
mount-2:   acquireRuntime(tabId, init) → refs=1 (既存 entry あり), init() は呼ばれない
microtask: refs=1 なので dispose はキャンセル
```

PTY は init() の中で startSpawn を呼ぶが、startSpawn は `spawning || ptyHandle !== null` ガードがあるため
mount-2 で再び呼ばれても no-op になる。

### 3.2 各 useEffect の StrictMode 耐性

#### TerminalPane の 5 つの useEffect

| useEffect | deps | cleanup | StrictMode 耐性 |
|---|---|---|---|
| 初回 mount (1) | `[tabId]` | `setOnEvent(null)` + `releaseRuntime` | refcount で吸収。init() が 2 回呼ばれても既存 entry を返すだけ |
| isActive 切替 | `[isActive]` | `cancelAnimationFrame(rafId)` | rAF を cancel するため二重発火しない |
| tab.status (disableStdin) | `[tab.status]` | なし（同期副作用） | 再実行で同じ値を書くだけ。no-op |
| ResizeObserver | `[isActive]` | `observer.disconnect()` | disconnect で cleanup OK |
| キーボードショートカット | `[tabId]` | no-op ハンドラで上書き | 再 attach で正常動作 |

#### App.tsx の 2 つの useEffect

| useEffect | deps | cleanup | StrictMode 耐性 |
|---|---|---|---|
| 起動時自動初期化 | `[]` | なし | `if (groups.length === 0)` ガードで二重 createGroup を防止 |
| settings subscribe | `[]` | `unsub()` | cleanup で unsub、再 mount で再 subscribe。StrictMode 耐性あり |

### 3.3 removeTab の forceDispose → set 順序

Unit C alpha レビュー #1 で指摘された懸念:

```
removeTab:
  1. forceDisposeRuntime(tabId) → runtime.dispose(), runtimes.delete(tabId)
  2. set(state => ...) → React が TerminalPane を unmount
  3. TerminalPane cleanup: releaseRuntime(tabId) → runtimes.get(tabId) は undefined → no-op
```

StrictMode 下での検証ポイント (VH02):
- `removeTab` → `forceDisposeRuntime` → React unmount → `releaseRuntime` の順で重複 dispose 警告が出ないか
- `runtimes.delete(tabId)` 後に `releaseRuntime` が呼ばれても `runtimes.get(tabId)` は `undefined` なので no-op

### 3.4 DragOverlay Portal の StrictMode 影響

Unit F beta レビューで指摘済み (F-β3):
- `createPortal` が二重 mount される懸念
- DragOverlay は `document.body` に直接描画するため、StrictMode の二重 mount で残留する可能性がある

検証シナリオ VH06 で確認:
- D&D 開始 → ESC キャンセル を 5 回繰り返し、`document.body` の DragOverlay 残留が無いか

---

## 4. memory leak テスト仕様

### 4.1 テスト戦略

vitest の jsdom 環境では実際の xterm/PTY は作れないため、mock runtime で `getRuntimeCount()` を検証する。
実 PTY のリーク検証は手動 E2E（タスクマネージャでプロセス数監視）で行う。

### 4.2 テストケース一覧

#### TH01: forceDisposeAll で全 runtime が即時破棄される

```ts
for (let i = 0; i < 10; i++) acquireRuntime(`tab-${i}`, () => createMockRuntime());
expect(getRuntimeCount()).toBeGreaterThanOrEqual(10);
forceDisposeAll();
// 登録した 10 個が全て消えていること
for (const id of ids) {
  expect(getRefs(id)).toBe(0);
}
```

**期待動作**: `forceDisposeAll()` 後、登録した全タブの refs が 0 になる。

#### TH02: 100 タブ open/close で runtime がリークしない

```ts
const before = getRuntimeCount();
const disposeMock = vi.fn();
for (let i = 0; i < 100; i++) {
  acquireRuntime(`tab-${i}`, () => createMockRuntime(disposeMock));
  forceDisposeRuntime(`tab-${i}`);
}
expect(getRuntimeCount()).toBe(before);
expect(disposeMock).toHaveBeenCalledTimes(100);
```

**期待動作**: ループ終了後に runtime 数が増えていない。dispose が 100 回呼ばれている。

#### TH03: StrictMode 二重 mount → release → mount で dispose されない (refcount 吸収)

```ts
acquireRuntime('t1', init);  // mount-1, refs=1
acquireRuntime('t1', init);  // mount-2 (StrictMode), refs=2 (init は呼ばれない)
releaseRuntime('t1');        // cleanup-1, refs=1
await new Promise(r => queueMicrotask(() => r(null)));
expect(getRuntimeCount()).toBeGreaterThanOrEqual(1);
expect(getRefs('t1')).toBe(1);  // microtask 後も生存
expect(init).toHaveBeenCalledOnce();
```

**期待動作**: microtask 後も runtime が生存している。init() は 1 回しか呼ばれない。

---

## 5. 検証シナリオ VH01〜VH10

| ID | シナリオ | 期待結果 |
|---|---|---|
| VH01 | StrictMode 有効でアプリ起動 | nushell プロンプトが 1 つだけ表示（二重 spawn なし） |
| VH02 | 新規タブ作成 → 削除を 10 回繰り返す | runtime/PTY がリークしない (DevTools で確認) |
| VH03 | HMR トリガー (適当な ts ファイルを編集して保存) | full reload 後にタブ状態がリセットされる、ターミナルが再起動 |
| VH04 | 編集中タブの HMR | 編集状態は失われるが、リロード後の操作は正常 |
| VH05 | crashed タブの restart | recyclePty が StrictMode 下で正常動作、scrollback 保持 |
| VH06 | D&D 中に DragOverlay 表示 → ESC キャンセル | DragOverlay が完全に DOM から消える (StrictMode 下) |
| VH07 | StrictMode 下で Ctrl+Tab 連打 | activeTabId が正しく遷移、xterm focus も追従 |
| VH08 | お気に入りクリック → 新タブ spawn | StrictMode 下でも正常動作 |
| VH09 | OSC タイトル更新 | StrictMode 下でも正しく反映、編集中ガード動作 |
| VH10 | 大量タブ (20+) 状態で HMR | リロード後に新しいセッションが立つ |

**手動 E2E は発注者の責務**（自動テストが pass していれば自動検証は完了）。

---

## 6. リスク・注意

### 6.1 StrictMode 復活で破綻する未知のバグ

- 各 Unit の設計時に StrictMode を意識して書いてはあるが、実機検証は今回が初めて
- 破綻が見つかった場合の対処:
  - 軽微なら同じ PR 内で修正
  - 根深い場合は StrictMode 復活を保留して Phase 3 送り

### 6.2 `import.meta.hot.dispose` のタイミング

- `dispose` callback は HMR 更新「直前」に走る（公式仕様）
- `invalidate()` を併用すると最終的に full reload になるが、その前に `dispose()` で cleanup が走る
- 順序: `dispose(forceDisposeAll)` → `invalidate()` で登録すれば期待通り動作

### 6.3 memory leak テストの限界

- vitest の jsdom 環境では実際の xterm/PTY は作れない
- mock runtime で `getRuntimeCount()` を検証するのが現実的
- 実 PTY のリーク検証は手動 E2E（タスクマネージャでプロセス数監視）で

### 6.4 DragOverlay Portal の StrictMode 影響

- Unit F beta レビューで指摘済み (F-β3)
- VH06 で検証する。問題があれば DragOverlay の wrapping を見直す

### 6.5 removeTab の forceDispose → set 順序

- Unit C alpha レビュー #1 で StrictMode 復活時に問題化する懸念あり
- VH02 で繰り返し検証。問題があれば順序を変更

---

## 7. 後続フェーズ（Phase 3）送り項目

| 項目 | 理由 |
|---|---|
| WebGL renderer 復活 | Phase 1 での WebView2 native crash 前科。専用検証が必要 |
| 永続化 (persist) | `partialize` 設計は phase2-plan.md §3.1 に記載済み。OSC title の競合問題も解決が必要 |
| グループ自体の D&D | moveGroup は Unit B で先回り実装済み。UI 側の実装が必要 |
| Tab.title の userTitle/oscTitle 分離 | 動的書き換えと persist の競合をフリッカーなしで解決する設計が必要 |
| `compatibility-matrix.md` 作成 | Phase 2 完成後のアーキテクト推奨事項 |
| Phase 3 設計書スケルトン | 永続化・WebGL・title 分離・グループ D&D を含む次フェーズの設計 |
