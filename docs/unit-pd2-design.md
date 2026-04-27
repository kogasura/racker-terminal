# 設計書: Unit P-D2 — 異常終了の網羅検証

---

## 1. 概要・スコープ

### やること

- **`spawn_child_watcher` の網羅性分析**: 異常終了の全シナリオが既存の `child.try_wait()` ポーリングで検出されることを確認する
- **検証シナリオ VS01〜VS05 の定義**: 実機検証の手順・期待結果を明文化する
- **ドキュメント整備**: `spawn_child_watcher` 関数にカバレッジコメントを追加し、分析結果をコードに残す

### やらないこと（スコープ外）

- ポーリング間隔の変更（100ms は §2.2 で網羅性分析の結果として妥当と判断、変更不要）
- exit code 伝達の変更（現状の `exit_code() as i32` で正しい）
- ssh 切断時の追加ハンドリング（P-D1 のタイムアウト機構でカバー済み）
- コード変更（ドキュメント整備 + コメント追加のみ）

---

## 2. 既存実装の網羅性分析

### 2.1 `spawn_child_watcher` の設計

`src-tauri/src/pty.rs` の `spawn_child_watcher` は以下の方式で子プロセスの終了を検出する:

- 100ms 周期で `child.try_wait()` をポーリング
- `Ok(Some(ExitStatus))` が返ったとき: exit_code を `flush_state` に格納 → `stop_flag` セット → `cvar` で flush スレッド起床 → `master` を drop して reader の blocking read を EOF で解放

### 2.2 シナリオ別カバレッジ

| シナリオ | 終了パス | `try_wait()` 返値 | 検出可否 |
|---|---|---|---|
| VS01: `Ctrl-D` (EOF) | nushell が EOF を受信 → 自ら exit(0) | `Ok(Some(code=0))` | ○ |
| VS02: `[Environment]::Exit(0)` | PowerShell が通常 exit | `Ok(Some(code=0))` | ○ |
| VS03: `taskkill /F /PID` | OS が SIGKILL 相当で強制終了 | `Ok(Some(code=1 等))` | ○ |
| VS04: ssh 切断 | ssh が SIGHUP/終了 → child プロセスが exit | `Ok(Some(code))` | ○ |
| VS05: タスクマネージャ強制終了 | OS が SIGKILL 相当で強制終了 | `Ok(Some(code=1 等))` | ○ |

**結論**: VS01〜VS05 のすべてが `try_wait()` によって検出される。コード変更は不要。

### 2.3 各シナリオの詳細分析

#### VS01: Ctrl-D (EOF 入力)

- nushell は stdin の EOF を受信すると自ら `exit` を呼ぶ
- child プロセスが exit → OS がプロセス状態を `WAIT_OBJECT_0` にセット
- 次回の `try_wait()` ポーリングで `Ok(Some(code=0))` が返る
- 検出レイテンシ: 最大 100ms（ポーリング間隔）

#### VS02: `[Environment]::Exit(0)`

- PowerShell が正常 exit code 0 で終了
- Windows の `ExitProcess(0)` が呼ばれる → プロセス状態変化
- `try_wait()` → `Ok(Some(code=0))`
- 検出レイテンシ: 最大 100ms

#### VS03: `taskkill /F /PID <子プロセスPID>`

- Windows の `TerminateProcess()` が発行される（UNIX の SIGKILL 相当）
- exit code は `taskkill` 実装依存で通常 `1` または `0x00000001`
- `try_wait()` → `Ok(Some(code=1))`
- **注意**: `/F` なしの `taskkill` は WM_CLOSE を送るが、コンソールアプリの場合は `CTRL_CLOSE_EVENT` 経由で終了。いずれも `try_wait()` で検出される

#### VS04: ssh セッション中のネットワーク切断

- ssh client は接続断を検出すると SIGHUP を受けて終了（またはタイムアウト後に終了）
- ssh プロセスが exit → `try_wait()` で検出
- **ssh がハングした場合**: P-D1 の spawning タイムアウト（10 秒）がカバー。status が `spawning` のまま 10 秒経過すると `crashed` 扱いになる
- **検証難易度**: ネットワーク切断の再現にはローカル ssh サーバーが必要。§3 で「対応想定範囲」として記述のみとする

#### VS05: タスクマネージャからの強制終了

- VS03 と同様に `TerminateProcess()` が発行される
- 動作は VS03 と同等

### 2.4 ポーリング間隔 (100ms) の妥当性

- **検出レイテンシ**: 最大 100ms。ユーザー体験上は即時に見える（シェル終了後 UI が crashed になるまで 0〜100ms）
- **CPU コスト**: アイドル時の `try_wait()` は非常に軽量（`WaitForSingleObject` を 0ms タイムアウトで呼ぶだけ）。100ms 間隔でのポーリングは問題ない
- **50ms への短縮の必要性**: なし。検出レイテンシはすでに体感できないレベルであり、CPU コスト増加に見合わない
- **Phase 3 の Settings 化**: §2.9 back-pressure の Settings 化と合わせて、将来必要になった場合に対応する

---

