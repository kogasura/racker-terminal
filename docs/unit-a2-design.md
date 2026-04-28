# 設計書: Unit A2 TerminalPane 可視性 PoC + 最小マルチタブ UI（v2）

> v2 改訂: 「runtime はコンポーネントスコープに依存しない」原則に沿い、
> TerminalRuntime インターフェースを再設計。dispose 順序・spawn 二重起動防止・
> unmount 後の Promise 処理を runtime 側に集約した。

---

## 1. 概要

### やること

Unit A1 で整備した terminalRegistry（acquireRuntime / releaseRuntime / forceDisposeRuntime）を TerminalPane に組み込み、
全タブを常時マウントしながら visibility:hidden で切り替える選択肢 B のアーキテクチャを確立する。
加えて、最小限の Sidebar を実装し（タブ一覧、新規タブボタン、削除ボタン）、複数 PTY セッションを UI から操作できる状態にする。

### コア原則

**runtime はコンポーネントスコープに依存しない。**

- `TerminalRuntime` が xterm / PTY / onData 購読 / pendingInputs バッファ / 状態フラグのすべての所有者
- `init()` は runtime を 1 度だけ生成し、`onDataSub` も 1 度だけ登録する
- `TerminalPane` は `acquireRuntime` 経由で runtime を取得し、**メソッド呼び出しのみ**行う（フィールドへの直接代入不可）
- `runtime.dispose()` は terminalRegistry.ts の単独責務として完結する

### やらないこと（後続ユニット送り）

- グループの折りたたみ・リッチ表示（Unit B）
- インライン編集、右クリックメニュー、restart ボタン（Unit C）
- お気に入り、OSC タイトル自動更新、Condvar flush 改善（Unit D+E）
- D&D（Unit F）
- キーボードショートカット Ctrl+Tab 等（Unit G）
- StrictMode / HMR 復活の最終確認（Unit H）
- 永続化（Phase 3）

---

## 2. コンポーネント階層図

```
App
├── Sidebar  240px 固定幅
│   ├── タブリスト
│   │   └── TabItem × N  クリック=setActiveTab  ×=removeTab
│   └── + New Tab ボタン  createTab
└── TerminalPaneContainer  flex-1 position:relative
    ├── TerminalPane tabId=A isActive=true   visible
    ├── TerminalPane tabId=B isActive=false  visibility:hidden
    └── TerminalPane tabId=C isActive=false  visibility:hidden
```

レイアウト全体（App.tsx）:

- Sidebar: `width: var(--sidebar-width)` `flex-shrink: 0`
- TerminalPaneContainer: `flex: 1` `position: relative` `overflow: hidden`
---

## 3. TerminalRuntime インターフェース（改訂）

### 3.1 インターフェース定義

```typescript
// src/lib/terminalRegistry.ts

export interface TerminalRuntime {
  term: XTerm;
  fitAddon: FitAddon;
  /** PTY spawn 完了までは null */
  ptyHandle: PtyHandle | null;
  /** spawn 完了前に xterm が送出した入力（DSR-CPR 等）を貯めるバッファ */
  pendingInputs: string[];
  /** init() 内で 1 度だけ登録する onData 購読。dispose() で解放 */
  onDataSub: IDisposable;

  /**
   * PTY イベント受信時のコールバック。
   * TerminalPane の useEffect 内で登録し、cleanup で null を渡す。
   * null の場合 runtime は何もしない（unmount 後の書き込みを防ぐ）。
   */
  setOnEvent(handler: ((e: PtyEvent) => void) | null): void;

  /**
   * PTY spawn を開始する。内部で spawning フラグを管理し、
   * 二重呼び出し（ptyHandle セット済み or spawn 中）は no-op。
   */
  startSpawn(opts: SpawnOptions, onError: (e: Error) => void): void;

  /**
   * 全リソース解放。呼び出し順は §3.2 に従う。
   * ResizeObserver の disconnect は TerminalPane の useEffect cleanup 側の責務。
   */
  dispose(): void;
}
```

