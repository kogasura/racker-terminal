# Racker Terminal — Phase 4 実装計画

> **Phase 4 開始 (2026-04-28〜)**: Unit P4-G (お気に入り改善) から実装中。

---

## 1. 概要・スコープ

Phase 3 完成後のユーザー使用試験で発覚した実用上の問題を解消する。

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
| 永続化 (groups / tabs / favorites を localStorage 等に保存) | Unit P4-A |
| UI 完成度 (Settings UI、テーマ選択) | Unit P4-B |
| 配布・インストーラー (msi/exe) | Unit P4-D |
| WSL Linux パスの UNC 変換 | Phase 5 |
| Favorites D&D 並び替え | Phase 4 後続 Unit |
