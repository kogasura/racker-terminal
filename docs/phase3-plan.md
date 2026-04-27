# Racker Terminal — Phase 3 実装計画 (スケルトン)

> Phase 2 完成 (2026-04-27) 後に作成。Phase 3 のスコープを精査するためのドラフト。
> 確定スコープ・実装順序は後段の議論で決定する。

---

## 1. Context

Phase 2 で「複数 PTY セッションを単一ウィンドウで管理する UI 本命機能」が完成した。
Phase 3 ではユーザーが日常的にツールとして使い始められる **永続化・カスタマイズ・配布** に重心を移す。

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

### 2.3 WebGL renderer 復活
- `@xterm/addon-webgl` を loadAddon
- StrictMode 下で WebGL context の二重作成を防ぐ (acquireRuntime の refcount 設計を活用)
- WebView2 native crash の再検証必須

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

### 2.12 異常終了の網羅検証
- `Ctrl-D` / `[Environment]::Exit` / `taskkill /F` / ssh 切断
- child watcher が 100ms 以内に検出することを T14 拡張

### 2.13 IME 改善 (xterm 側)
- Windows ConPTY + nushell/PowerShell の IME 中間文字列流入問題

### 2.14 国際化キーボード対応
- `e.code === 'KeyW'` 切替 (CapsLock / 非 ASCII レイアウト対応)

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

## 3. テーマ別グループ化 (案)

Phase 3 を進める単位として、テーマでまとめる案:

### A. 永続化 (Persistence)
- 2.1 `zustand/persist` 導入
- 2.2 Tab.title 分離 (永続化と密接)
- 2.20 scrollback 復元不可の明示

### B. UI 完成度向上 (Polish)
- 2.4 グループ D&D
- 2.5 Favorites D&D
- 2.6 Settings UI
- 2.7 新規グループ drop
- 2.8 auto-expand drop

### C. パフォーマンス
- 2.3 WebGL renderer 復活
- 2.9 back-pressure 改善

### D. 安定性 (Robustness)
- 2.10 detached thread リーク
- 2.11 spawning タイムアウト
- 2.12 異常終了検証
- 2.13 IME 改善
- 2.14 国際化キーボード

### E. 配布 (Distribution)
- 2.17 インストーラー
- 2.18 frameless window
- 2.19 フォント埋め込み
- 2.15 更新ポリシー

### F. テスト・品質
- 2.16 UI レンダリングテスト
- 2.21 Sleep / Wake (要検討)

---

## 4. 優先度議論ポイント

ユーザーと議論して決める:

### 4.1 必須 vs 任意
- ユーザーが「日常使い」できる状態にするには **永続化** が必須? 
- 配布 (2.17) はマイルストーン v1.0 のために必須?

### 4.2 順序
- 永続化 (A) → UI 完成度 (B) → 配布 (E) の順序で進めるのが自然
- パフォーマンス (C) と安定性 (D) は永続化と並行可能

### 4.3 スコープ縮小
- Phase 3 で全部やると重い → v0.2 / v0.3 に分割する案
- 最低限「永続化 + 配布」で v1.0 とする案も

### 4.4 後送り候補
- Sleep / Wake (2.21): 価値 vs 痛みのバランス
- 国際化 (2.13/2.14): ユーザー本人が必要としているか

---

## 5. 実装単位の予想 (確定後に詳細化)

仮の Unit 分割 (要議論):

| Unit | テーマ | 主な内容 |
|---|---|---|
| P-A1 | persist 導入 | zustand/persist + partialize |
| P-A2 | title 構造分離 | userTitle / oscTitle 分離 |
| P-B1 | グループ D&D | 既存 dnd-kit 拡張 |
| P-B2 | Favorites D&D | moveFavorite + Sortable |
| P-B3 | Settings UI | フォント・scrollback・theme 変更 UI |
| P-C1 | WebGL renderer | addon-webgl 復活 + 検証 |
| P-D1 | 安定性まとめ | thread leak / timeout / 異常終了 |
| P-E1 | 配布 | Tauri build + インストーラー |
| P-F1 | UI テスト | testing-library + Playwright |

---

## 6. 次のアクション

このドラフトをもとに以下を議論:

1. **Phase 3 のスコープ確定**: 何を含めて何を v0.3 / v1.0 送りにするか
2. **優先度合意**: 永続化を先にするか、UI 完成度を先にするか
3. **マイルストーン定義**: v0.2 / v0.3 / v1.0 の到達条件

決定次第、各 Unit の詳細設計 (`docs/unit-p-*-design.md`) を作成して実装に進む。
