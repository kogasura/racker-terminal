# Racker Terminal — Phase 1 実装計画

## Context

ユーザー（システム管理者・開発者）は、既存のターミナルアプリ（WezTerm 含む）の UI に満足できていない。特に以下 3 点が求める機能として合意済み:

1. **タブのグループ化**（Chrome Arc 風の縦サイドバー、2 階層）
2. **タブのスリープ化**（作業を寝かせるタブの置き場）
3. **お気に入り**（ワンクリックで頻用プロジェクトの新規タブ起動）

目標は「UI を自分好みに作る」ことであり、端末としての難所（ANSI 解釈、描画、PTY）は成熟ライブラリに委ねる。内部は `xterm.js` (VSCode 内蔵ターミナルと同じエンジン) + `portable-pty` (WezTerm 由来の ConPTY ラッパー) を使い、殻は Tauri 2 で Windows native に閉じる。

本 Plan は **Phase 1** の実装計画に限定する。Phase 1 のゴールは「**1 タブで nushell が起動・入出力できる状態まで**」。UI 本命（縦サイドバー・グループ・D&D・お気に入り）は Phase 2、磨き込み（テーマ・永続化・インストーラー）は Phase 3 で別 Plan を起こす。

プロジェクト名: **racker-terminal**
配置先: `<dev-dir>/racker-terminal`

---

## 技術スタック（Phase 1 確定分）

| 層 | 採用 | 備考 |
|---|---|---|
| 殻 | **Tauri 2** | WebView2 (Win11 標準)、Rust backend |
| Frontend | **React 18 + TypeScript + Vite** | create-tauri-app 標準テンプレート |
| スタイリング | **Tailwind CSS v4** | `@tailwindcss/vite` プラグイン方式、設定ファイル不要 |
| 端末描画 | **@xterm/xterm v5** + `@xterm/addon-fit` + `@xterm/addon-webgl` | `xterm` は deprecated、scoped 版を使用 |
| PTY | **portable-pty** crate (Rust) | WezTerm 由来、ConPTY を内部で使用 |
| IPC | **Tauri v2 Channel API** | JSON event より効率的、バースト出力でも耐える |
| その他 Rust 依存 | `tokio`, `serde`, `uuid`, `which`, `thiserror`, `parking_lot` | |

---

## アーキテクチャ

### IPC プロトコル（共通契約）

**invoke（Frontend → Rust）**:
```rust
// Rust 側のコマンド
pty_spawn(shell: Option<String>, cwd: Option<String>, cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> Result<String, String>
pty_write(id: String, data: String) -> Result<(), String>
pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String>
pty_kill(id: String) -> Result<(), String>
```

**Channel イベント（Rust → Frontend）**:
```rust
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PtyEvent {
    Data { text: String },         // UTF-8 として完結した部分のみ送出
    Exit { code: Option<i32> },
    Error { message: String },
}
```

TypeScript 側も対応する型を `src/lib/pty.ts` に定義し、型整合性を保つ。

### Rust backend

```
src-tauri/src/
├── main.rs        # Tauri ランタイム起動
├── lib.rs         # app setup、state 登録、commands register、CSP 等
└── pty.rs         # PtyManager + PtySession + commands
```

- `PtyManager`: `Arc<RwLock<HashMap<String, Arc<PtySession>>>>`（parking_lot）で複数セッション管理
  - Phase 1 は 1 セッションだが、Phase 2 以降の拡張を見越して最初から map で
- `PtySession`:
  - `pair: PtyPair`（portable-pty）
  - `writer: Mutex<Box<dyn Write + Send>>`
  - `reader_handle: JoinHandle<()>`
  - `stop_flag: Arc<AtomicBool>`（Drop で stop）
  - `channel: Channel<PtyEvent>`

### reader スレッドのバッファリング

Plan agent の助言に基づく設計:
- **16ms タイマー または 64KB 閾値** で flush（どちらか先に達したら）
- **UTF-8 境界保持**: PTY は任意バイトで切れるので、バッファの末尾が不完全なマルチバイト文字なら次チャンクに持ち越す
  - `std::str::from_utf8` で検証 → 失敗位置を `Utf8Error::valid_up_to()` で取得、有効部分だけ送って残りを `pending` に残す
- スレッド内に `Vec<u8>` バッファ、`Instant::now()` で timer チェック
- EOF を受けたら `PtyEvent::Exit` を送って終了

