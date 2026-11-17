# racker のテーマ（配色）の作り方

racker の見た目（画面の枠の色と、ターミナルの 16 色）は、JSON ファイル 1 つで変えられます。
このファイルは、テーマを作る人（ユーザー）と、racker の中で動く Claude Code の両方に向けた説明です。

## Claude Code へ

このフォルダで「テーマを作って」と頼まれたら、次のとおりに作業してください。

- このフォルダの直下に、**テーマ 1 つにつき JSON ファイルを 1 つ**作る。サブフォルダには置かない。
- ファイル名は英小文字・数字・ハイフンにする（例: `sunset-neon.json`）。ファイル名がテーマの ID になる。
- 書いてよいキーは、下の「キーの一覧」にあるものだけ。色は `#rrggbb` で書く。
- `CLAUDE.md`（このファイル）は racker が上書きするので、編集しない。
- 書き終えたら、ユーザーに「racker の設定画面 → テーマの『再読み込み』→ テーマを選んで保存」で反映できると伝える。
- 文字と背景の明るさの差を十分につける。特に `fg` と `bg`、`onAccent` と `accent`、`terminal.foreground` と `terminal.background`。

## 置き場所

```
%APPDATA%\com.yokubo.racker\themes\
```

- 設定画面のテーマの節にある「フォルダを開く」で、このフォルダを Explorer で開けます。
- 「Claude でテーマを作る」を押すと、このフォルダを作業ディレクトリにした Claude Code のタブが開きます。
- 読むのはフォルダ直下の `*.json` だけです。サブフォルダの中や、ほかの拡張子のファイルは読みません。
- 1 ファイルの大きさは 64 KiB まで、ファイルの数は 100 個まで（ファイル名順で先頭から）です。
- 文字コードは UTF-8 にしてください。

## テーマの ID

ファイル名から拡張子を除いたものに `user:` を付けたものが ID です。

| ファイル名 | ID |
|---|---|
| `sunset-neon.json` | `user:sunset-neon` |

設定画面の選択肢には、ID ではなく JSON の `name` が出ます。
設定で選んでいたファイルを消したり名前を変えたりすると、Tokyo Night で表示されます。
お気に入りの「ターミナルの配色」で選んでいたファイルの場合は、そのタブはアプリのテーマに従います。
設定は消えないので、ファイルを戻せば元のテーマに戻ります。

## 反映のしかた

1. テーマフォルダに JSON を置く（または書き換える）。
2. racker の設定画面を開き、テーマの節の「再読み込み」を押す。
3. 選択肢からテーマを選び、「保存」を押す。

選択中のテーマのファイルを書き換えたときも、「再読み込み」で反映されます。

お気に入りの編集画面の「ターミナルの配色」で、そのお気に入りから開くタブのターミナル部分だけ、別のテーマの配色にできます。
画面の枠（サイドバーやタブバー）はアプリ全体のテーマのままです。

## 書き方の基本

- **書いたキーだけが上書きされます。** 書かなかったキーは、`appearance` に応じたベースのテーマの値になります。
  - `"appearance": "dark"`（または省略）のときは **Tokyo Night**
  - `"appearance": "light"` のときは **Racker Paper**
- そのため、`name` と数色だけでもテーマになります。
- **色は `#rgb` か `#rrggbb` だけ**を受け付けます（例: `#f80`、`#ff8800`）。
  - `rgb(...)`、`#rrggbbaa`（透明度付き）、`red` のような色の名前は使えません。
- **知らないキーは無視します。** 書き間違えたキーもエラーにはならず、単に効きません。キー名は下の一覧と完全に同じにしてください（大文字小文字も区別します）。

## キーの一覧

### いちばん外側

| キー | 必須 | 内容 |
|---|---|---|
| `name` | **必須** | 設定画面に出す名前。1〜40 文字の文字列 |
| `appearance` | 任意 | `"dark"` か `"light"`。省略すると `"dark"`。ベースのテーマと、ホバーの色・影などの自動で決まる色が変わる |
| `ui` | 任意 | 画面の枠の色（下の表） |
| `terminal` | 任意 | ターミナルの色（下の表） |

### `ui`（画面の枠、19 個）

