# Racker Terminal — Phase 2 実装計画 v2

## 1. Context

### Phase 1 からの継続点

Phase 1 で「1 タブで nushell が起動・入出力できる最小構成」を達成した。現状の実装状態:

- `src-tauri/src/pty.rs` — PtyManager（`RwLock<HashMap<String, Arc<PtySession>>>`）が複数セッション対応済み
- `src-tauri/src/lib.rs` — pty_spawn / pty_write / pty_resize / pty_kill の 4 コマンドを登録済み
- `src/components/Terminal.tsx` — onData 先行登録 + pendingInputs バッファ、spawnPty、ResizeObserver、cleanup のライフサイクル実装済み
- `src/lib/pty.ts` — Channel ラッパー、PtyHandle 型定義済み
- `src/main.tsx` — StrictMode 無効化中（WebView2 二重マウント crash 対策）
- `vite.config.ts` — HMR 無効化中（同上）
- WebGL addon: loadAddon していない（WebView2 で native crash するため）

### Phase 1 既知課題（Phase 2 で解消するもの）

| # | 課題 | Phase 2 対処方針 |
|---|---|---|
| 1 | `exit` 入力時のハング | reader/drop 設計を再整理（Unit C で対処） |
| 2 | StrictMode 無効化 | terminalRegistry による参照カウント方式で冪等化後に復活（Unit H） |
| 3 | HMR 無効化 | 同上（Unit H） |
| 4 | WebGL addon 無効化 | Phase 3 送り。Phase 2 では Canvas renderer のまま |
| 5 | reader が即 flush 固定 | 独立タイマースレッド + tiny read 即 flush ショートパスで burst 最適化（Unit C） |
### Phase 2 のゴール

「UI 本命機能」の完全実装。1 ウィンドウで複数 PTY セッションを、縦サイドバー + グループ + D&D で管理できる状態にする。

### スコープ（Phase 2 で対応）

- 複数タブ（PTY セッションのタブ切替）
- 縦サイドバー UI（Chrome Arc 風。グループ → タブの 2 階層）
- タブのグループ化（折りたたみ）
- ドラッグ&ドロップ（タブ/グループ並び替え、グループ間移動）
- 右クリックメニュー（タブ/グループ/お気に入りのアクション）
- インライン編集（タブ名・グループ名のサイドバー内完結編集）
- お気に入り（spawn 設定のワンクリック登録・起動）
- キーボードショートカット（Ctrl+Shift+W / Ctrl+Tab / Ctrl+Shift+Tab の最低限 2 系統）
- StrictMode/HMR 復活（WebGL は Phase 3 送り）

### Out of Scope（Phase 2 で扱わない）

- 永続化（%APPDATA%acker-terminalstate.json）— Phase 2 はメモリ内のみ
- Tokyo Night テーマの本格ロード
- フォント埋め込み（@font-face で配布バンドル）
- 背景透過・frameless window
- インストーラー、IME 詳細調整
- **sleep/wake**（Phase 3 送り。scrollback が失われる UX の痛みを考慮）
- **WebGL addon 再有効化**（Phase 3 送り。Phase 1 での native crash 前科あり）
- @dnd-kit グループ間 index 指定 drop（タブとタブの間への挿入）— Phase 2.5 送り
- キーボード D&D（sortableKeyboardCoordinates は使わない）

---
## 2. 技術スタック（Phase 2 追加分）

### 状態管理: Zustand v5

| 選択肢 | 評価 |
|---|---|
| **Zustand** | 採用。ボイラープレートが最小、React 外からも直接 get/set でき、Tauri IPC コールバック（Channel onmessage）から store を更新する場面に適している。slice パターンで分割も容易 |
| Jotai | atom 単位の粒度は細かすぎ。グループ内タブ並び替えのような「複数 atom の協調更新」でコード量が増える |
| Redux Toolkit | 強力だが、数 KB の状態に対してオーバーキル。ミドルウェア設定がこのプロジェクトでは不要 |
| useState のみ | タブ/グループ状態を複数コンポーネント（Sidebar/MainPane/右クリックメニュー）が共有するため prop drilling が限界を超える |

### D&D: @dnd-kit/core + @dnd-kit/sortable

| 選択肢 | 評価 |
|---|---|
| **@dnd-kit** | 採用。ネストした Sortable（グループ内タブ、グループ間タブ移動）を公式サポート。React 19 対応済み。PointerSensor が WebView2 でも動作実績あり |
| react-beautiful-dnd | 開発停止（archived）。React 18+ での公式サポートなし |
| @hello-pangea/dnd | react-beautiful-dnd の fork。ネストした sortable は非公式対応でハック気味 |

### 右クリックメニュー: @radix-ui/react-context-menu

| 選択肢 | 評価 |
|---|---|
| **@radix-ui/react-context-menu** | 採用。キーボード操作・アクセシビリティ対応済み、unstyled なので Tailwind で完全制御。Tauri WebView2 でのイベント互換性実績あり |
| カスタム実装 | mousedown + position:fixed の自作は portal 管理・キーボード・overflow で詰まりやすい |

### インライン編集: 自作（Input 切替方式）

- contentEditable は xterm.js の IME イベントと干渉するリスクがあるため避ける
- サイドバー内の小さいテキスト要素を span と input で切り替えるだけなので外部ライブラリ不要
- ダブルクリックで編集モード、Enter/Blur で確定、Esc でキャンセル