### Frontend

```
src/
├── main.tsx              # React エントリ
├── App.tsx               # Phase 1: 単一 Terminal 全画面
├── components/
│   └── Terminal.tsx      # xterm.js ラッパー
├── lib/
│   └── pty.ts            # Tauri invoke + Channel ラッパー、型定義
├── styles.css            # @import "tailwindcss" + @import "@xterm/xterm/css/xterm.css"
└── index.html
```

- `lib/pty.ts`:
  - `spawnPty(opts) -> Promise<{ id, unsubscribe }>` — Channel を作って invoke、イベント購読
  - `writePty(id, data)`, `resizePty(id, cols, rows)`, `killPty(id)`
  - `PtyEvent` 型を Rust と揃える
- `components/Terminal.tsx`:
  - `useRef<Terminal>` で xterm インスタンス保持
  - `useEffect` でマウント時に:
    1. xterm.Terminal を生成、Tokyo Night theme, Monaspace Neon フォント, scrollback 10000
    2. addon-fit, addon-webgl をロード。WebGL は `onContextLoss` を監視して Canvas renderer にフォールバック
    3. `spawnPty` を呼び、返る Channel イベントを `term.write` に流す
    4. `term.onData` で `writePty`
    5. ResizeObserver で要素サイズ変化を検知 → `fitAddon.fit()` → `resizePty`
  - `useEffect` cleanup で `killPty`、addon dispose、`term.dispose`
- `App.tsx` は `<Terminal />` を `className="h-screen w-screen"` で全画面配置

### ウィンドウ設定（`tauri.conf.json`）

- Phase 1 はシンプルに:
  - `width: 1200`, `height: 800`
  - `decorations: true`（フレームあり、Phase 3 で frameless 検討）
  - `resizable: true`
- **CSP 設定**: Tailwind v4 と xterm.js のため `style-src 'self' 'unsafe-inline'` を許可
- **auto-updater, devtools（prod）は無効化**（ビルド重くなる対策）

### ハードコード設定（Phase 1 のみ）

| 項目 | 値 |
|---|---|
| シェル | `which::which("nu")` で絶対パス解決（見つからなければエラー表示） |
| cwd | ユーザーの home (`dirs::home_dir()`) |
| 環境変数 | `TERM=xterm-256color`, `COLORTERM=truecolor` を設定 |
| フォント | Monaspace Neon (`MonaspiceNe NF`) 12.5pt、fallback: `Cascadia Code`, `Consolas` |
| 初期サイズ | 120 cols x 35 rows（fit で即座に調整される） |
| xterm テーマ | Tokyo Night（bg=#1a1b26, fg=#c0caf5 等） |

---

## 実装単位

### Unit 1: プロジェクト初期化（直列、最優先）

1. `cd <dev-dir>` で `npm create tauri-app@latest racker-terminal -- --template react-ts`
2. Cargo 依存追加（`src-tauri/Cargo.toml`）:
   ```toml
   portable-pty = "0.9"
   tokio = { version = "1", features = ["rt-multi-thread", "sync", "io-util", "macros"] }
   serde = { version = "1", features = ["derive"] }
   uuid = { version = "1", features = ["v4", "serde"] }
   which = "7"
   thiserror = "2"
   parking_lot = "0.12"
   dirs = "5"
   ```
3. npm 依存追加:
   ```
   @xterm/xterm @xterm/addon-fit @xterm/addon-webgl
   tailwindcss @tailwindcss/vite
   ```
4. Tailwind v4 セットアップ:
   - `vite.config.ts` で `import tailwind from '@tailwindcss/vite'` → plugins 追加
   - `src/styles.css` に `@import "tailwindcss";` + `@import "@xterm/xterm/css/xterm.css";`
   - `tailwind.config.ts` は **作らない**（v4 は不要）
5. `tauri.conf.json`:
   - `productName: "Racker Terminal"`
   - `identifier: "com.yokubo.racker"`
   - `app.security.csp`: `"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self';"`
   - `app.windows[0]`: width/height/title/decorations 設定
6. 動作確認: `npm run tauri dev` で空の React 画面が起動

### Unit 2: Rust PTY backend（Unit 1 に依存）

ファイル: `src-tauri/src/pty.rs`（新規）、`src-tauri/src/lib.rs`（変更）

