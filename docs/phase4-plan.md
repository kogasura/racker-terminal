# Racker Terminal — Phase 4 実装計画

> **Phase 4 完了 (v1.0)**: Unit P4-A (永続化 + Tab.title 構造分離) 完了。Unit P4-B-1 (D&D 拡張) 完了 (2026-04-25)。Unit P4-B-2 (Settings UI + frameless window + 背景透過) 完了 (2026-04-25)。Unit P4-D (配布インストーラー) 完了。Unit P4-G (お気に入り改善) 完了。Unit P4-H (既定シェル + 新規タブ UX) 完了。Unit P4-I (プロファイルテンプレート) 完了。Unit P4-J (シェル引数サポート) 完了。Unit P4-K (WSL distro 自動検出) 完了。**Phase 4 全 Unit 完了。**

---

## 1. 概要・スコープ

Phase 3 完成後のユーザー使用試験で発覚した実用上の問題を解消する。

### Unit P4-A: 永続化 + Tab.title 構造分離

**A1**: `zustand/middleware/persist` を `useAppStore` に追加。アプリ再起動時にタブ・グループ・お気に入りを復元する。

**A2**: `Tab.title` を `userTitle` (ユーザー編集) と `oscTitle` (shell の OSC タイトル) に分離。永続化されるのは `userTitle` のみ。

**A3**: scrollback は復元しない（PTY と一蓮托生のため）。この仕様は設計上の制約として明示する。

#### 永続化される情報

- ✅ タブ・グループ・お気に入りの構成
- ✅ shell / cwd / 環境変数
- ✅ ユーザー編集したタブ名 (userTitle)
- ✅ Settings (フォント等)

#### 永続化されない情報

- ❌ scrollback (PTY 出力履歴): PTY と一蓮托生のため復元不可。Phase 5 で別途対応を検討する
- ❌ 実行中の状態 (active タブ・編集中状態): ランタイム情報のため
- ❌ shell 側の OSC タイトル (oscTitle): 起動後に shell が再送信する

#### 設計判断

1. **persist の storage は localStorage**: Tauri WebView2 で安定動作。IndexedDB / file system 等の選択肢もあるが Phase 4 では localStorage で十分。
2. **version: 1 + migrate スケルトン**: 将来 Tab 型が変わった時のために `version: 1` を設定。`migrate` オプションは現在パススルー。
3. **onRehydrateStorage で status リセット**: 復元したタブは PTY セッションが切断されているため `status='spawning'` に戻して TerminalPane が再 spawn する。
4. **Tab.title 廃止 (破壊的変更)**: 旧 `tab.title` は完全に廃止し、`userTitle` または `getTabDisplayTitle(tab)` に統一。

---

### Unit P4-G: お気に入り改善 (OSC 7 cwd 追跡 + 手動登録 + 編集)

**問題 1**: `tab.cwd` は spawn 時の初期値のみ。shell 内で `cd` しても追跡しない。
**問題 2**: お気に入り登録は「現在のタブから」のみ。デフォルト shell が nushell 固定のため最初の WSL タブが作れない（鶏卵問題）。

**解決策**:
- G1: OSC 7 シーケンスを解析して `tab.cwd` を動的追跡
- G2: `updateTabCwd` store action を追加
- G3: `FavoriteDialog` で手動登録 UI を実装
- G4: `FavoritesSection` に「+ Add Favorite」ボタンと編集メニューを追加
- G5: `updateFavorite` store action を追加
- G6: WSL の Linux パスリスク対策

---

## 2. OSC 7 シーケンス解析の実装詳細

### 2.1 OSC 7 とは

shell が現在ディレクトリを端末エミュレータに通知する仕組み。

```
ESC ] 7 ; file://hostname/path BEL
```

nushell・PowerShell・fish 等が標準で発信する。xterm.js v6 の `term.parser.registerOscHandler(7, cb)` で受信できる。

### 2.2 parseOsc7Path 純関数

```ts
// src/lib/terminalRegistry.ts (export)
export function parseOsc7Path(data: string): string | null
```

- 入力: OSC 7 の data 部分 (`file://hostname/C:/Users/foo/path` 等)
- 出力: Windows パス文字列 (`C:\Users\foo\path`) または null
- Windows パス (/X:/ 形式) のみ変換。Linux パスは null を返す。
- URL エンコードをデコードする (`%20` → ` ` 等)

### 2.3 OSC ハンドラの登録 (createRuntime 内)

```ts
const oscSub = term.parser.registerOscHandler(7, (data) => {
  if (isDisposed) return false;
  const path = parseOsc7Path(data);
  if (path !== null) callbacks.onCwdChange(path);
  return false;  // false で xterm が他のハンドラにも伝播 (default behavior 維持)
});
```