---
## 3. アーキテクチャ設計

### 3.1 状態モデル

```typescript
// src/store/types.ts

// Phase 2: 'sleeping' は含まない。Phase 3 で追加予定
export type TabStatus = 'spawning' | 'live' | 'crashed';

export interface TabState {
  id: string;           // Frontend 発行 UUID（Rust session id と別物）
  groupId: string;
  title: string;
  shell?: string;       // 未指定 = Rust 側デフォルト (nu)
  cwd?: string;         // 未指定 = Rust 側 home_dir
  env?: Record<string, string>;
  status: TabStatus;
  ptyId?: string;       // live 時のみ。Rust 側 PtyManager の session key（Phase 3 sleep/wake でも引き続き使用）
}

export interface GroupState {
  id: string;
  title: string;
  collapsed: boolean;
  tabIds: string[];     // 順序を tabIds 配列で管理
}

export interface FavoriteState {
  id: string;
  title: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  defaultTabTitle?: string;  // spawn されるタブのデフォルト名テンプレ
}

export interface Settings {
  theme: string;           // Phase 2 はハードコード初期値
  fontFamily: string;
  fontSize: number;
  scrollback: number;
}

export interface AppState {
  groups: GroupState[];
  tabs: Record<string, TabState>;
  favorites: FavoriteState[];
  activeTabId: string | null;
  editingId: string | null;   // 現在インライン編集中の id（tabId or groupId）
  settings: Settings;

  // タブ操作
  createTab: (groupId: string, opts?: Partial<Pick<TabState, 'title' | 'shell' | 'cwd' | 'env'>>) => string;
  removeTab: (tabId: string) => void;   // PTY kill + store から削除（Phase 2 の閉じる操作はこれのみ）
  setActiveTab: (tabId: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  setTabStatus: (tabId: string, status: TabStatus, ptyId?: string) => void;
  moveTab: (tabId: string, toGroupId: string, toIndex: number) => void;
  duplicateTab: (tabId: string) => string | null;  // 同一グループ内に shell/cwd/env で新規 spawn。元タブが見つからなければ null

  // グループ操作
  createGroup: (title?: string) => string;
  removeGroup: (groupId: string) => void;   // 最後の 1 個は削除不可
  updateGroupTitle: (groupId: string, title: string) => void;
  toggleCollapse: (groupId: string) => void;
  moveGroup: (groupId: string, toIndex: number) => void;

  // お気に入り操作
  addFavorite: (fav: Omit<FavoriteState, 'id'>) => void;
  removeFavorite: (favId: string) => void;
  spawnFavorite: (favId: string) => string;

  // editingId 操作
  startEditing: (id: string) => void;
  stopEditing: () => void;
}
```
**ID ポリシー**:
- Tab ID / Group ID / Favorite ID はすべて Frontend 側で `newId()`（`src/lib/id.ts`）を使って発行
- `newId()` は `crypto.randomUUID()` を試み、失敗時は `nanoid` で fallback
- Rust 側の PTY session ID (ptyId) は pty_spawn の戻り値。Tab ID と意図的に別物とする
- 理由: Phase 3 の sleep/wake でタブは ID を保ちつつ PTY だけ付け替えるため（Phase 2 でも同じ構造を維持）

**Phase 3 永続化時の partialize 方針**:

Phase 2 では persist ミドルウェアは入れないが、以下の分類で構造を整えておく。

- **Persist OFF**（ランタイム状態）: `activeTabId`, `editingId`, `tabs[*].status`, `tabs[*].ptyId`
- **Persist ON**（復元対象）: `groups`, `tabs[*].{id, groupId, title, shell, cwd, env}`, `favorites`, `settings`

Phase 3 では `partialize` オプションで OFF 側を除いて JSON 保存する設計。

> **OSC タイトルと persist の競合 (Phase 3 設計書送り)**: 動的に書き換えられる title を persist で保存・復元すると、起動直後に nushell が OSC で書き換えてフリッカー UX になる。この問題への対処（`Tab.title` を「ユーザー編集 title」と「OSC title」に分離するなど）は Phase 3 設計書に委ねる。

**空状態の扱い**:

- 最後のタブを閉じた時: 空グループが残るだけで自動 spawn しない。MainPane は「+ New Tab ボタンで新しいタブを開く」プレースホルダーを表示
- 最後のグループを閉じようとした時: 「グループを閉じる」右クリックメニューを disabled にする（最低 1 個のグループを保持）
- 空グループ（tabIds=[]）の表示: 折りたたみアイコン + グループ名 + 「+ Add Tab」インラインボタン
- アプリ起動直後の初期状態: `groups` が空なら Default グループ + タブ 1 を自動生成（Phase 3 で persist 復元時にも同じ fallback が動く設計）

### 3.2 crashed と restart

**crashed 遷移条件**:
- `PtyEvent::Exit { code }` で code が `Some(n)` かつ `n !== 0` の場合
- spawn 自体が失敗（`spawnPty` reject）した場合

**crashed 時の UI**:
- TabItem に status dot（live: 緑、spawning: 黄、crashed: 赤）を表示。非アクティブ時も視認可能
- アクティブタブが crashed の場合: MainPane 内に薄赤背景 + 中央オーバーレイ「Exited (code: N)」+ 「Click to restart」ボタン
- spawn 失敗エラーメッセージもオーバーレイで表示（タブは削除しない）