1. `PtyEvent` enum 定義（Serialize）
2. `PtySession` struct:
   - spawn ロジック: `native_pty_system()` → `openpty` → `CommandBuilder`
   - `CommandBuilder::new(shell_path)` で env 設定、cwd 設定
   - reader thread spawn:
     - `Arc<AtomicBool>` で停止制御
     - `Vec<u8>` バッファ、`Instant` で 16ms タイマー
     - `std::str::from_utf8` で UTF-8 境界検証、不完全部分は pending へ
     - flush 時 `Channel::send(PtyEvent::Data { text })`
     - EOF 検知時 `Channel::send(PtyEvent::Exit { code })`
3. `PtyManager`:
   - `spawn`, `write`, `resize`, `kill` メソッド
4. Tauri commands: `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`
5. `lib.rs` で `PtyManager` を `State` として `manage`、`invoke_handler` に commands を登録
6. `Drop` for `PtySession`: stop_flag セット → writer 閉じて reader 終了を促す → thread join

### Unit 3: Frontend PTY ラッパー + Terminal コンポーネント（Unit 2 と並列可、Unit 1 完了後）

並列化するため、Unit 2 着手前に Unit 1 の中で IPC プロトコル（`PtyEvent` の Rust 型と TS 型）を合わせて commit しておくこと。

ファイル: `src/lib/pty.ts`（新規）、`src/components/Terminal.tsx`（新規）、`src/App.tsx`（変更）

1. `lib/pty.ts`:
   - `PtyEvent` 型定義（Rust と揃える tagged union）
   - `spawnPty(opts, onEvent)` — `Channel<PtyEvent>` を作って `invoke('pty_spawn', { ..., onEvent: channel })`
   - Tauri v2 の Channel import: `import { Channel } from '@tauri-apps/api/core'`
   - `writePty`, `resizePty`, `killPty`
2. `components/Terminal.tsx`:
   - `useRef` で `Terminal`, `FitAddon`, `WebglAddon` を保持
   - マウント時の初期化順序: xterm 生成 → `open(div)` → addon 接続 → PTY spawn
   - WebGL fallback: `webglAddon.onContextLoss(() => { webglAddon.dispose(); /* Canvas にフォールバック、Phase 1 は放置でも可 */ })`
   - ResizeObserver で fit → resize
   - アンマウント時の cleanup
3. `App.tsx`:
   - `<div className="h-screen w-screen bg-[#1a1b26]"><Terminal /></div>` で全画面表示

### Unit 4: 統合 + 動作確認（Unit 2 & 3 完了後）

1. `npm run tauri dev` でアプリ起動
2. nushell プロンプト表示確認
3. コマンド入力・出力・カーソル・resize・exit の動作確認（詳細は「検証」セクション）
4. 問題があれば Unit 2/3 に戻って修正

---

## 変更・新規ファイル一覧

### 新規作成
```
<dev-dir>\racker-terminal\
├── src-tauri\
│   ├── src\
│   │   ├── main.rs              # テンプレ → そのまま
│   │   ├── lib.rs               # テンプレから変更（state、commands 登録）
│   │   └── pty.rs               # 新規
│   ├── Cargo.toml               # 依存追加
│   ├── build.rs                 # テンプレそのまま
│   ├── tauri.conf.json          # ウィンドウ設定、CSP、productName
│   └── icons\                   # テンプレそのまま
├── src\
│   ├── main.tsx                 # テンプレから変更（styles.css 読み込み）
│   ├── App.tsx                  # テンプレから変更（Terminal を全画面）
│   ├── components\
│   │   └── Terminal.tsx         # 新規
│   ├── lib\
│   │   └── pty.ts               # 新規
│   └── styles.css               # 新規（Tailwind + xterm CSS）
├── index.html                   # テンプレそのまま
├── package.json                 # 依存追加
├── tsconfig.json                # テンプレそのまま
├── vite.config.ts               # Tailwind plugin 追加
└── .gitignore                   # テンプレそのまま
```

### 既存ファイル変更
なし（新規プロジェクト）

---

## 考慮事項・リスク（Phase 1 で対処するもの）

