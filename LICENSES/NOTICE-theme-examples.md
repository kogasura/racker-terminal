# theme-examples（動く背景）について

racker-terminal の組み込みの動く背景（20 シーン）は、次のプラグインから移植したものです。

- 名前: theme-examples 0.4.3（Claude Code 公式プラグイン）
- 作者: Anthropic
- ライセンス: Apache License 2.0（全文は [theme-examples-Apache-2.0.txt](theme-examples-Apache-2.0.txt)）

## 移植したもの

| racker のファイル | 元のファイル |
| --- | --- |
| `src/lib/backdrop/scenes/*.ts` | `hooks/scenes/*.ts`（14 ファイル、20 シーン） |
| `src/lib/backdrop/catalog.ts` | `hooks/themes.ts`（シーンの一覧） |

## racker 用に変更した点

- TypeScript の形を racker に合わせた。
  - ファイル名を racker の命名（camelCase）に変えた。
  - 一覧の型を racker の形にし、シーンを作る関数は一覧から外して ID から引くようにした。
  - lint に掛かる関数名を 1 つ変えた（`paper-garden` の `useMarkup` → `cloneMarkup`）。
  - 各ファイルの先頭に、出典と変更した旨のコメントを足した。
- シーンの説明文（blurb）を日本語に訳した。
- racker の配色に使う色（accent / accent2）を、シーンごとに足した。
- 花火の演出（`hooks/fireworks.ts`）と、コマンドやプラグインの登録の部分（`hooks/register.tsx` ほか）は含めていない。

シーンが描く SVG（絵・動き・`prefers-reduced-motion` の指定）は、元のプラグインと同じです。