**restart フロー（Unit C 実装）**:
1. crashed オーバーレイの「Click to restart」ボタンをクリック
2. `setTabStatus(tabId, 'spawning')` で UI 状態を更新
3. `recyclePty(tabId, opts, onError)` を呼ぶ
   - 旧 PTY を fire-and-forget で dispose（**xterm は維持して scrollback を保全**）
   - `resetForRecycle()` で ptyHandle=null / spawning=false にリセット
   - タブが削除されていないかチェック（レース対策: dispose 中の removeTab に対する防御）
   - `startSpawn()` で新規 PTY を spawn
4. 成功: `createRuntime` 時の `callbacks.onLive` → `setTabStatus(tabId, 'live', newPtyId)`
5. 失敗: `onError` → `setTabStatus(tabId, 'crashed')` + エラーオーバーレイ再表示

> **scrollback 保全の理由**: `recyclePty` は xterm インスタンスをそのまま維持し、PTY だけ差し替える。`forceDisposeRuntime` は使わない（それを呼ぶと xterm ごと破棄されて scrollback が失われる）。

**タブを閉じる操作（Phase 2 のみ）**:
- PTY kill + store から削除のみ（sleep は存在しない）
- 閉じた時のアクティブタブ選択: 同グループの前のタブ → 前のグループの末尾タブ → null の優先順
### 3.3 xterm インスタンスのライフサイクル（最重要設計課題）

**採用: 選択肢 B（全タブの xterm を常時マウント、visibility + absolute で切替）**

| 項目 | 選択肢 A（切替時 unmount/mount） | 選択肢 B（常時マウント、CSS 切替） |
|---|---|---|
| メモリ | 最小（live タブ分の xterm が 1 つ） | タブ数に比例（10 タブで 10 xterm） |
| 切替体験 | スクロール位置・選択が飛ぶ | スクロール位置・選択が保持される |
| 実装複雑度 | マウント時に必ず spawnPty（冪等化が難しい） | 初回 mount のみ spawn、以降は CSS で隠すだけ |
| StrictMode 耐性 | mount/unmount/mount で PTY 二重 spawn リスク | terminalRegistry 参照カウントで吸収 |

選択肢 C（DOM 保持 + display:none）は、display:none 中に fitAddon.fit() が 0x0 を返す問題があるため不採用。visibility:hidden は要素のサイズを保持するため選択肢 B で採用。

**実装方針**:
- MainPane にすべてのタブの TerminalPane をレンダリング
- `activeTabId !== id` のタブは `className="absolute inset-0 invisible pointer-events-none"` で隠す
- `activeTabId === id` のタブは `className="absolute inset-0"` で前面表示
- 非アクティブ TerminalPane の root に `tabIndex={-1}` と `inert` 属性（React 19 正式サポート）を付与
- visibility:hidden でも xterm 内部の PTY 出力受信・スクロールバック蓄積は継続

**visibility 切替の PoC（Unit A2 冒頭で必ず実施）**:

Unit A2 実装前に Phase 1 main ブランチで最小コードを試し、以下を実測する:
1. hidden 側 TerminalPane の ResizeObserver 発火回数と 0x0 判定の有無
2. visible 切替時の fit 挙動（1 frame 待ち必要かどうか）
3. hidden 中の PTY write 蓄積と visible 切替後のリプレイ遅延

visible 遷移時の標準フロー（PoC 結果に応じて調整可能）:

```typescript
// isActive が false → true になった時の useEffect
useEffect(() => {
  if (!isActive) return;
  const raf = requestAnimationFrame(() => {
    fitAddon.fit();
    resizePty(ptyId, term.cols, term.rows);
  });
  return () => cancelAnimationFrame(raf);
}, [isActive]);
```

hidden 中は `pendingResize: boolean` フラグで ResizeObserver 発火を吸収し、visible 時にまとめて 1 回 fit する。
**StrictMode 冪等マウント戦略（terminalRegistry 参照カウント方式）**:

`src/lib/terminalRegistry.ts` を新設し、xterm / PTY ハンドルを React ツリー外のモジュールレベル Map で管理する。

```typescript
// src/lib/terminalRegistry.ts

export interface TerminalRuntime {
  term: Terminal;
  fitAddon: FitAddon;
  ptyHandle?: PtyHandle;
  dispose: () => void;
}

const runtimes = new Map<string, { refs: number; runtime: TerminalRuntime }>();

export function acquireRuntime(tabId: string, init: () => TerminalRuntime): TerminalRuntime {
  const entry = runtimes.get(tabId);
  if (entry) { entry.refs++; return entry.runtime; }
  const runtime = init();
  runtimes.set(tabId, { refs: 1, runtime });
  return runtime;
}

export function releaseRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.refs--;
  if (entry.refs === 0) {
    // queueMicrotask で StrictMode 再 mount を待つ（再 mount されれば refs が 1 に戻る）
    queueMicrotask(() => {
      const e = runtimes.get(tabId);
      if (e && e.refs === 0) {
        e.runtime.dispose();
        runtimes.delete(tabId);
      }
    });
  }
}

// タブの真の削除（× ボタン）時は参照カウントに関わらず即 dispose
export function forceDisposeRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.runtime.dispose();
  runtimes.delete(tabId);
}
```

