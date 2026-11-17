# racker のテーマ（配色と動く背景）の作り方

racker の見た目（画面の枠の色と、ターミナルの 16 色）は、JSON ファイル 1 つで変えられます。
SVG ファイルを 1 つ足すと、窓の最背面に動く背景も描けます（[動く背景](#動く背景) を参照）。
このファイルは、テーマを作る人（ユーザー）と、racker の中で動く Claude Code の両方に向けた説明です。

## Claude Code へ

このフォルダで「テーマを作って」と頼まれたら、次のとおりに作業してください。

- このフォルダの直下に、**テーマ 1 つにつき JSON ファイルを 1 つ**作る。サブフォルダには置かない。
- ファイル名は英小文字・数字・ハイフンにする（例: `sunset-neon.json`）。ファイル名がテーマの ID になる。
- 書いてよいキーは、下の「キーの一覧」にあるものだけ。色は `#rrggbb` で書く。
- 動く背景も頼まれたら、SVG ファイルを 1 つ作り、JSON の `backdrop.svg` からファイル名で参照する（例: `sunset-neon.svg`）。SVG は下の「[SVG の書き方の約束](#svg-の書き方の約束)」を必ず守る。
- `CLAUDE.md`（このファイル）は racker が上書きするので、編集しない。
- 書き終えたら、ユーザーに「racker の設定画面 → テーマの『再読み込み』→ テーマを選んで保存」で反映できると伝える。
- 文字と背景の明るさの差を十分につける。特に `fg` と `bg`、`onAccent` と `accent`、`terminal.foreground` と `terminal.background`。背景付きのテーマでは、文字と `backdrop.glass.tint` の差も十分につける。

## 置き場所

```
%APPDATA%\com.yokubo.racker\themes\
```

- 設定画面のテーマの節にある「フォルダを開く」で、このフォルダを Explorer で開けます。
- 「Claude でテーマを作る」を押すと、このフォルダを作業ディレクトリにした Claude Code のタブが開きます。
- 読むのはフォルダ直下の `*.json`（テーマ）と `*.svg`（背景）だけです。サブフォルダの中や、ほかの拡張子のファイルは読みません。
- 1 ファイルの大きさは、JSON が 64 KiB まで、SVG が 256 KiB までです。
- ファイルの数は、JSON と SVG を合わせて 100 個まで（ファイル名順で先頭から）です。
- 文字コードは UTF-8 にしてください。

## テーマの ID

ファイル名から拡張子を除いたものに `user:` を付けたものが ID です。

| ファイル名 | ID |
|---|---|
| `sunset-neon.json` | `user:sunset-neon` |

SVG ファイルはそれだけではテーマにならず、ID も付きません。JSON の `backdrop.svg` から参照されたときだけ使われます。

設定画面の選択肢には、ID ではなく JSON の `name` が出ます。
設定で選んでいたファイルを消したり名前を変えたりすると、Tokyo Night で表示されます。
お気に入りの「テーマ」で選んでいたファイルの場合は、そのタブはアプリのテーマに従います。
設定は消えないので、ファイルを戻せば元のテーマに戻ります。

## 反映のしかた

1. テーマフォルダに JSON（と、背景を付けるなら SVG）を置く（または書き換える）。
2. racker の設定画面を開き、テーマの節の「再読み込み」を押す。
3. 一覧からテーマを選び、「保存」を押す。

選択中のテーマのファイル（参照している SVG も含む）を書き換えたときも、「再読み込み」で反映されます。

お気に入りの編集画面の「テーマ」で、そのお気に入りから開くタブだけ別のテーマにできます。
そのタブを開いている（アクティブにしている）間は、画面の枠・ターミナル・背景がまとめてそのテーマになります。

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
| `backdrop` | 任意 | 動く背景（[動く背景](#動く背景) を参照） |

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
ただし、背景付きのテーマでは「背景の透明度」は使いません（背景の絵が下地になるため）。

## 動く背景

テーマの JSON に `backdrop` を書くと、窓の最背面に SVG の絵を描き、その上のパネルをすりガラスにします。
絵は SVG の中の CSS アニメーションで動きます。

### JSON の書き方

```json
{
  "name": "Neon Sunset",
  "appearance": "dark",
  "backdrop": {
    "svg": "neon-sunset.svg",
    "glass": { "blur": 14, "tint": "#1a0f2e", "opacity": 0.4 }
  },
  "ui": { "accent": "#ff4fa3" }
}
```

| キー | 必須 | 内容 |
|---|---|---|
| `backdrop.svg` | **必須** | 背景の SVG のファイル名。**JSON と同じフォルダの直下**に置く。`/` や `\` を含むパスは書けない |
| `backdrop.glass` | 任意 | パネルのすりガラスの具合。省略したキーは既定値になる |
| `backdrop.glass.blur` | 任意 | ぼかしの強さ（px）。0〜40。既定は **14** |
| `backdrop.glass.tint` | 任意 | ガラスの色。`#rrggbb`。既定は **`ui.bg` の色** |
| `backdrop.glass.opacity` | 任意 | ガラスの濃さ。0（透明）〜1（不透明）。既定は **0.4** |

- すりガラスになるのは、タイトルバー・サイドバー・タブバー・ステータスバー・ダイアログ・メニューです。`tint` の色を `opacity` の濃さで重ね、`blur` でぼかします。
- ターミナルの面は、文字が読めるように濃さに下限を設けて塗り、ぼかしは掛けません。
- 絵の明るさに合わせて `appearance` を選んでください。明るい絵なら `"light"`、暗い絵なら `"dark"` です。`tint` も絵になじむ色にします。

### SVG の書き方の約束

racker の組み込みの背景（Claude Code の公式プラグイン theme-examples のシーンを移植したもの）と同じ約束です。

- **形**: ルートの `<svg>` に `viewBox`、`width="100%" height="100%"`、`preserveAspectRatio="xMidYMid slice"` を付ける。窓の大きさが変わっても、はみ出す側を切って全面を埋めるため。`viewBox="0 0 1600 1000"` くらいの横長が描きやすい。
- **中央は静かに、動きは端と隅に**: 窓の中央にはターミナル（claude との会話）の文字が並ぶ。中央には大きく動くものや明るくちらつくものを置かず、動きは上下の端や四隅に寄せる。
- **動かし方**: SVG の `<style>` に書いた CSS アニメーション（`@keyframes`）で動かす。動かすのは `transform` と `opacity` にすると軽い。
- **`filter` は避ける**（`feGaussianBlur` など）。上にすりガラスのぼかしが重なるので、毎フレームの計算が重くなる。
- **「アニメーションを減らす」で止める**: 次の 1 行を `<style>` に必ず入れる。止まったときに見える絵（アニメーションの開始時点）も、1 枚の絵として成り立つようにする。

  ```css
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  ```

- **外部の参照とスクリプトは使えない**: 背景はスクリプトを動かさない枠（sandbox）の中に、外からの読み込みを止める設定（CSP）付きで描く。次のものは書いても効かないので、書かない。
  - `<script>`、`onload` などのイベント属性
  - `http:` / `https:` の画像・フォント・`@import`、別ファイルの参照
  - 画像やフォントを埋め込むなら `data:` の URL にする（ファイルの大きさの上限に気をつける）
- **繰り返しは `<use href="#id">` で**: 同じ形を並べるときは `<defs>` に 1 つ描いて `<use>` で使い回すと、ファイルが小さくなる。
- **乱数や時刻は使えない**（スクリプトが動かないため）。ばらつきは、位置や `animation-delay` を少しずつ変えて書く。
- ファイルは 256 KiB まで。

### racker の様子と連動させる

racker は、自作の背景の SVG に次の 2 つの値を渡します。SVG の CSS から読めるので、claude の様子に合わせて絵を変えられます。

| 値 | 受け取り方 | 内容 |
|---|---|---|
| `--rk-context` | CSS 変数。`var(--rk-context, 0)` で読む | アクティブなタブのコンテキストの使用率。0（空）〜1（上限） |
| `data-agent` | 属性。`[data-agent="working"]` のようなセレクタで読む | アクティブなタブの claude の状態。`idle`（待機中）/ `working`（作業中）/ `blocked`（応答を待っている） |

- 値は racker が SVG のルート側に付けます。セレクタは `[data-agent="working"] .flake` のように「祖先に付いている」形で書いてください（`svg[data-agent="working"]` のように要素名を付けない）。
- 値が変わっても、絵は描き直さず、アニメーションも最初からやり直しになりません。
- ステータスバーを表示していないときや、claude のタブでないときは、`--rk-context` は 0 です。
- 組み込みの背景は連動しません。

例: コンテキストが埋まるほど地面に雪が積もり、claude が作業中は雪が速く降る。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
  <style>
    .flake { animation: fall 14s linear infinite; }
    [data-agent="working"] .flake { animation-duration: 7s; }
    @keyframes fall { from { transform: translateY(-60px); } to { transform: translateY(1060px); } }
    .drift {
      transform-box: fill-box;
      transform-origin: bottom;
      transform: scaleY(calc(0.05 + var(--rk-context, 0) * 0.95));
      transition: transform 2s ease-out;
    }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  </style>
  <defs><circle id="f" r="3" fill="#ffffff" opacity="0.8"/></defs>
  <rect width="1600" height="1000" fill="#1c1d4d"/>
  <!-- 雪は左右の端に寄せる -->
  <g class="flake"><use href="#f" x="60" y="0"/><use href="#f" x="180" y="-300"/></g>
  <g class="flake" style="animation-delay: -5s"><use href="#f" x="1420" y="-120"/><use href="#f" x="1540" y="-420"/></g>
  <!-- 積もる雪。高さ 160 の帯を、使用率に合わせて下から伸ばす -->
  <rect class="drift" x="0" y="840" width="1600" height="160" fill="#e8ecff"/>
</svg>
```

### ライトの背景を使うとき

Claude Code の画面の一部は、テーマの配色に従わない色（truecolor）で描かれます（下の「[ライトテーマの注意](#ライトテーマの注意)」を参照）。
明るい背景のテーマでは、Claude Code の中で `/theme` を実行して light に切り替えてください。

### 止めたいとき

- 設定画面の「背景を動かす」を外すと、背景は止まります（もう一度入れると続きから動きます）。
- OS の「アニメーションを減らす」設定がオンのときは、SVG の中の `prefers-reduced-motion` の指定で止まります。

## 読み込めないとき

次のどれかに当てはまると、**ファイル全体が無効**になり、そのテーマは選択肢に出ません。
設定画面のテーマの節に、ファイル名と理由が表示されます。

- JSON として読めない（カンマの過不足、コメントを書いた など）
- `name` が無い、文字列でない、空、40 文字を超える
- `appearance` が `"dark"` / `"light"` 以外
- 色が 1 つでも読めない（例: `ui.accent: "#zz0" は色として読めません`）
- ファイルが 64 KiB を超える、UTF-8 として読めない
- `backdrop.svg` のファイルがフォルダに無い、読めない（256 KiB を超える など）、パス（`/` や `\`）を含む
- `backdrop.glass` の値が範囲外（`blur` が 0〜40、`opacity` が 0〜1 の外）、`tint` が色として読めない

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