`titleSub?: IDisposable` フィールドは Unit D+E の OSC タイトル変更対応のためのスケッチとして、
実装ファイルのコメントに残しておく（A2 では未実装）。

### 3.2 dispose の実行順序（WebView2 クラッシュ防止）

```typescript
dispose() {
  isDisposed = true;          // 以降の setOnEvent / startSpawn 等を無害化
  setOnEvent(null);           // PTY イベントハンドラ参照を切る
  onDataSub.dispose();        // xterm の onData 購読停止
  titleSub.dispose();         // OSC タイトル購読停止 (Unit D+E)
  oscSub.dispose();           // OSC 7 cwd 追跡購読停止 (Phase 4 P-G)
  compositionAbort.abort();   // IME compositionstart/end リスナー解除 (P-D3)
  webglAddon?.dispose();      // WebGL context 解放 (Phase 3 Unit P-C1)
  fitAddon.dispose();
  ptyHandle?.dispose();       // fire-and-forget (Promise は await しない)
  term.dispose();             // 必ず最後 (WebView2 クラッシュ防止)
}
```

この順序を変えない。特に `term.dispose()` を先に呼ぶと WebView2 がクラッシュする場合がある（WebGL アドオン起因）。
`webglAddon?.dispose()` は `fitAddon.dispose()` より前、`compositionAbort.abort()` より後に呼ぶ。

### 3.3 startSpawn の内部仕様

```typescript
startSpawn(opts, onError) {
  if (spawning || ptyHandle !== null) return;  // 二重起動防止
  spawning = true;
  spawnPty(opts, (e) => onEventHandler?.(e))
    .then((handle) => {
      if (isDisposed || !runtimes.has(tabId)) {
        // unmount 後 or forceDispose 後: PTY だけ確実に解放してリターン
        void handle.dispose();
        return;
      }
      ptyHandle = handle;
      for (const data of pendingInputs) {
        void writePty(handle.id, data).catch(() => {});
      }
      pendingInputs.length = 0;
      void resizePty(handle.id, term.cols, term.rows).catch(() => {});
      setTabStatus(tabId, 'live', handle.id);
    })
    .catch((e) => {
      spawning = false;
      if (isDisposed) return;
      onError(e instanceof Error ? e : new Error(String(e)));
    });
}
```

`runtimes.has(tabId)` チェックにより、forceDispose 後に Promise が解決しても PTY リークが発生しない。
---

## 4. TerminalPane の useEffect ライフサイクル

### 4.1 初回マウント useEffect（依存配列: [tabId]）

```typescript
useEffect(() => {
  // 1. runtime を取得（初回: 生成、StrictMode 2 回目: 既存を返す）
  const runtime = acquireRuntime(tabId, () => createRuntime(divRef.current!, settings));
  runtimeRef.current = runtime;

  // 2. PTY イベントハンドラを登録
  runtime.setOnEvent((e) => handlePtyEvent(e, runtime));

  // 3. spawn 開始（runtime 側で二重起動防止済み）
  if (tab.status === 'spawning') {
    runtime.startSpawn(
      { shell: tab.shell, cwd: tab.cwd, cols: runtime.term.cols, rows: runtime.term.rows },
      (err) => {
        spawnErrorRef.current = err.message;
        setTabStatus(tabId, 'crashed');
      },
    );
  }

  return () => {
    runtime.setOnEvent(null);   // unmount 後のイベントを遮断
    runtimeRef.current = null;
    releaseRuntime(tabId);
  };
}, [tabId]);
```

`createRuntime` は terminalRegistry.ts の内部ファクトリ関数（or TerminalPane からのコールバック）として実装する。
`divRef.current` は mount 時点で必ず存在するため non-null assertion を使う。

### 4.2 PTY イベントハンドラ

```typescript
function handlePtyEvent(e: PtyEvent, runtime: TerminalRuntime) {
  switch (e.type) {
    case 'data':
      runtime.term.write(e.text);  // 非アクティブタブでも継続。スクロールバックに蓄積
      break;
    case 'exit':
      exitCodeRef.current = e.code ?? null;
      setTabStatus(tabId, 'crashed');
      break;
    case 'error':
      spawnErrorRef.current = e.message;
      setTabStatus(tabId, 'crashed');
      break;
  }
}
```