| キー | 使われる場所 |
|---|---|
| `bg` | アプリの基本の背景（タイトルバー・タブバーなど） |
| `bgSidebar` | サイドバーの背景 |
| `bgElevated` | 浮いている面（ダイアログ、右クリックメニュー、ドロップダウン） |
| `bgInset` | 一段沈んだ面（入力欄など） |
| `bgHover` | マウスが乗っている項目の背景 |
| `bgActive` | 選択中の項目（アクティブなタブなど）の背景 |
| `fg` | 基本の文字色 |
| `fgMuted` | 補助の文字色（ステータスバーなど、少し控えめにしたい文字） |
| `fgDim` | さらに目立たない文字色（ヒント、無効な項目） |
| `border` | 区切り線・枠線 |
| `borderStrong` | はっきり見せたい区切り線（パネルの仕切り、入力欄の枠） |
| `accent` | 強調色（フォーカス、選択、主なボタン、リンク） |
| `accent2` | 2 番目の強調色（`accent` と並べて使う差し色） |
| `onAccent` | `accent` の上に乗る文字の色 |
| `danger` | 危険・エラー（異常終了したタブ、使用量の超過など） |
| `warning` | 注意（起動中、使用量が多い） |
| `success` | 正常・完了 |
| `agentBlocked` | Claude Code が応答を待っているタブの印 |
| `agentWorking` | Claude Code が作業中のタブの印 |

ホバーの薄い色・ダイアログの背面を暗くする色・影の色は、`appearance` から自動で決まります。JSON では指定できません。

### `terminal`（ターミナル、21 個）

| キー | 内容 |
|---|---|
| `background` | ターミナルの背景。省略すると `ui.bg` と同じになる |
| `foreground` | ターミナルの文字色 |
| `cursor` | カーソルの色 |
| `cursorAccent` | カーソルの上に来た文字の色 |
| `selectionBackground` | 選択範囲の背景。不透明な色は 30% の濃さで文字の上に重なるので、背景との差が大きい明るめの色（dark なら白に近い色）にする |
| `black` `red` `green` `yellow` `blue` `magenta` `cyan` `white` | ANSI の 8 色 |
| `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue` `brightMagenta` `brightCyan` `brightWhite` | ANSI の明るい 8 色 |

設定画面の「背景の透明度」は、テーマの背景色にそのまま掛かります。

## 読み込めないとき

次のどれかに当てはまると、**ファイル全体が無効**になり、そのテーマは選択肢に出ません。
設定画面のテーマの節に、ファイル名と理由が表示されます。

- JSON として読めない（カンマの過不足、コメントを書いた など）
- `name` が無い、文字列でない、空、40 文字を超える
- `appearance` が `"dark"` / `"light"` 以外
- 色が 1 つでも読めない（例: `ui.accent: "#zz0" は色として読めません`）
- ファイルが 64 KiB を超える、UTF-8 として読めない

理由を読んで直し、「再読み込み」を押してください。

## 最小の例

`name` と強調色だけを変えたテーマです。ほかの色はすべて Tokyo Night になります。

```json
{
  "name": "Tokyo Night (Pink)",
  "ui": {
    "accent": "#ff79c6"
  }
}
```

## すべてのキーを書いた例

```json
{
  "name": "Sunset Neon",
  "appearance": "dark",
  "ui": {
    "bg": "#1b1426",
    "bgSidebar": "#160f20",
    "bgElevated": "#2a1f3a",
    "bgInset": "#110b19",
    "bgHover": "#2a1f3a",
    "bgActive": "#3a2b50",
    "fg": "#f4e9ff",
    "fgMuted": "#c3aedb",
    "fgDim": "#8a7699",
    "border": "#2e2240",
    "borderStrong": "#4b3866",
    "accent": "#ff7ab6",
    "accent2": "#ffb86b",
    "onAccent": "#1b1426",
    "danger": "#ff5c7a",
    "warning": "#ffc857",
    "success": "#7ee0a1",
    "agentBlocked": "#6fa8ff",
    "agentWorking": "#ff9b3d"
  },
  "terminal": {
    "background": "#1b1426",
    "foreground": "#f4e9ff",
    "cursor": "#ff7ab6",
    "cursorAccent": "#1b1426",
    "selectionBackground": "#f4e9ff",
    "black": "#1b1426",
    "red": "#ff5c7a",
    "green": "#7ee0a1",
    "yellow": "#ffc857",
    "blue": "#6fa8ff",
    "magenta": "#ff7ab6",
    "cyan": "#6fe3e8",
    "white": "#d9c8ee",
    "brightBlack": "#5d4a78",
    "brightRed": "#ff8098",
    "brightGreen": "#a2f0be",
    "brightYellow": "#ffdb8a",
    "brightBlue": "#9cc3ff",
    "brightMagenta": "#ffa3cc",
    "brightCyan": "#9ef0f3",
    "brightWhite": "#ffffff"
  }
}
```

## ライトテーマの注意

Claude Code の画面の一部（差分の背景など）は、ターミナルの 16 色ではなく、Claude Code が自分で決めた色（truecolor）で描かれます。
この部分はテーマのパレットに従いません。
ライトテーマを使うときは、Claude Code の中で `/theme` を実行して Claude Code 側も light に切り替えると見やすくなります。