StrictMode の mount → cleanup → mount サイクルは参照カウントで吸収される（refs: 0 → 1 → 0 → microtask → refs が 1 なら dispose しない）。

v1 の `initializedRef` パターンは採用しない。

**HMR 耐性**:
- `vite.config.ts` の `hmr: false` を削除
- `TerminalPane.tsx` のみ `import.meta.hot?.invalidate()` を仕込み、HMR 発火時は full reload に倒す
- terminalRegistry が有効な間は PTY の二重 spawn は発生しない
### 3.4 Rust backend の拡張

**reader thread の 2 スレッド構成 + tiny read 即 flush ショートパス**:

```
read スレッド  : PTY.read() blocking → raw_buf (Mutex<Vec<u8>>) に追記 → Condvar で notify
flush スレッド : Condvar.wait_timeout(16ms) → 起床したら raw_buf を drain → UTF-8 検証 → Channel.send()
```

- read スレッドは raw バイトを溜めるだけ（UTF-8 を考慮しない）
- flush スレッドは `Condvar.wait_timeout(16ms)` で待ち、wake したら drain。burst 時は 16ms バッチで自然に処理される
- **tiny read 即 flush ショートパス**: read スレッドが 1 回の read で受け取ったバイト数が 256 byte 未満、かつ前回 flush から 2ms 以上経過している場合は、read スレッドが `cvar.notify_one()` で flush スレッドを即時起床させる。これにより DSR-CPR 応答の初期 hang を解消する
- `crossbeam-channel` は採用しない（`Mutex<Vec<u8>> + Condvar` で十分。バイトストリームにメッセージ境界は不要）
- stop_flag が true になったら flush スレッドが残余 bytes を lossy 送信して `PtyEvent::Exit` を送信
- PtySession に `flush_handle: Mutex<Option<JoinHandle<()>>>` フィールドを追加

**exit ハング解消**:
- kill() で stop_flag をセット → `child.kill()` → `child.wait()` → master を drop（read スレッドに EOF を届ける）
- flush スレッドは stop_flag を定期チェックするため、read スレッドがブロックし続けても flush は終了
- **Unit C の完了条件**: nushell / cmd.exe / powershell 全てで exit 後 hang なし確認

**pty_spawn の env 拡張**:

```rust
pub fn pty_spawn(
    state: tauri::State<PtyManager>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<std::collections::HashMap<String, String>>,  // 追加
    on_event: Channel<PtyEvent>,
) -> Result<String, String>
```

**OSC タイトルは xterm 側で処理**:

Rust 側は `PtyEvent::TitleChange` を定義しない（Data / Exit / Error のみ）。

Frontend 側で xterm の `onTitleChange` コールバックを購読し、タイトル文字列を 256 文字に切ってから `store.updateTabTitle(tabId, title.slice(0, 256))` を呼ぶ。

```rust
// PtyEvent は TitleChange を含まない
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { text: String },
    Exit { code: Option<i32> },
    Error { message: String },
}
```

**`applySettings` の責務（Unit D+E 実装済み）**:

`TerminalRuntime` に `applySettings(settings: Settings): void` メソッドを実装。`App.tsx` の `useAppStore.subscribe` 経路で Settings 変化を検知し、`getAllRuntimes()` で全 runtime に broadcast して `term.options.fontSize / fontFamily / scrollback` を即時更新する。Settings 編集 UI は Phase 3 送りのため、Phase 2 では機構のみ提供する。
### 3.5 UI レイアウト

```
+--------------------------------------------------------------+
| racker-terminal                                   [_][box][x] |
+-------------------+------------------------------------------+
| Sidebar (240px)   | MainPane                                 |
|                   |                                          |
| ⌄ Favorites       | TerminalPane(tabA) [visible]             |
|   ★ api-dev      | TerminalPane(tabB) [invisible]           |
|   ★ web-dev      | TerminalPane(tabC) [invisible]           |
|                   |                                          |
| v  work           | active tab の xterm が前面に表示         |
|    [o] api        | crashed tab はオーバーレイを重ねて表示   |
|    [o] web        |                                          |
| >  dev            | （全タブ空の場合はプレースホルダー）      |
|    [!] old-db     |                                          |
|                   |                                          |
| [+ New Group]     |                                          |
+-------------------+------------------------------------------+
```

Favorites セクション（Unit D+E 実装済み）:
- Sidebar 上部に表示（折りたたみ可）
- 各 Favorite: クリックで spawn、右クリックで「ここから spawn」「削除」
- 空状態: プレースホルダーテキストを表示
- タブ右クリックメニューに「お気に入りに追加」を追加

**右クリックメニュー項目**:

タブ用: リネーム / 複製 / お気に入りに追加 / 閉じる

グループ用: リネーム / 新規タブを追加 / グループを閉じる（最後の 1 個は disabled）

お気に入り用: ここから spawn / 削除

D&D 中（isDragging 状態）: ContextMenu.Trigger を disable

**タブ複製の仕様**:
- 右クリック「タブを複製」: 同一グループ内に、同じ shell / 初期 cwd / env で新規 spawn
- scrollback や現在の cwd（cd 後）は引き継がない
- 新規タブの title は元タブの title + " (copy)"

