# Racker Terminal — Phase 3 実装計画

> **Phase 3 (絞り込みスコープ) 完成 (2026-04-27)**: パフォーマンス + 安定性の **6 項目 (2.3, 2.10〜2.14)** を実装完了。
> WebView2 native crash は **再現せず** WebGL renderer が安全に復活。
> 残 15 項目は **Phase 4 送り** または **永久送り** に分類 (§7 参照)。
>
> 実装 PR: #16 (P-D1) / #17 (P-D3) / #18 (P-C1) / #19 (P-D2)
> Frontend 142 tests pass / Rust 10 tests pass

---

## 1. Context

Phase 2 で「複数 PTY セッションを単一ウィンドウで管理する UI 本命機能」が完成。
Phase 3 はユーザー指示により **パフォーマンス (C) + 安定性 (D) のみ** に絞り込んで実装した。
それ以外 (永続化・配布・Settings UI 等) は Phase 4 / 永久送り。

---

## 2. Phase 2 から積み残した送り項目

各 Unit 設計書および phase2-plan.md §8 で「Phase 3 送り」と明記されたもの:

### 2.1 永続化
- **`zustand/persist` 導入**
  - Persist OFF (ランタイム状態): `activeTabId`, `editingId`, `contextMenuOpen`, `tabs[*].status`, `tabs[*].ptyId`
  - Persist ON (復元対象): `groups`, `tabs[*].{id, groupId, title, shell, cwd, env}`, `favorites`, `settings`
  - 復元時の hydrate: 既存タブは新規 PTY を spawn し直す (status='spawning' 起点)

### 2.2 Tab.title の構造分離
- 現状: `Tab.title` 1 フィールド + 編集中ガードで OSC 上書き防御
- 改善: `Tab.userTitle` (ユーザー編集) と `Tab.oscTitle` (shell の OSC) に分離
- 表示: `userTitle ?? oscTitle ?? defaultTitle`
- 関連: phase2-plan §3.1 永続化メモで言及済み

### 2.3 WebGL renderer 復活 **[実装完了 — Unit P-C1]**
- `@xterm/addon-webgl` を loadAddon
- StrictMode 下で WebGL context の二重作成を防ぐ (acquireRuntime の refcount 設計を活用)
- WebView2 native crash の再検証必須
- **実装**: `createRuntime` 内で `term.open()` 後に `WebglAddon` を try/catch で loadAddon。
  `onContextLoss` ハンドラで Canvas renderer に自動フォールバック。
  dispose 順序: `webglAddon?.dispose()` を `fitAddon.dispose()` より前に追加 (§3.2 参照)。
- **WebView2 native crash の有無は発注者が実機検証**。crash 再現時は即 revert して compatibility-matrix.md に記録。

### 2.4 グループ自体の D&D 並び替え
- store の `moveGroup` は Unit B で先回り実装済
- UI トリガーを Unit F の枠組みに追加 (DndContext 内に Group 用 SortableContext)

### 2.5 Favorites の D&D 並び替え
- `moveFavorite(favId, toIndex)` アクション追加
- FavoritesSection に Sortable 統合

### 2.6 Settings UI
- フォントサイズ・フォントファミリ・scrollback・theme をユーザーが GUI で変更
- `applySettings` broadcast 機構は Unit D+E で実装済 → UI を被せるだけ

### 2.7 タブを新規グループとしてドロップ
- D&D で既存グループ外にドロップ → 新規グループ作成 + そこに移動

### 2.8 折りたたみグループへの auto-expand drop
- D&D ドラッグ中に折りたたみグループのヘッダ上で 600ms ホバー → 自動展開

### 2.9 raw_buf back-pressure 改善
- 現状: 4MB 超で前半 50% drain
- 改善: tiny read しきい値・back-pressure しきい値を Settings 化

### 2.10 Drop の detached thread リーク **[実装完了 — Unit P-D1]**
- `pty.rs` の `Drop` で `std::thread::spawn(move || h.join())` が join されない
- reaper thread でまとめる、または `h.join()` 直接呼び (Drop 短時間ブロック許容)
- **対策 (案 B 採用)**: Drop で直接 `h.join()` を呼ぶ。reader/flush/watch はいずれも
  stop_flag=true + master drop (EOF) 後、数 ms 以内に抜けるため短時間ブロック許容。
  detached spawn を撤廃し tatched に統一することでリークを撲滅。

### 2.11 spawning タイムアウト UX **[実装完了 — Unit P-D1]**
- 10 秒経っても live にならなかったら crashed 扱い (企業 EDR 環境対応)
- **実装**: `TerminalPane.tsx` に `useEffect([tab.status, tabId])` を追加し 10 秒タイムアウトを監視。
  status が live or crashed に変わると clearTimeout でキャンセル。
- **リスク**: EDR 環境で誤検知する場合は 30 秒に延長、または Settings 化を検討すること。

### 2.12 異常終了の網羅検証 **[実装完了 (検証中心) — Unit P-D2]**
- `Ctrl-D` / `[Environment]::Exit` / `taskkill /F` / ssh 切断 / タスクマネージャ強制終了
- 既存の `spawn_child_watcher` (100ms ポーリング + `child.try_wait()`) で全シナリオをカバー済みと確認
- **コード変更なし**: 網羅性分析 + コメント追加 + 検証シナリオドキュメント化のみ
- 実機検証 VS01〜VS05 は発注者が実施 (`docs/unit-pd2-design.md` §3 を参照)

### 2.13 IME 改善 (xterm 側) **[実装完了 — Unit P-D3]**
- Windows ConPTY + nushell/PowerShell の IME 中間文字列流入問題
- **対策**: `term.textarea` に `compositionstart`/`compositionend` リスナーを attach し、
  合成中の `onData` を drop。AbortController で一括解除。dispose 順序 §3.2 に `compositionAbort.abort()` を追加。