### 4.3 isActive 切替 useEffect（依存配列: [isActive]）

```typescript
useEffect(() => {
  if (!isActive) return;
  const runtime = runtimeRef.current;
  if (!runtime) return;

  const rafId = requestAnimationFrame(() => {
    try { runtime.fitAddon.fit(); } catch (e) { console.warn(e); }
    if (runtime.ptyHandle) {
      void resizePty(runtime.ptyHandle.id, runtime.term.cols, runtime.term.rows).catch(() => {});
    }
    runtime.term.focus();   // V15: タブ切替時にフォーカスを渡す
  });
  return () => cancelAnimationFrame(rafId);
}, [isActive]);
```

### 4.4 ResizeObserver（TerminalPane の useEffect 内で管理）

ResizeObserver は runtime には持たない。TerminalPane の useEffect 内で attach/detach し、
`runtime.term` と `runtime.fitAddon` を参照する。

```typescript
useEffect(() => {
  const runtime = runtimeRef.current;
  if (!runtime) return;

  const observer = new ResizeObserver(() => {
    if (!isActive) return;   // 非アクティブ時はスキップ（isActive 復帰時の rAF fit で同期）
    try { runtime.fitAddon.fit(); } catch (e) { console.warn(e); }
    if (runtime.ptyHandle) {
      void resizePty(runtime.ptyHandle.id, runtime.term.cols, runtime.term.rows).catch(() => {});
    }
  });
  observer.observe(divRef.current!);
  return () => observer.disconnect();   // disconnect は TerminalPane の cleanup 責務
}, [isActive]);   // isActive が変わると ResizeObserver を付け直す
```

### 4.5 コンポーネント内の useRef 一覧

| ref | 型 | 用途 |
|---|---|---|
| `divRef` | `HTMLDivElement` | `xterm.open()` のマウント先 DOM |
| `runtimeRef` | `TerminalRuntime \| null` | useEffect 間の runtime 共有 |
| `exitCodeRef` | `number \| null` | PTY Exit イベントの code（オーバーレイ表示用） |
| `spawnErrorRef` | `string \| null` | spawn 失敗メッセージ（オーバーレイ表示用） |

`pendingResizeRef` は削除。ResizeObserver の非アクティブ時スキップと rAF fit で代替する。

### 4.6 JSX 構造（抜粋）

```tsx
// inert: React 19 では boolean で渡せる。@ts-expect-error は不要
<div
  ref={divRef}
  style={{
    position: 'absolute', inset: 0,
    visibility: isActive ? 'visible' : 'hidden',
    pointerEvents: isActive ? 'auto' : 'none',
  }}
  inert={!isActive ? true : undefined}
>
  {status === 'crashed' && isActive && (
    <div style={{ position: 'absolute', inset: 0, /* 薄赤背景 */ }}>
      {exitCodeRef.current !== null
        ? `[Exited (code: ${exitCodeRef.current})]`
        : `[Spawn Error: ${spawnErrorRef.current}]`}
    </div>
  )}
</div>
```

**HMR 無効化（Phase 1 から引き継ぎ）**: TerminalPane.tsx ファイル先頭に以下を追加する。

```typescript
if (import.meta.hot) { import.meta.hot.invalidate(); }
```

**crashed 中の入力**: `status === 'crashed'` のとき `runtime.term.options.disableStdin = true` をセット、
または `onData` 内で status チェックして入力をサイレントに drop する（restart は Unit C 送り）。

**React.memo**: `TerminalPane` は `React.memo` でラップする。
---

## 5. TerminalPaneContainer

```typescript
export const TerminalPaneContainer = React.memo(function TerminalPaneContainer() {
  const tabs        = useAppStore(s => s.tabs);
  const activeTabId = useAppStore(s => s.activeTabId);
  const tabList     = Object.values(tabs);

  if (tabList.length === 0) return <EmptyPlaceholder />;

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      {tabList.map(tab => (
        <TerminalPane
          key={tab.id}
          tabId={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
        />
      ))}
    </div>
  );
});
```

