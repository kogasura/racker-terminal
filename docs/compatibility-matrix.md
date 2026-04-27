# Compatibility Matrix

racker-terminal が動作確認済みの環境とライブラリバージョンの記録。
WebView2 や xterm.js のメジャーアップデートで挙動が変わる可能性があるため、Phase 2 完成時のスナップショットを残す。

---

## Phase 2 完成時 (2026-04-27)

### ランタイム環境

| 項目 | バージョン |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| WebView2 Runtime | (Edge と一緒に Windows Update で自動更新) |
| Node.js | (Vite 7 互換、20+) |
| Rust | edition 2021 |

### Tauri / WebView2

| パッケージ | バージョン | 備考 |
|---|---|---|
| `tauri` (Rust) | `2` | ConPTY/WebView2 連携 |
| `tauri-plugin-opener` | `2` | |
| `@tauri-apps/api` | `^2` | Channel API 使用 |
| `@tauri-apps/cli` | `^2` | |

### Frontend

| パッケージ | バージョン | 備考 |
|---|---|---|
| `react` | `^19.1.0` | StrictMode + `inert` 属性 boolean 対応 |
| `react-dom` | `^19.1.0` | |
| `typescript` | `~5.8.3` | strict mode |
| `vite` | `^7.0.4` | HMR 復活 (Phase 2 Unit H) |
| `zustand` | `^5.0.12` | curried 記法、`useShallow` 使用 |
| `@xterm/xterm` | `^6.0.0` | Canvas renderer (WebGL は Phase 3 送り) |
| `@xterm/addon-fit` | `^0.11.0` | |
| `@xterm/addon-webgl` | `^0.19.0` | **未使用** (Phase 3 で復活検討) |
| `@dnd-kit/core` | `^6.3.1` | PointerSensor + activationConstraint |
| `@dnd-kit/sortable` | `^10.0.0` | |
| `@dnd-kit/utilities` | `^3.2.2` | |
| `@radix-ui/react-context-menu` | `^2.2.16` | |
| `nanoid` | `^5.1.9` | newId() フォールバック |

### Backend (Rust)

| クレート | バージョン | 備考 |
|---|---|---|
| `portable-pty` | `0.9` | ConPTY ラッパー |
| `parking_lot` | `0.12` | Mutex / Condvar |
| `serde` | `1` | derive feature |
| `uuid` | `1` | v4 + serde |
| `which` | `7` | shell 解決 |
| `thiserror` | `2` | エラー定義 |
| `dirs` | `5` | home_dir |

### テスト

| 項目 | 件数 |
|---|---|
| Frontend (vitest + happy-dom) | 131 |
| Rust (cargo test) | 10 |

---

## 既知の互換性リスク

### 1. WebView2 自動更新による native crash 前科
- **Phase 1**: `@xterm/addon-webgl` を loadAddon すると WebView2 が native crash した
- **Phase 2 対応**: WebGL addon は import するが loadAddon しない
- **Phase 3**: WebGL 復活時は最新 WebView2 で実機検証必須

### 2. Vite 依存最適化リロード
- 初回 `npm install` 後の `npm run tauri dev` で「Vite が依存最適化 → ページリロード」が走る
- リロードで WebView2 が空白になる場合がある
- **対処**: `npx vite optimize --force` で事前最適化、または初回起動後に再起動

### 3. xterm.js v6 メジャーバージョン
- `IDisposable` API は v6 でも維持
- v7 で削除議論あり (要監視)

### 4. WebView2 (Edge Chromium) Windows Update
- 月次の Edge 更新で挙動が変わる可能性
- 重大な機能変更時はリリースノートで告知される

---

## バージョンアップ時の検証手順

新しいバージョンに更新した際、以下を実機で確認:

1. アプリ起動 → nushell プロンプト表示 (PTY spawn 成功)
2. タブ作成・削除 (StrictMode 二重 mount 耐性)
3. `exit` → `[Exited (code: 0)]` (child watcher 動作)
4. タブ間 D&D (PointerSensor 動作)
5. HMR トリガー → リロード後正常動作
6. 大量出力 (`yes` 等) → back-pressure 発火 ([output truncated] 表示)

問題があれば `Cargo.lock` / `package-lock.json` を Phase 2 時点に戻してから差分調査する。
