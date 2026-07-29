# Contributing to Racker Terminal

## 依存更新ポリシー

racker-terminal は WebView2 (Chromium) + xterm.js + portable-pty + Tauri 2 の
組み合わせで動作する。各依存は破壊的変更が起きやすいため:

1. **依存更新は専用 PR**: 1 PR = 1 依存パッケージ
2. **手動 E2E 検証必須**: nushell / WSL / PowerShell / cmd の起動確認
3. **`Cargo.lock` / `package-lock.json` をコミット**: ビルド再現性確保
4. **Rust toolchain**: リポジトリ直下の `rust-toolchain.toml` で `stable` に固定。
   `rustfmt` / `clippy` コンポーネントも同ファイルが担保するため、rustup 環境なら
   追加インストールは不要

## Lint / フォーマット

Rust 側は rustfmt + clippy、TypeScript 側は ESLint で機械的にチェックする。
CI（`.github/workflows/ci.yml`）が PR ごとに実行するので、ローカルでも push 前に
通しておくこと。

```
npm run fmt:rs        # Rust の整形を適用
npm run fmt:rs:check  # 整形の差分チェックのみ（CI と同じ）
npm run lint:rs       # clippy（警告をエラー扱い）
npm run lint:ts       # ESLint（関数の長さ・複雑度）
```

`npm run lint:rs` は `tauri::generate_context!` が `tauri.conf.json` の
`frontendDist` (`../dist`) をコンパイル時に読むため、事前に `npm run build` が必要。

### 設定ファイル

| 対象 | ファイル |
|---|---|
| rustfmt | `src-tauri/rustfmt.toml`（stable のオプションのみ使う） |
| clippy の閾値 | `src-tauri/clippy.toml` |
| clippy の lint 有効化 | `src-tauri/Cargo.toml` の `[lints.clippy]` |
| ESLint | `eslint.config.js` |

### 関数の長さ・複雑度

| 指標 | Rust | TypeScript |
|---|---|---|
| 関数の行数 | 100 (`too_many_lines`) | 150 (`max-lines-per-function`、`.ts` のみ) |
| 複雑度 | 15 (`cognitive_complexity`) | 15 (`complexity`) |
| 引数の数 | 7 (`too_many_arguments`) | 5 (`max-params`) |
| ネストの深さ | — | 4 (`max-depth`) |

行数チェックを `.tsx` に適用していないのは、React コンポーネントが JSX を返す都合で
1 関数が長くなるのが構造上避けられず、行数で縛るとルールに合わせた不自然な分割を
誘発するため。`.tsx` は複雑度で見る。

ESLint は複雑度の歯止めに目的を絞っており、typescript-eslint の recommended などの
一般的なスタイル / 型安全ルールセットは入れていない。必要になったら段階的に足す。

### 既存箇所を許容する場合

閾値を超える既存コードは、理由コメントを添えて抑制する。

```rust
// TODO: read / flush スレッドの生成をそれぞれ別関数に切り出す。
#[allow(clippy::too_many_lines)]
fn spawn_reader_threads(...)
```

```ts
// TODO: キーバインド判定をテーブル駆動に置き換える。
// eslint-disable-next-line complexity
const handler = (e: KeyboardEvent): boolean => {
```

新規コードで安易に抑制を足さないこと。抑制には必ず解消方針を書く。

## ビルド手順

開発:
```
npm install
npm run tauri dev
```

リリースビルド:
```
npm run tauri build
```
出力: `src-tauri/target/release/bundle/{nsis,msi}/`

## Phase / Unit について

実装は Phase × Unit で管理: `docs/phase4-plan.md` 参照。