| # | リスク | 対処 |
|---|---|---|
| 1 | event ベースの JSON overhead でバースト出力時にラグ | **Tauri v2 Channel API を Phase 1 から使用**（差し替えコスト低、後で嵌まると数日溶ける） |
| 2 | PTY バイト列が UTF-8 境界で切れて文字化け | reader スレッド内に pending buffer、`str::from_utf8().valid_up_to()` で有効範囲だけ送出、残りは次チャンクに持ち越し |
| 3 | xterm CSS を忘れるとカーソル消失・選択不可 | `@xterm/xterm/css/xterm.css` を styles.css で import |
| 4 | WebGL renderer が Windows GPU ドライバで黒画面になる事例あり | `onContextLoss` フックを入れておく（完全な Canvas fallback は Phase 2 で磨く） |
| 5 | Tailwind v4 の inline style が Tauri CSP で弾かれる | `style-src 'self' 'unsafe-inline'` を `tauri.conf.json` で許可 |
| 6 | GUI プロセスの PATH が CLI と違い、`nu` がコマンド名だけでは解決できない | `which` crate で絶対パス解決、失敗時はエラーメッセージを画面に表示 |
| 7 | 1ms debounce や固定バイト閾値は non-optimal | **16ms タイマー OR 64KB 閾値** の複合で flush |
| 8 | reader スレッドがアプリ終了時に join せずハング | `Arc<AtomicBool>` 停止フラグ + `Drop` 実装で確実に停止 |
| 9 | Tauri v2 auto-updater / devtools がビルドを遅くする | Phase 1 では無効化 |

### Phase 1 では**あえて対処しない**もの
- 絵文字の幅不整合（xterm vs ConPTY）: 既知の仕様、Phase 3 で表示調整検討
- リガチャ: WebGL 非対応、Canvas 対応のみ。Phase 3 で検討
- IME の細かい挙動: Phase 1 は xterm デフォルト、動けば OK
- PTY セッションの自動再起動: nushell が exit したら表示だけ、再起動は Phase 2
- unit test: backend は最小限（PtyManager のハッピーパスのみ、Phase 1 では optional）

---

## 検証（動作確認）

### Phase 1 完了条件（手動テスト）

1. `npm run tauri dev` でアプリがエラーなく起動する
2. 起動直後にウィンドウ全面が黒背景で、nushell のプロンプトが表示される
3. コマンド入力ができ、`ls`, `echo hello`, `ls | where type == dir` 等が動作する
4. ANSI カラーが正しく表示される（`ls` のディレクトリが色付き）
5. マルチバイト文字が文字化けしない（`echo こんにちは` が正常表示）
6. 上下矢印でコマンド履歴が正常に動く
7. ウィンドウを resize すると、ターミナルの行列数が追随する
8. `exit` で PTY が終了し、ウィンドウがクラッシュしない（exit 表示でも OK）
9. アプリ終了時（ウィンドウ × ボタン）にハングせず正常終了する

### 自動テスト
- Phase 1 では最小限（Rust 側で `PtyManager::spawn` が id を返すハッピーパスのみ、optional）
- E2E は Phase 3 で Tauri WebDriver 検討（Phase 1 はスキップ）

---

## 既存ライブラリ・参考実装

- [**portable-pty**](https://crates.io/crates/portable-pty) — WezTerm の PTY モジュール独立版
- [**@xterm/xterm**](https://www.npmjs.com/package/@xterm/xterm) — VSCode 内蔵ターミナルも採用
- [**@tailwindcss/vite**](https://tailwindcss.com/docs/installation/using-vite) — v4 の Vite プラグイン方式
- [**Tauri v2 Channel**](https://v2.tauri.app/develop/calling-frontend/#channels) — 効率的 IPC
- 参考コード: `<dev-dir>\tauri-transparent-test`（Tauri 2 最小構成、依存は空）

---

## Out of Scope（Phase 1 で扱わない、後続 Phase で）

### Phase 2 で対応
- 複数タブ
- 縦サイドバー UI（グループ + タブ2階層）
- ドラッグ&ドロップ、右クリックメニュー、インライン UI
- お気に入り
- sleep グループ

### Phase 3 で対応
- 永続化（`%APPDATA%\racker-terminal\state.json`）
- テーマ適用（Tokyo Night の本格ロード）
- フォント埋め込み（@font-face で配布バンドル）
- 背景透過（`decorations: false`、`transparent: true`）
- インストーラー（MSIX or NSIS）
- IME 詳細調整
- Canvas renderer fallback 完全実装