- `key={tab.id}` 固定。tab オブジェクト参照が変わっても TerminalPane は unmount されない
- `Object.values(tabs)` の参照変動を抑えるため、selector を細粒度化するか `zustand/shallow` を検討する（§9 V16 の実測で判断）

---

## 6. appStore の追加アクション

### 追加アクション一覧（Unit A2 スコープ）

```typescript
createGroup: (title?: string) => string;
createTab: (groupId?: string, opts?: Partial<Pick<Tab, 'title' | 'shell' | 'cwd' | 'env'>>) => string;
removeTab: (tabId: string) => void;
setTabStatus: (tabId: string, status: TabStatus, ptyId?: string) => void;
```

既存の `setActiveTab / startEditing / stopEditing` は維持する。

### createGroup

A2 では起動時の default グループ自動生成のみに使用。Unit B でリッチなグループ UI を追加するまで Sidebar には表示しない。

### createTab

処理順: `tabId = newId()` → `groupId` を解決（未指定時は先頭グループ、なければ default グループを自動作成）→ Tab 生成（`status: 'spawning'`）→ グループの `tabIds` に追加 → `activeTabId` を更新 → `tabId` を返す。

createTab 内では PTY 操作を行わない。TerminalPane が mount されてから `status=spawning` を検知して `runtime.startSpawn()` を呼ぶ。

### removeTab

```typescript
removeTab: (tabId) => {
  // 1. forceDisposeRuntime（runtime 側が所有するすべてのリソースを即時解放）
  forceDisposeRuntime(tabId);
  // 2. store から削除（React が TerminalPane を unmount → releaseRuntime が無害化される）
  set(state => {
    const newGroups = state.groups.map(g => ({
      ...g,
      tabIds: g.tabIds.filter(id => id !== tabId),
    }));
    const { [tabId]: _, ...newTabs } = state.tabs;
    const removedTab = state.tabs[tabId];
    const newActiveTabId =
      state.activeTabId === tabId
        ? selectFallbackTab(removedTab?.groupId ?? '', newGroups)
        : state.activeTabId;
    return { groups: newGroups, tabs: newTabs, activeTabId: newActiveTabId };
  });
},
```

`forceDisposeRuntime` を `set` より先に呼ぶ理由: `set` が先に走ると React が TerminalPane を unmount し `releaseRuntime` が呼ばれる。
その後 `forceDisposeRuntime` が来ると競合するため、先に registry から削除して unmount 時の `releaseRuntime` を無害化する。

Unit H で StrictMode を復活させた際、この順序が問題を起こさないか再確認が必要（§11 未解決事項を参照）。

### setTabStatus

```typescript
setTabStatus: (tabId, status, ptyId) => {
  set(s => {
    const tab = s.tabs[tabId];
    if (!tab) return {};   // removeTab 後の非同期更新を防ぐ防御コード
    return {
      tabs: {
        ...s.tabs,
        [tabId]: { ...tab, status, ptyId: status === 'live' ? ptyId : undefined },
      },
    };
  });
},
```

### selectFallbackTab（内部ヘルパー）

```typescript
function selectFallbackTab(removedGroupId: string, updatedGroups: Group[]): string | null {
  const group = updatedGroups.find(g => g.id === removedGroupId);
  if (group && group.tabIds.length > 0) return group.tabIds[group.tabIds.length - 1];
  const idx = updatedGroups.findIndex(g => g.id === removedGroupId);
  for (let i = idx - 1; i >= 0; i--) {
    if (updatedGroups[i].tabIds.length > 0)
      return updatedGroups[i].tabIds[updatedGroups[i].tabIds.length - 1];
  }
  for (let i = idx + 1; i < updatedGroups.length; i++) {
    if (updatedGroups[i].tabIds.length > 0) return updatedGroups[i].tabIds[0];
  }
  return null;
}
```
---