### 2.4 dispose 順序への追加 (§3.2)

```ts
dispose() {
  isDisposed = true;
  onEventHandler = null;
  onDataSub.dispose();
  titleSub.dispose();
  oscSub.dispose();          // Phase 4 P-G で追加
  compositionAbort.abort();
  webglHandle.dispose();
  fitAddon.dispose();
  void ptyHandle?.dispose();
  term.dispose();
}
```

---

## 3. FavoriteDialog の状態遷移

```
FavoritesSection
  └── dialogState: null | { mode: 'add' } | { mode: 'edit', favorite: Favorite }

null ──[「+ Add Favorite」クリック]──→ { mode: 'add' }
null ──[コンテキストメニュー「編集」]──→ { mode: 'edit', favorite }
{ mode: 'add' }  ──[onSubmit]──→ addFavorite(data) → null
{ mode: 'edit' } ──[onSubmit]──→ updateFavorite(id, data) → null
any ──[onClose / ESC]──→ null
```

`FavoriteDialog` はモーダルダイアログ (`@radix-ui/react-dialog`)。ESC キー・オーバーレイクリックで閉じる。

---

## 4. updateTabCwd / updateFavorite action の仕様

### updateTabCwd

```ts
updateTabCwd: (tabId: string, cwd: string) => void
```

- 同じ値なら no-op（不要な再レンダーを回避）
- 存在しない tabId は no-op
- OSC 7 は頻繁に発火するため、同値チェックが重要

### updateFavorite

```ts
updateFavorite: (favId: string, patch: Omit<Favorite, 'id'>) => void
```

- id は変更しない (`{ ...patch, id: favId }`)
- 存在しない favId は no-op

---

## 5. WSL の Linux パスリスクと対策

### リスク

WSL の shell が発信する OSC 7 の cwd は Linux パス形式 (例: `/home/user/proj`)。
Windows パスでないため、その cwd で再 spawn すると PTY が失敗する可能性がある。

### Phase 4 の対策 (G6)

`parseOsc7Path` で **Windows パス形式のみ反映**し、Linux パス (`/home/...` 等) は `null` を返して無視する。

```ts
// 先頭が "/X:/" の形式のみ Windows パスとして処理
if (!/^\/[a-zA-Z]:/.test(path)) return null;
```

### Phase 5 送り

WSL の Linux パスを `\\wsl.localhost\Ubuntu-22.04\home\user\proj` のような UNC パスに変換して Windows から使用する対応は Phase 5 で検討する。

---

## 6. 検証シナリオ VPG01〜VPG10

| ID | 検証内容 |
|---|---|
| VPG01 | nushell で `cd ~/projects` → OSC 7 発信 → tab.cwd が更新される |
| VPG02 | PowerShell で `Set-Location` → tab.cwd が更新される |
| VPG03 | お気に入りを cwd 更新後に spawn → 新しい cwd で起動する |
| VPG04 | 「+ Add Favorite」から WSL タブを登録 (shell=wsl.exe, cwd 空) → spawn できる |
| VPG05 | お気に入り編集ダイアログで shell/cwd を変更 → 反映される |
| VPG06 | ダイアログで ESC / オーバーレイクリック → キャンセルされる |
| VPG07 | title 未入力で送信 → バリデーションエラー (ブラウザ標準 required) |
| VPG08 | 環境変数 `KEY=VALUE` のパース → 正しくオブジェクトに変換される |
| VPG09 | WSL タブで `cd /home/user` → Linux パスは無視される (cwd は変わらない) |
| VPG10 | お気に入り削除 → リストから消える (既存動作の確認) |

---

## 7. 後続フェーズ送り項目

| 項目 | 送り先 |
|---|---|
| 永続化 (groups / tabs / favorites を localStorage 等に保存) | Unit P4-A ✅ |
| UI 完成度 (Settings UI、テーマ選択) | Unit P4-B-2 ✅ |
| 配布・インストーラー (msi/exe) | Unit P4-D ✅ |
| WSL Linux パスの UNC 変換 | Phase 5 |
| Favorites D&D 並び替え | Unit P4-B-1 ✅ |

---

## 8. Unit P4-B-1 実装記録 (2026-04-25)

### B1. グループ自体の D&D 並び替え

