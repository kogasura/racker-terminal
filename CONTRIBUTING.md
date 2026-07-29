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
npm run lint:ts:prune # 解消済みの抑制を eslint-suppressions.json から削除
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
| ESLint の既存違反ベースライン | `eslint-suppressions.json` |

`clippy.toml` を編集しても cargo のフィンガープリントは更新されないため、閾値を変えた
直後は `touch src-tauri/src/*.rs` するか `cargo clean` しないと結果がキャッシュされたままになる。

### 関数の長さ・複雑度

| 指標 | Rust | TypeScript |
|---|---|---|
| 関数の行数 | 100 (`too_many_lines`) | 150 (`max-lines-per-function`、`.ts` のみ) |
| 複雑度 | 8 (`cognitive_complexity`) | 8 (`complexity`) |
| 引数の数 | 7 (`too_many_arguments`) | 5 (`max-params`) |
| ネストの深さ | — | 4 (`max-depth`) |

行数チェックを `.tsx` に適用していないのは、React コンポーネントが JSX を返す都合で
1 関数が長くなるのが構造上避けられず、行数で縛るとルールに合わせた不自然な分割を
誘発するため。`.tsx` は複雑度で見る。

ESLint は複雑度の歯止めに目的を絞っており、typescript-eslint の recommended などの
一般的なスタイル / 型安全ルールセットは入れていない。必要になったら段階的に足す。

### 既存違反の扱い

抑制の仕組みは Rust と TypeScript で異なる。

**Rust** — 理由コメントを添えた `#[allow(...)]` を書く。

```rust
// TODO: read / flush スレッドの生成をそれぞれ別関数に切り出す。
// 複雑度チェック導入時点での既存違反として一時的に許容している。
#[allow(clippy::too_many_lines, clippy::cognitive_complexity)]
fn spawn_reader_threads(...)
```

lint 属性は字句スコープなので、関数に付けた `allow` は内側の closure にも効く。

**TypeScript** — `eslint-suppressions.json` に記録する（ESLint 9.24+ の一括抑制機能）。
インラインの `eslint-disable` コメントは使わない。20 箇所近くをコメントで埋めると
コードが読みにくくなるうえ、解消しても消し忘れが残るため。

```
npx eslint . --suppress-all   # 現在の違反をベースラインとして記録（初回のみ）
npm run lint:ts:prune         # 解消済みの分を削除（違反を直したら実行してコミット）
```

このファイルは「解消すべき箇所の一覧」でもある。**新規の違反は抑制されない**ので、
既存分を許容しつつ新しく複雑な関数が増えるのは防げる。解消済みの抑制が残っていると
`npm run lint:ts` は失敗する（意図的な設定。ベースラインを正確に保つため）。

新規コードで安易に抑制を足さないこと。Rust 側の抑制には必ず解消方針を書く。

### テストの扱い

テストは分岐網羅のために意図的に長く・分岐が多くなるため、複雑度チェックの対象外にしている。

- TypeScript: `eslint.config.js` の `ignores` で `*.test.ts` / `*.test.tsx` を除外
- Rust: `#[cfg(test)] mod tests` の先頭に `#![allow(clippy::cognitive_complexity)]` を置く
  （`assert_eq!` は展開すると `if/else` になるため、アサーションを並べただけでも複雑度が嵩む）

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