**InlineEdit の仕様**:
- `AppState.editingId` で編集状態を一元管理
- 右クリック「リネーム」と InlineEdit ダブルクリックはどちらも `store.startEditing(target.id)` をセット
- InlineEdit コンポーネントは `useStore(s => s.editingId === props.id)` で編集モード判定
- 確定: Enter / blur → `store.stopEditing()`。Esc: キャンセル（元の title 維持）→ `store.stopEditing()`
- IME 対応: `onCompositionStart/End` で isComposing フラグ管理。isComposing 中の Enter は無視
- タブ切替時: blur → 確定
- D&D 開始時: 編集キャンセル（元の title 維持）、ドラッグ優先
- 外クリック: 確定

**TabItem の仕様**:
- `truncate` クラスと `title={title}` 属性（ホバーで tooltip）
- status dot: live = 緑、spawning = 黄、crashed = 赤（非アクティブタブでも視認可能）
- close ボタン（ホバー時表示）
### 3.6 キーボードショートカット

Phase 2 で実装するショートカットは最小限に絞る。

| ショートカット | 動作 |
|---|---|
| Ctrl+Shift+W | アクティブタブを閉じる |
| Ctrl+Tab | 次のタブへ |
| Ctrl+Shift+Tab | 前のタブへ |

- xterm.js の `attachCustomKeyEventHandler` で登録する
- xterm がフォーカスを持つ場合のみ動作（xterm デフォルト挙動を上書きしない）
- グローバル `keydown` リスナーは使用しない
- 拡張（Ctrl+T 新規タブ等）は Phase 3 以降

### 3.7 D&D ポリシー（簡易版）

@dnd-kit/core + @dnd-kit/sortable を使用。実装は最小限の仕様に限定する。

**Phase 2 対象操作**
- 同一グループ内でのタブ並び替え（インデックスの交換）
- タブをドラッグしてグループ末尾へ移動（グループ間移動）

**Phase 2 対象外（Phase 3 以降）**
- グループ自体の並び替え
- タブを新規グループとしてドロップ
- ドラッグ中のグループ跨ぎリアルタイムプレビュー

**実装ポイント**

```tsx
// PointerSensor に activationConstraint を設定し意図しない誤発火を防ぐ
const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  })
);
```

- `collisionDetection: closestCorners`
- ドラッグ終了時に `onDragEnd` でインデックス更新 → Zustand の `moveTab` を呼ぶ
- DragOverlay でドラッグ中の幽霊タブを body に Portal 描画