- `GroupSection.tsx`: `useSortable({ id: groupId, data: { kind: 'group' } })` でグループ全体を sortable 要素に
- グループヘッダ左端に `group-header__drag-handle` (⠿ アイコン) を追加。`listeners` をここに限定することで chevron クリック・削除ボタンと共存
- `Sidebar.tsx`: グループ用 `SortableContext` (id="groups-sortable") を追加
- `handleDragEnd` で `activeKind === 'group'` を判定し `moveGroup` を呼ぶ
- `TabItem.tsx`: useSortable の data に `kind: 'tab'` を追加（タブ用との区別に使用）

### B2. Favorites D&D 並び替え

- `appStore.ts`: `moveFavorite(favId, toIndex)` action を追加 (`moveGroup` と同パターン)
- `FavoritesSection.tsx`: 各 favorite item を `SortableFavoriteItem` コンポーネント化し `useSortable({ id: favId, data: { kind: 'favorite' } })` を適用
- `SortableContext` は `FavoritesSection` 内の favorites リスト部分に配置

### B4a. 折りたたみグループへの auto-expand drop

- `GroupSection.tsx`: `useDroppable({ id: \`group-header-\${groupId}\` })` でヘッダに drop 検知を追加
- `useEffect` で `isOver && collapsed` のとき 600ms タイマーを起動し `toggleCollapse` を呼ぶ
- `handleDragEnd` で `group-header-{id}` への drop は並び替えをスキップ（auto-expand のみ）

### B4b. 新規グループとして drop

- `Sidebar.tsx`: タブドラッグ中のみ `DropAsNewGroupArea` を `sidebar__footer` 内に表示
- `handleDragEnd` で `over.id === DROP_AS_NEW_GROUP_ID` のとき `createGroup` + `moveTab` を呼ぶ

### DragOverlay の分岐

- `kind=tab` → `TabItemPreview`（既存）
- `kind=group` → `GroupHeaderPreview`（新規）
- `kind=favorite` → `FavoriteItemPreview`（新規）

### テスト

- `moveFavorite` の単体テスト 5 件を `appStore.test.ts` に追加（通常移動・負クランプ・上限クランプ・同 index no-op・不正 favId no-op）
- 全 211 テスト pass

---

## 9. Unit P4-B-2 実装記録 (2026-04-25)

### B3. Settings UI

- `src/components/SettingsDialog.tsx` 新規作成: `@radix-ui/react-dialog` を使用した設定ダイアログ。フォントサイズ・フォントファミリ・スクロールバック・透明度を GUI で変更可能
- `src/components/Sidebar.tsx`: フッタの「+ New Group」ボタン隣に「⚙ Settings」ボタンを追加。`settingsOpen` state で SettingsDialog の開閉を管理
- `src/store/appStore.ts`: `updateSettings(patch)` action を追加（patch 部分更新）。`defaultSettings` に `transparency: 1.0` を追加
- `src/types/index.ts`: `Settings.transparency` フィールドを追加（0.7〜1.0 の任意フィールド、デフォルト 1.0）
- `src/styles/sidebar.css`: `sidebar__footer-buttons` (横並びレイアウト) ・ `sidebar__settings-btn` ・ `settings-range` スタイルを追加

### B5. frameless window + 背景透過

- `src-tauri/tauri.conf.json`: `decorations: false`・`transparent: true` に変更
- `src/components/TitleBar.tsx` 新規作成: `@tauri-apps/api/window` の `Window.getCurrent()` を使用したカスタムタイトルバー。最小化・最大化トグル・閉じるボタン、`data-tauri-drag-region` でドラッグ対応
- `src/App.tsx`: `TitleBar` を追加してレイアウト構造を `app-root / app-body` に整理。`--bg-alpha` CSS 変数を `transparency` 変更時に更新する `subscribe` を追加
- `src/styles/title-bar.css` 新規作成: TitleBar スタイル・`app-root` / `app-body` レイアウト・透明背景対応
- `src/styles/variables.css`: `--bg-alpha`・`--title-bar-bg`・`--title-bar-fg` CSS 変数を追加

### terminalRegistry の applySettings 拡張

- `hexToRgba` 純関数を追加 (export): 6 桁 hex → `rgba(r, g, b, alpha)` 変換
- `applySettings` 内で `transparency < 1.0` のとき `theme.background` を `hexToRgba` で半透明化。`transparency === 1.0` のとき元の `#1a1b26` に戻す

### テスト

- `updateSettings` の単体テスト 5 件を `appStore.test.ts` に追加（patch 更新・部分更新・transparency 更新・defaultSettings 確認・複数フィールド同時更新）
- `hexToRgba` の単体テスト 8 件を `terminalRegistry.test.ts` に追加（通常変換・# なし・alpha=1.0・大文字 hex・不正 hex 3 種・rgba 既存値）
- 全 231 テスト pass