## 7. visibility 切替時の fit 戦略

```
ウィンドウリサイズ中
  ResizeObserver 発火
    isActive=true  → fitAddon.fit() + resizePty()    即時
    isActive=false → スキップ

タブ切替 isActive false → true
  useEffect [isActive] 発火
    requestAnimationFrame(() => {
      fitAddon.fit()        1 frame 後（DOM が visible になってからサイズ確定）
      resizePty(...)        最新 cols/rows を PTY に通知
      term.focus()          フォーカスをターミナルに渡す
    })
```

**rAF が必要な理由**: isActive 変更直後は CSS の visibility プロパティが変わるだけで、
ブラウザのレイアウト計算は次フレームで確定する。rAF なしで `fit()` を呼ぶと hidden 状態のサイズが返る場合がある。

**display:none を避ける理由**: display:none ではレイアウト領域がゼロになり `fit()` が 0x0 を返す。
visibility:hidden はレイアウト領域を保持するため、非アクティブ時も正しいサイズを維持できる。

**WebView2 の visibility:hidden + ResizeObserver 挙動**: 発火するか否かは実測が必要。
A2 PoC の初期に実測し §9 V10-obs に記録する。発火しない場合は「非アクティブ時の ResizeObserver は不要、active 時の rAF fit で十分」となる。

---

## 8. エッジケース

### spawn 完了前のタブ削除（V12）

`startSpawn` 内で `runtimes.has(tabId)` をチェックする。`forceDispose` 後に Promise が解決した場合、
`handle.dispose()` は必ず呼ぶ（PTY リーク防止）。`setTabStatus` はスキップする。

### cleanup が spawn Promise より先に完了した場合

`runtime.dispose()` が呼ばれると `isDisposed = true` フラグが立つ。
`startSpawn` の `.then` 内で `isDisposed` をチェックし、`handle.dispose()` のみ実行して `setTabStatus` はスキップする。

### 最後のタブ削除

`activeTabId = null`。TerminalPaneContainer がプレースホルダーを表示する。
空グループ（`tabIds=[]`）は残す（Unit B で空グループ表示を実装）。

### 起動時 tabs 空の自動初期化

```typescript
// App.tsx の useEffect（起動時 1 回のみ）
useEffect(() => {
  const { groups, tabs, createGroup, createTab } = useAppStore.getState();
  if (groups.length === 0 || Object.keys(tabs).length === 0) {
    const groupId = createGroup('Default');
    createTab(groupId, { title: 'Terminal' });
  }
}, []);
```

StrictMode 二重 mount での二重初期化は `acquireRuntime` が 2 回目以降は既存 runtime を返すことで防ぐ。Unit H での確認は §11 を参照。

---

## 9. 検証手順

| # | 手順 | 期待結果 |
|---|---|---|
| V01 | アプリ起動 | Terminal タブ 1 枚が自動生成され nushell が起動する |
| V02 | + New Tab を 3 回クリック | タブが計 4 枚になり最後に作ったタブがアクティブになる |
| V03 | タブ間をクリックで切り替え | 各タブのスクロールバックと入力カーソル位置が保持されている |
| V04 | 非アクティブタブで大量出力を実行しアクティブタブに戻る | アクティブタブの描画がフリーズしない。非アクティブタブへ切り替えると大量出力が表示される |
| V05 | タブ切替後に列数確認コマンドを実行 | 正しい列数（ウィンドウサイズに対応した値）が返る |
| V06 | タブの × ボタンをクリック | タブが消え優先順位に従い前のタブが選択される |
| V07 | 最後の 1 タブを削除 | プレースホルダーが表示される |
| V08 | タブで exit を入力 | crashed オーバーレイが表示される |
| V09 | ウィンドウを縦横に引き伸ばす | アクティブタブの xterm が正しくリサイズされる |
| V10 | 非アクティブ状態でウィンドウリサイズ後にそのタブをアクティブにする | リサイズ後の正しいサイズで xterm が表示される |
| V11 | spawn 完了前にタブを高速切替して戻る | spawn 1 回のみ、PTY 1 本のみ（DevTools console で確認） |
| V12 | spawn 完了前にタブ削除 | handle が遅れて来ても dispose される。ダングリング PTY なし |
| V13 | 大量出力中にタブ削除 | write 競合なくクリーン dispose |
| V14 | 起動時自動初期化の StrictMode 対応 | Unit H 送り |
| V15 | タブ切替時にターミナルへフォーカスが渡る | 切替直後にキー入力が即座に反映される |
| V16 | 10 タブ × 大量出力中の計測 | 入力遅延 50ms 以内、active タブ FPS 30 以上、+200MB 以下（Chromium DevTools で計測） |
| V10-obs | visibility:hidden 時の ResizeObserver 発火確認（WebView2 実測） | 結果を §7 に追記する |