**Unit F 実装完了 (PR #13 相当)**

`moveTab(tabId, toGroupId, toIndex)` API:
- fromGroup の tabIds から対象を除去 → toGroup の tabIds の toIndex 位置に挿入
- toIndex は `[0, toGroup.tabIds.length]` にクランプ
- 同一グループ内並び替えにも使用（from 除去後の長さ基準でクランプ）
- 不正な tabId / toGroupId は no-op
- tab.groupId フィールドも更新

コンポーネント構成:
- `Sidebar.tsx`: `DndContext` + sensors + `onDragStart/End` + `DragOverlay` (body Portal)
- `GroupSection.tsx`: `SortableContext` (verticalListSortingStrategy) + `useDroppable` (`group-{id}`)
- `TabItem.tsx`: `useSortable({ id: tabId, data: { groupId }, disabled: isEditing })`
- `TabItemPreview`: DragOverlay 内の最小プレビュー (status dot + title)

### 3.8 パフォーマンス方針

| 項目 | 方針 |
|---|---|
| renderer | Canvas renderer（WebGL は Phase 3）|
| TerminalPane マウント | 全タブ常時マウント（visibility 切替）|
| 非アクティブ pane | `inert` 属性付与・`visibility:hidden` |
| FitAddon | アクティブ切替時に `requestAnimationFrame` 経由で fit() |
| データ受信バッファ | Rust 側 2 スレッド（read + flush）で 16ms flush |
| 小さな読み取り高速化 | Condvar shortpath: 読み取りが 256 byte 未満かつ前回 flush から 2ms 超で即時通知 |
| Zustand selector | 必要フィールドのみ subscribe（shallow equal）|

---

## 4. 実装単位

依存関係のない単位は並列実装可能。

**依存グラフ（テキスト形式）**

- Unit 0: 基盤（型定義・newId・CSS変数）
- Unit A1: terminalRegistry（Unit 0 の後）
- Unit A2: TerminalPane 可視性 PoC（A1 の後）
- Unit B: マルチグループ UI（A2 の後）
- Unit C: InlineEdit＋タブ操作（A2 の後、B と並列可）
- Unit D+E: Zustand 拡張＋Rust 拡張（A2 の後、B・C と並列可）
- Unit F: D&D（B および D+E の後）
- Unit G: キーボードショートカット（A2 の後、F と並列可）
- Unit H: StrictMode＋HMR 確認（A1・A2 の後）

### Unit 0: 基盤整備 + IPC 型契約先行

Unit 0 は 2 つのサブタスクに分割する。両者とも機能ゼロで他ユニットの起点となる。

**Unit 0-a: IPC 型契約先行 commit**（実装済み）

- 対象ファイル:
  - `src-tauri/src/pty.rs` — `pty_spawn` / `PtyManager::spawn` に `env: Option<HashMap<String, String>>` 引数を追加（Rust 側未使用、`#[allow(unused_variables)]` で抑制）
  - `src/lib/pty.ts` — `SpawnOptions` に `env?: Record<string, string>` を追加、`spawnPty` で条件付き args 追加
- 変更内容:
  - env は Unit D+E（お気に入り）で本格利用する。現時点では受け取るだけ
  - 目的: Unit D+E で Rust/TS 両側の IPC シグネチャ変更が入らないよう、先に型契約だけ確定させる
- 並列可否: 最初に実施

**Unit 0-b: 型定義・ID 生成・CSS 変数**

- 対象ファイル:
  - `src/types/index.ts` — TabStatus, Tab, Group, Favorite, Settings 型定義
  - `src/lib/id.ts` — newId() ラッパー（crypto.randomUUID / nanoid フォールバック）
  - `src/styles/variables.css` — CSS 変数（サイドバー幅・色トークン）
- 変更内容:
  - TabStatus を `'spawning' | 'live' | 'crashed'` に確定
  - Settings 型を定義（shell, theme, fontSize 等）
  - newId() を crypto.randomUUID() ベースで実装、フォールバックは nanoid
- 並列可否: Unit 0-a と並列可、他ユニットの起点

### Unit A1: terminalRegistry

- 対象ファイル:
  - `src/lib/terminalRegistry.ts` — 新規作成
  - `src/components/TerminalPane.tsx` — initializedRef 削除、acquireRuntime / releaseRuntime へ置換
- 変更内容:
  - モジュールレベル Map でランタイムを管理
  - acquireRuntime: refs++ / 初回 init() のどちらかを実行して返す
  - releaseRuntime: refs-- → 0 なら queueMicrotask で dispose（StrictMode の mount→cleanup→mount を吸収）
  - forceDisposeRuntime: タブ削除時に即時破棄
- 並列可否: Unit 0 完了後に単独で実施

### Unit A2: TerminalPane 可視性 PoC

- 対象ファイル:
  - `src/components/TerminalPane.tsx` — 可視性切替ロジック追加
  - `src/components/TerminalPaneContainer.tsx` — 全タブを常時マウントするコンテナ
  - `src/styles/terminal.css` — visibility / position スタイル
- 変更内容:
  - isActive=false のとき `visibility:hidden; position:absolute` でオフスクリーン
  - isActive=true になったとき requestAnimationFrame 経由で fitAddon.fit() 呼び出し
  - inert 属性を非アクティブ pane のルート要素に付与（React 19 公式サポート）
  - **PoC 優先**: 最初にブランチで動作確認してからメインへマージ
- 並列可否: Unit A1 完了後に単独で実施

### Unit B: マルチグループ UI

- 対象ファイル:
  - `src/components/Sidebar.tsx` — グループ区切り・グループヘッダ表示
  - `src/components/GroupSection.tsx` — 新規作成（グループ単位コンポーネント）
  - `src/components/TabItem.tsx` — グループ色バッジ表示
  - `src/store/appStore.ts` — addGroup / removeGroup / moveTabToGroup
- 変更内容:
  - 縦サイドバーにグループ単位でタブを表示
  - グループ折りたたみ（collapsed state は Zustand に保持）
  - グループ追加ボタン・グループ削除（タブ 0 枚のとき）
  - 空グループ状態でプレースホルダー表示
- 並列可否: Unit A2 完了後に実施

### Unit C: InlineEdit＋タブ操作

- 対象ファイル:
  - `src/components/InlineEdit.tsx` — 新規作成
  - `src/components/TabItem.tsx` — InlineEdit 組み込み・ダブルクリックで編集開始
  - `src/store/appStore.ts` — editingId, startEditing, stopEditing, duplicateTab, renameTab
- 変更内容:
  - ダブルクリックで tabTitle をインライン編集
  - 編集中は Escape でキャンセル・Enter または blur で確定
  - 編集中に他タブがアクティブになっても stopEditing を呼ぶ
  - 外部操作（pty exit 等）中も編集欄を表示し続ける（外部状態に干渉しない）
  - タブ右クリックメニュー: 複製・閉じる・グループ移動
  - タブタイトルは最大幅を CSS で制限しテキストを省略表示（`text-overflow: ellipsis`）
- 並列可否: Unit A2 完了後、Unit B と並列実施可能

### Unit D+E: Zustand 拡張＋Rust 拡張

- 対象ファイル:
  - `src/store/appStore.ts` — settings スライス・spawnFavorite・favoriteの追加削除
  - `src-tauri/src/pty.rs` — Condvar flush スレッド追加、env を `CommandBuilder::env` に流す実装（`#[allow(unused_variables)]` は削除）
  - `src-tauri/src/lib.rs` — PtyEvent 定義（TitleChange なし）
- 変更内容（Zustand 側）:
  - Settings 型: shell, fontSize, theme
  - spawnFavorite(favId): お気に入りの設定でタブを新規生成
  - addFavorite / removeFavorite
  - Phase 3 persist partialize の計画コメントを追記（OFF: activeTabId, editingId, tabs[*].status, ptyId）
- 変更内容（Rust 側）:
  - read スレッドと flush スレッドを Mutex + Condvar で同期
  - read: バッファに追記 → Condvar notify
  - flush スレッド: wait_timeout(16ms) または notify 受信 → emit
  - shortpath: 読み取りが 256 byte 未満かつ前回 flush から 2ms 超 → Condvar::notify_one()
  - PtyEvent::TitleChange は削除済み（OSC title は frontend の onTitleChange で処理）
  - env を `CommandBuilder::env` でセット（Unit 0-a で追加済みの引数を利用）。`TERM` / `COLORTERM` は env 適用後に racker-terminal 側で強制上書きして xterm 互換性を保護
- 並列可否: Unit A2 完了後、Unit B・C と並列実施可能

### Unit F: D&D

- 対象ファイル:
  - `src/components/Sidebar.tsx` — DndContext 組み込み
  - `src/components/GroupSection.tsx` — SortableContext でタブリストをラップ
  - `src/components/TabItem.tsx` — useSortable フック適用
  - `src/store/appStore.ts` — reorderTabs / moveTabToGroup
- 変更内容:
  - PointerSensor with activationConstraint: distance 8px
  - collisionDetection: closestCorners
  - onDragEnd: 同グループ内はインデックス交換、グループ間は末尾追加
  - DragOverlay で幽霊タブを表示（ポータル描画）
- 並列可否: Unit B および Unit D+E 完了後に実施。Unit G と並列可

### Unit G: キーボードショートカット

- 対象ファイル:
  - `src/components/TerminalPane.tsx` — attachCustomKeyEventHandler 追加
- 変更内容:
  - xterm の attachCustomKeyEventHandler で Ctrl+Shift+W / Ctrl+Tab / Ctrl+Shift+Tab を捕捉
  - xterm がフォーカスを持つ場合のみ動作
  - Ctrl+Shift+W: closeTab(activeTabId) を呼ぶ
  - Ctrl+Tab: 次タブをアクティブにする
  - Ctrl+Shift+Tab: 前タブをアクティブにする
- 並列可否: Unit A2 完了後。Unit F と並列実施可能

### Unit H: StrictMode＋HMR 復活（実装完了）

- 対象ファイル:
  - `src/main.tsx` — StrictMode 有効化 (`<StrictMode>` でラップ)
  - `vite.config.ts` — HMR 有効化 (`hmr: false` 削除)
  - `src/lib/terminalRegistry.ts` — `forceDisposeAll()` 関数を export 追加
  - `src/components/TerminalPane.tsx` — `import.meta.hot.dispose(() => forceDisposeAll())` 登録
  - `src/lib/terminalRegistry.test.ts` — memory leak テスト 3 件追加
  - `docs/unit-h-design.md` — 設計書新規作成
- 変更内容:
  - `forceDisposeAll()`: Map をコピーしてから全 runtime を即時破棄して registry を空にする
    - HMR の `import.meta.hot.dispose` hook で呼ぶことで、HMR 更新時の xterm/PTY リークを防ぐ
  - HMR hook の配置 (`TerminalPane.tsx` 冒頭):
    1. `import.meta.hot.dispose(() => forceDisposeAll())` → HMR 更新前に全 runtime を強制クリーンアップ
    2. `import.meta.hot.invalidate()` → full reload に倒す（terminalRegistry の参照カウント前提を維持）
  - StrictMode 復活時の各 Unit useEffect の耐性: `docs/unit-h-design.md §3` 参照
  - memory leak テスト 3 件: `forceDisposeAll` 動作・100 タブ loop・StrictMode 二重 mount 検証
  - **WebGL は対象外**（Phase 3 スコープ）
- 並列可否: Unit A1・A2 完了後に実施（他ユニットとは独立）

---

## 5. ファイル一覧（追加・変更）

| ファイル | 追加/変更 | 担当ユニット |
|---|---|---|
| `src/types/index.ts` | 変更 | Unit 0-b |
| `src/lib/id.ts` | 追加 | Unit 0-b |
| `src/lib/pty.ts` | 変更 | Unit 0-a |
| `src/lib/terminalRegistry.ts` | 追加 | Unit A1 |
| `src/styles/variables.css` | 変更 | Unit 0-b |
| `src/styles/terminal.css` | 変更 | Unit A2 |
| `src/components/TerminalPane.tsx` | 変更 | A1, A2, G |
| `src/components/TerminalPaneContainer.tsx` | 追加 | Unit A2 |
| `src/components/Sidebar.tsx` | 変更 | B, F |
| `src/components/GroupSection.tsx` | 追加 | B, F |
| `src/components/TabItem.tsx` | 変更 | B, C, F |
| `src/components/InlineEdit.tsx` | 追加 | Unit C |
| `src/store/appStore.ts` | 変更 | C, D+E |
| `src-tauri/src/pty.rs` | 変更 | Unit 0-a, D+E |
| `src-tauri/src/lib.rs` | 変更 | Unit D+E |
| `src/main.tsx` | 確認のみ | Unit H |
| `vite.config.ts` | 確認のみ | Unit H |

---

## 6. リスク・注意点

| リスク | 対策 |
|---|---|
| StrictMode 二重実行による pty 二重 spawn | terminalRegistry の refcount + queueMicrotask で吸収 |
| 全タブ常時マウントによるメモリ増加 | xterm.js インスタンスは 1 タブあたり固定。タブ数上限を設けることを Phase 3 で検討 |
| Condvar 実装のデッドロック | flush スレッドは wait_timeout で必ず解放。Mutex ロック範囲を最小化 |
| D&D ドラッグ誤発火 | activationConstraint: distance 8px で抑制 |
| HMR 時の terminalRegistry リーク | forceDisposeAll を HMR hot.dispose フックで呼ぶ（Unit H で確認）|
| OSC title が長いケース | xterm.onTitleChange は文字列をそのまま返す。上限は表示側 CSS で制御 |
| Phase 3 persist の移行コスト | partialize 対象を Unit D+E のコメントで今から明記しておく |
| `raw_buf` の OOM | 4MB 超で lossy 切り捨て + `[output truncated]` マーカー（Unit D+E で実装） |
| `eprintln!` の本番漏洩 | `#[cfg(debug_assertions)]` で囲む or `tracing` 導入（Unit D+E で実装） |
| `inert` の WebView2 互換性 | フォールバックとして `pointer-events:none + tabIndex={-1}` を併用（A2 で実装済み、リスク表で明示） |
| removeTab fallback で隠れタブに移動 | `expandGroupContaining` で自動展開（PR #10 で実装済み） |
| Settings リアクティブ反映の経路 | `runtime.applySettings(settings)` の責務を Unit D+E で設計痕跡として残す |

---

## 7. 検証シナリオ

| ID | シナリオ | 期待結果 |
|---|---|---|
| T01 | StrictMode 有効でタブ新規作成 | pty が 1 本だけ spawn される |
| T02 | StrictMode 有効でタブを閉じる | pty が確実に kill される |
| T03 | HMR 後にターミナルを操作 | pty 接続が維持されコマンドが実行できる |
| T04 | タブ 10 枚を高速切替（50ms 間隔）| 各タブの表示が正しく復元される |
| T05 | 非アクティブタブで大量出力発生 | 可視タブがフリーズしない |
| T06 | タブタイトルをダブルクリックして編集 | インライン入力欄が表示される |
| T07 | 編集中に Escape | 元のタイトルに戻る |
| T08 | 編集中に Enter | 新タイトルが確定される |
| T09 | OSC title シーケンス受信 | タブタイトルが自動更新される |
| VD01 | 起動時に Favorites セクションが表示される（初期は空） | 「お気に入りはまだありません」プレースホルダーが表示される |
| VD02 | タブ右クリック → 「お気に入りに追加」 | Favorites セクションにお気に入りが登録される |
| VD03 | Favorite クリック | 新タブが spawn され、shell/cwd/env が引き継がれる |
| VD04 | Favorite 右クリック → 「削除」 | Favorites セクションからお気に入りが消える |
| VD05 | nushell で `printf '\033]0;TestTitle\007'` を実行 | タブ名が "TestTitle" に変わる |
| VD06 | タブ名を編集中に OSC を発火させる | 編集中の入力が壊れない（OSC が無視される） |
| VD07 | `store.setState({ settings: { fontSize: 16, ... } })` | 全タブの xterm フォントサイズが即時変わる |
| T10 | タブを D&D で同グループ内移動 | 並び順が更新される |
| T11 | タブを D&D で別グループへ移動 | 末尾に追加される |
| T12 | Ctrl+Shift+W でタブを閉じる | アクティブタブが閉じる |
| T13 | Ctrl+Tab / Ctrl+Shift+Tab でタブ切替 | 前後タブに移動する |
| T14 | pty が exit した後のタブ状態 | status が crashed になりオーバーレイが表示される |
| T15 | お気に入りからタブを新規生成 | 設定通りの shell で pty が起動する |
| T16 | グループを追加して空状態を確認 | プレースホルダーが表示される |
| T17 | タブを複製する | 同じ shell 設定の新規タブが隣に追加される |

---

## 8. スコープ外（Phase 3 以降）

- スリープ / ウェイク機能（TabStatus: sleeping）
- キーボードショートカット拡張（Ctrl+T / Ctrl+N 等）
- WebGL renderer アドオン（WebGL2 コンテキスト競合リスク対応後）
- Zustand persist によるセッション復元
- グループ自体の D&D 並び替え
- タブを新規グループとしてドロップ
- ウィンドウ分割・マルチウィンドウ
- カスタムテーマ UI
- **scrollback の永続化**: PTY 出力と xterm 内部メモリと一蓮托生のため、Phase 3 でも実施しない。Phase 3 設計書でユーザー期待値を明示する。

---

## 9. フックポイント（後続ユニット向け）

### Unit D+E フックポイント
- tiny read しきい値（256 byte / 2ms）は `src-tauri/src/pty.rs` の定数として 1 箇所集約する（変更が容易なように）
- `runtime.applySettings(settings)` の責務を Unit D+E で設計し、Settings の動的反映経路を確立する
- OSC タイトル変更は `runtime.titleSub` として `term.onTitleChange` の購読を管理する（Unit D+E で実装）

### Unit F フックポイント
- D&D 開始時（`onDragStart`）は `stopEditing()` を呼ぶ責任を Unit F 側が持つ（InlineEdit のキャンセル）

### Unit H フックポイント
- Unit C / D+E / F / G 完了後にチェックリストを棚卸しする
- memory leak テスト: 100 タブ open/close を繰り返して xterm インスタンスが残らないことを確認
- `forceDisposeAll()` を `import.meta.hot.dispose` に登録してゾンビ xterm を防ぐ