## 3. 検証シナリオ VS01〜VS05 の詳細手順

### VS01: nushell で `Ctrl-D` (EOF) 入力

**前提条件**:
- Racker Terminal を起動し、nushell タブが `live` 状態であること
- Dev Tools（またはログ）で PTY イベントが確認できること

**手順**:
1. nushell タブをアクティブにする
2. `Ctrl-D` を入力する（nushell に EOF を送信）
3. タブ状態の変化を観察する

**期待結果**:
- `Ctrl-D` 入力後 100ms 以内にタブ状態が `crashed` に変わる
- `[Exited (code: 0)]` がターミナル末尾に表示される
- child watcher ログ（debug ビルド）: `[pty-watch] child exited with code 0`

**合否基準**: タブ状態が 100ms 以内に `crashed` になること

---

### VS02: PowerShell で `[Environment]::Exit(0)`

**前提条件**:
- Racker Terminal を起動し、PowerShell タブが `live` 状態であること

**手順**:
1. PowerShell タブをアクティブにする（タブ追加時に shell として `pwsh` を指定）
2. `[Environment]::Exit(0)` を入力して Enter を押す
3. タブ状態の変化を観察する

**期待結果**:
- Exit 後 100ms 以内にタブ状態が `crashed` に変わる
- `[Exited (code: 0)]` が表示される

**合否基準**: タブ状態が 100ms 以内に `crashed` になること

---

### VS03: 別ターミナルから `taskkill /F /PID <子プロセス>`

**前提条件**:
- Racker Terminal を起動し、nushell タブが `live` 状態であること
- 別のターミナルウィンドウ（または PowerShell）が開けること

**手順**:
1. nushell タブをアクティブにする
2. nushell 内で `$nu.pid` を実行して子プロセス PID を確認する（または タスクマネージャで確認）
3. 別のターミナルで `taskkill /F /PID <PID>` を実行する
4. Racker Terminal のタブ状態を観察する

**期待結果**:
- `taskkill` 実行後 100ms 以内にタブ状態が `crashed` に変わる
- `[Exited (code: 1)]` またはプラットフォーム依存の exit code が表示される

**合否基準**: タブ状態が 100ms 以内に `crashed` になること

---

### VS04: ssh セッション中のネットワーク切断

**対応想定範囲の記述（実機検証オプション）**:

ssh 切断のシナリオは以下の理由により、実機検証の優先度を低とする:

- ネットワーク切断の再現にはローカル ssh サーバー（OpenSSH Server for Windows 等）のセットアップが必要
- ssh client プロセスが exit すれば `try_wait()` で検出される（VS03 と同じパス）
- ssh がハングした場合は P-D1 の 10 秒タイムアウト機構がカバー

**実施する場合の手順** (環境準備可能な場合):
1. Windows の OpenSSH Server を有効化し、`ssh localhost` で接続した nushell タブを `live` にする
2. Windows Firewall で SSH ポート (22) を一時的にブロックし、接続断を模擬する
3. または ssh サーバー側で `pkill sshd` により接続を強制切断する
4. タブ状態が `crashed` になることを確認する

**期待結果**:
- ssh client 終了後 100ms 以内にタブ状態が `crashed` になる

---

### VS05: タスクマネージャからの子プロセス強制終了

**前提条件**:
- Racker Terminal を起動し、nushell タブが `live` 状態であること

**手順**:
1. nushell タブをアクティブにする
2. nushell 内で `$nu.pid` を実行して子プロセス PID を確認する
3. タスクマネージャ → 詳細タブ を開く
4. PID が一致するプロセス（nu.exe）を右クリック → 「タスクの終了」を選択する
5. Racker Terminal のタブ状態を観察する

**期待結果**:
- 強制終了後 100ms 以内にタブ状態が `crashed` に変わる
- `[Exited (code: 1)]` またはプラットフォーム依存の exit code が表示される

**合否基準**: タブ状態が 100ms 以内に `crashed` になること

---

## 4. 検証結果 (TBD — 実機検証後に追記)

| シナリオ | 実施日 | 合否 | 備考 |
|---|---|---|---|
| VS01: Ctrl-D | TBD | - | |
| VS02: Exit(0) | TBD | - | |
| VS03: taskkill /F | TBD | - | |
| VS04: ssh 切断 | TBD | オプション | 環境準備が必要 |
| VS05: タスクマネージャ | TBD | - | |

---

## 5. 後続フェーズ送り項目

| 項目 | 理由 | 推奨フェーズ |
|---|---|---|
| ポーリング間隔の Settings 化 | 現状 100ms で十分。EDR 環境で誤挙動が報告された場合に対応 | Phase 3 §2.9 と同時 |
| ssh ハング時の明示的タイムアウト | P-D1 の 10 秒タイムアウトで対応済みだが、ssh 固有のタイムアウト設定（`ServerAliveInterval` 等）のドキュメント化 | ユーザードキュメント整備時 |
| exit code の表示フォーマット改善 | Windows の `NTSTATUS` コード（`0xc000013a` 等）をユーザーフレンドリーな文字列で表示 | Phase 3 設定 UI と合わせて |
