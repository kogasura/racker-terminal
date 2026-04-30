# Embedded Fonts

racker-terminal にバンドルされる MonaspiceNe NF (Mono) フォント。

## ファイル
- `MonaspiceNe-NF-Regular.woff2` — weight 400
- `MonaspiceNe-NF-Bold.woff2` — weight 700

## ライセンス
SIL OFL 1.1。詳細は `LICENSES/Monaspace-OFL.txt` および `LICENSES/NerdFonts-OFL.txt` 参照。
本プロジェクトでの再配布は OFL 1.1 の規定どおり ライセンス文を同梱。

## 起源
- Monaspace 本体: GitHub Inc. (https://github.com/githubnext/monaspace)
- Nerd Fonts 化: Ryan L McIntyre 他 (https://github.com/ryanoasis/nerd-fonts)

## 更新手順
1. https://github.com/ryanoasis/nerd-fonts/releases/latest から Monaspace.zip を取得
2. ZIP を展開し `MonaspiceNeNerdFontMono-Regular.otf` / `MonaspiceNeNerdFontMono-Bold.otf` (Mono バリアント) を抽出
3. fonttools + brotli で woff2 に変換:
   ```
   python -c "
   from fontTools.ttLib import TTFont
   for w, src in [('Regular', 'MonaspiceNeNerdFontMono-Regular.otf'), ('Bold', 'MonaspiceNeNerdFontMono-Bold.otf')]:
       f = TTFont(src); f.flavor = 'woff2'
       f.save(f'MonaspiceNe-NF-{w}.woff2')
   "
   ```
4. ファイルを `src/assets/fonts/` に配置
5. ライセンスファイル更新の必要性を確認
