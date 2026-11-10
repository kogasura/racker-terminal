---
name: racker-ship
description: racker-terminal の修正を main にマージし終えたあと、版上げ・リリースノート作成・署名ビルド・GitHub Release 公開を行い、手元で動いている racker-terminal に新しい版を取りに行かせるまでを代行する。ユーザーから見える変更（新機能・不具合修正）をマージしたら、確認を取らずにこのスキルで反映まで進める。「反映して」「最新化して」「リリースして」と言われたときも使う。
---

# racker-ship — マージ済みの修正を手元の racker-terminal まで届ける

ユーザーは racker-terminal の中で Claude Code を動かしている。修正をマージしたあと、
リリースして手元のアプリに入れるまでの手作業を、このスキルで丸ごと代行する。

**ユーザーの方針（2026-11-10 に決定）**
- マージ後のリリースは**確認を取らずに**進めてよい。
- **再起動はしない。** 動いているタブ（ほかの claude も含む）が止まるため、
  最後は「バッジを押して再起動してください」と伝えて終える。

## 0. リリースするかを決める

```bash
git fetch -q origin --tags
LAST=$(git describe --tags --abbrev=0 origin/main)   # 例: v1.9.13
git log --oneline "$LAST"..origin/main
```

- 差分が無い → 「リリースするものがありません」と伝えて終了。
- 差分が**リファクタ・テスト・ドキュメント・CI だけ**（ユーザーから見える変化が無い）→
  リリースせず、そう伝えて終了。見える変更が入ったときにまとめて出す。
- それ以外 → 続ける。版は原則 `patch`。ユーザーが minor / major を指示したときだけ変える。

途中のブランチや未コミットの変更がある場合は先に片付ける（`git status` で確認）。
作業は `.env.release` があるリポジトリ本体（worktree ではない方）で行う。

## 1. 版上げ PR を作ってマージする

```bash
git switch main && git pull -q --ff-only
NEXT=$(npm run -s bump -- patch | tail -1)          # 5 ファイル 6 か所を一括更新
git switch -c "chore/release-v$NEXT"
```

`docs/changelog/$NEXT.md` を書く。対象は `$LAST` 以降にマージされた PR
（`gh pr view <番号>` で本文を読む）。**書き方は直近のノート（`docs/changelog/` の
新しいもの数本）に合わせる**:

- 先頭は `## v<版>`、次の行に太字で「この更新で何が良くなるか」を 1〜2 文。
- 節は必要なものだけ: `### 新機能` / `### 修正` / `### 補足` / `### 既知の問題`。
- 各項目は `- **見出し**: 説明`。**ユーザーから見た変化**を書く（内部の関数名や設計の話は書かない）。
  修正なら「何が起きていたか → これからどうなるか」。
- リファクタだけの PR は書かない。
- **UTF-8（BOM なし）・LF・4KB 以内**（更新ダイアログに生のまま表示されるため）。

コミットメッセージは過去に合わせる:

```
chore: v<版> にバージョン bump（<一番大きい変更を一言>）

#<PR 番号> の修正をリリースするためのバージョン更新。
...
```

push → `gh pr create` → `gh pr checks <番号> --watch` で CI を待つ →
`gh pr merge <番号> --squash --delete-branch` → `git switch main && git pull --ff-only`。

## 2. 署名ビルドして GitHub Release を公開する

```bash
npm run release
```

- 署名ビルド → `dist-installer/latest.json` 生成 → `gh release create` まで一括で行う。
- ビルドに数分〜10 分以上かかる。Bash の `run_in_background` で走らせ、完了通知を待つ。
- 失敗したら**やり直す前に原因を見る**。タグや Release が中途半端に作られていないか
  `gh release view v<版>` で確認し、状況をユーザーに伝える。

公開できたら、Release に `latest.json` とインストーラが載っていることを確認する:

```bash
gh release view "v$NEXT" --json assets -q '.assets[].name'
```

## 3. 手元の racker-terminal に新しい版を取りに行かせる

動いている racker-terminal に `--check-update` を付けて 2 回目の起動をすると、
single-instance が起動済みのウィンドウに合図を渡し、すぐに更新の確認と DL が始まる
（ウィンドウは前面に出ない）。

```powershell
$exe = (Get-Process racker-terminal -ErrorAction SilentlyContinue | Select-Object -First 1).Path
if (-not $exe) { $exe = "$env:LOCALAPPDATA\Racker Terminal\racker-terminal.exe" }
Start-Process -FilePath $exe -ArgumentList '--check-update'
```

- 手元の版が v1.9.14 より古いと、この合図は無視される（受け口が無い）。その場合は
  1 時間ごとの定期確認か、設定画面の「更新を確認」で拾われる、と伝える。

## 4. 報告して終える

- 公開した版と、入った変更（リリースノートの要点）を短く伝える。
- 「少し待つとタイトルバーに **↑ バッジ** が出るので、区切りのいいところで押して
  再起動してください」と伝える。**自分では再起動しない。**