---

## 10. 後続ユニット送り

| 機能 | 後続ユニット |
|---|---|
| グループ表示・折りたたみ・追加削除 | Unit B |
| タブのインライン編集・右クリックメニュー（複製・移動・お気に入り登録） | Unit C |
| crashed タブの restart ボタン | Unit C |
| OSC タイトル自動更新（term.onTitleChange / titleSub） | Unit D+E |
| お気に入り機能（addFavorite / spawnFavorite） | Unit D+E |
| Condvar flush 改善（Rust 側バッチ送信） | Unit D+E |
| D&D によるタブ並び替え・グループ間移動 | Unit F |
| キーボードショートカット（Ctrl+Tab 等 / attachCustomKeyEventHandler） | Unit G |
| StrictMode / HMR 有効化の最終確認 | Unit H |
| 永続化（%APPDATA% への JSON 保存） | Phase 3 |
| sleep/wake（タブの PTY 付け替え）・WebGL renderer | Phase 3 |

---

## 11. 未解決事項（Unit H 送り）

### removeTab の順序と StrictMode

A2 では StrictMode を無効にしているため「forceDisposeRuntime → set」の順序で動作する。
Unit H で StrictMode を復活させた際、React の `unmount → mount` サイクルと `releaseRuntime` の `queueMicrotask` が
`forceDisposeRuntime` と競合しないか再確認が必要。問題が発生した場合は、
`removeTab` の冒頭で `runtime.ptyHandle?.dispose()` を直接呼び PTY を即時 kill する方式に切り替える（runtime 自体の解放は React cleanup に任せる）。

### Sidebar.tsx

A2 では最小実装。Unit B でグループ対応の全面書き換えを行う。

---

## 12. テスト戦略（Vitest）

A2 で Vitest を導入し、以下を unit test 対象とする。

- `terminalRegistry`: `acquire / release / forceDispose` の refcount + `queueMicrotask` の動作
- `appStore`: `createTab / removeTab / setTabStatus` の状態遷移（`getState()` ベース）
- `selectFallbackTab`: 純関数の独立テスト（同グループ末尾 / 前後グループ / null）

---

## 付録: ファイル別変更サマリ

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/components/Terminal.tsx` | 削除 | TerminalPane へ完全置換のため削除 |
| `src/components/TerminalPane.tsx` | 新規 | acquireRuntime / runtime.startSpawn を使う多タブ対応版 |
| `src/components/TerminalPaneContainer.tsx` | 新規 | 全タブを常時マウントするコンテナ |
| `src/components/Sidebar.tsx` | 新規（最小） | タブ一覧 + 新規タブボタン + 削除ボタン（Unit B で全面書き換え） |
| `src/App.tsx` | 変更 | Sidebar + TerminalPaneContainer の 2 ペインレイアウト |
| `src/store/appStore.ts` | 変更 | createGroup / createTab / removeTab / setTabStatus 追加 |
| `src/lib/terminalRegistry.ts` | 変更 | TerminalRuntime インターフェース再設計（startSpawn / setOnEvent / dispose 順序） |
| `src/styles/terminal.css` | 新規 | TerminalPane の visibility / position スタイル（必要に応じて） |
| `vitest.config.ts` 等 | 新規 | Vitest 設定追加（unit test 環境整備） |