### 2.14 国際化キーボード対応 **[実装完了 — Unit P-D3]**
- `e.code === 'KeyW'` 切替 (CapsLock / 非 ASCII レイアウト対応)
- **対策**: `TerminalPane.tsx` の `attachCustomKeyEventHandler` を `e.key` から `e.code` ベースに切替。
  `'w'/'W'` → `'KeyW'`、`'Tab'` → `'Tab'` (e.code)。物理キー位置判定で CapsLock・AZERTY 対応。

### 2.15 `Tauri` / WebView2 / xterm.js 更新ポリシー
- `Cargo.lock` 固定 + Tauri 更新ルール (CONTRIBUTING に明記)

### 2.16 UI コンポーネントテスト
- `@testing-library/react` で Sidebar / GroupSection / TabItem / FavoritesSection / InlineEdit のレンダリングテスト
- D&D 部分は Playwright E2E

### 2.17 配布・インストーラー
- Tauri ビルド (msi / exe)
- 署名・公開先選定

### 2.18 背景透過・frameless window
- Tokyo Night テーマと組み合わせた見た目改善
- Tauri の `decorations: false` + カスタムタイトルバー

### 2.19 フォント埋め込み
- @font-face で MonaspiceNe NF などをバンドル
- 配布バイナリでフォント未インストール環境でも動作

### 2.20 scrollback 復元不可の明示
- ユーザー期待管理: 「Phase 3 でも scrollback は復元しない」を Settings UI / README に明記

### 2.21 Sleep / Wake (Phase 2 で見送られた機能)
- 大量タブ運用時のメモリ削減
- ただし scrollback が失われる UX 痛みあり、要検討

---

## 3. Phase 3 で実装した Unit (確定)

| Unit | PR | 主な内容 |
|---|---|---|
| **P-D1** | #16 | detached thread リーク対策 (2.10) + spawning タイムアウト (2.11) |
| **P-D3** | #17 | IME 改善 (2.13) + e.code ベースキーバインド (2.14) |
| **P-C1** | #18 | WebGL renderer 復活 + onContextLoss + Canvas fallback (2.3) |
| **P-D2** | #19 | 異常終了の網羅検証 (2.12) — ドキュメント中心 |

**WebView2 native crash は再現せず**: Phase 1 で WebGL を無効化していた WebView2 native crash 問題は、最新の WebView2 / xterm.js v6 / addon-webgl 0.19 の組み合わせで **解消されたことを確認** (2026-04-27 起動検証)。

---

## 4. Phase 4 / 永久送り項目

Phase 3 で対象外とした 15 項目を分類。Phase 4 開始時に再度精査する。

### A. 永続化 (Phase 4 最有力候補)
- **2.1 `zustand/persist` 導入** — 起動時にタブ・グループ・お気に入り復元
- **2.2 Tab.title の構造分離** (userTitle / oscTitle) — 永続化と密接
- **2.20 scrollback 復元不可の明示** — ユーザー期待管理

### B. UI 完成度向上 (Phase 4)
- **2.4 グループ自体の D&D 並び替え** — store の moveGroup は実装済、UI 追加のみ
- **2.5 Favorites の D&D 並び替え** — moveFavorite + Sortable 統合
- **2.6 Settings UI** — フォント・scrollback・theme 変更 GUI
- **2.7 タブを新規グループとしてドロップ** — D&D で新規グループ作成
- **2.8 折りたたみグループへの auto-expand drop** — 600ms ホバーで自動展開

### C. パフォーマンス改善 (Phase 4 / 永久送り)
- **2.9 raw_buf back-pressure しきい値の Settings 化** — Settings UI 完成後に同時実装

### D. 配布 (Phase 4)
- **2.15 Tauri / WebView2 / xterm.js 更新ポリシー** — Cargo.lock 固定 + CONTRIBUTING
- **2.17 配布・インストーラー** — Tauri ビルド (msi/exe) + 署名
- **2.18 背景透過・frameless window** — Tokyo Night との組み合わせで見た目改善
- **2.19 フォント埋め込み** — MonaspiceNe NF を @font-face でバンドル

### E. テスト・品質 (Phase 4)
- **2.16 UI コンポーネントテスト** — `@testing-library/react` 導入

### F. 機能拡張 (永久送り候補)
- **2.21 Sleep / Wake** — 大量タブ運用時のメモリ削減。scrollback 失う UX 痛みのため要検討

---

## 5. Phase 3 完成チェックリスト

- [x] PR #16 (P-D1) マージ済み
- [x] PR #17 (P-D3) マージ済み
- [x] PR #18 (P-C1) マージ済み
- [x] PR #19 (P-D2) マージ済み
- [x] テスト件数: Frontend 142 / Rust 10 (Phase 2 比 +11)
- [x] WebGL native crash 再発なし (実機検証 2026-04-27)
- [x] StrictMode + HMR 復活状態維持
- [x] 設計書 (`unit-pd2-design.md` 新規 + 既存 5 つ更新)
- [x] `compatibility-matrix.md` に WebGL リスク追記

## 6. 次のアクション

Phase 4 着手時:

1. **スコープ精査**: §4 の 15 項目から Phase 4 で扱う範囲を確定
2. **マイルストーン定義**: v0.2 / v0.3 / v1.0 の到達条件
3. **優先度議論**:
   - 「日常使い」のために **永続化** (2.1, 2.2, 2.20) が最有力
   - 「自分の PC で常用」のために **配布** (2.17, 2.15) を組み合わせると v1.0 になる
4. 議論決定後、`docs/phase4-plan.md` を新規作成し各 Unit の詳細設計に進む。
