/**
 * ターミナルの起動シーケンス。
 *
 * 「このタブをどう起動するか」の決定をここに集めてある。Claude を新規で始めるのか
 * 再開するのか、WSL なら直接 exec か、シェルへタイプ送信か — どれも判断であって、
 * ターミナル面の世話 (xterm を触ること) とは別の関心。
 *
 * TerminalPane は xterm.js の命令的な API を抱える例外コンポーネントだが、
 * 例外として認めているのは**その命令的リソースの世話だけ**で、判断は含まない
 * (architecture/README.md の「例外」節を参照)。
 */

import { isWslShell } from '../../lib/profileTemplates';
import { planClaudeLaunch } from '../../lib/claudeLaunch';
import { useAppStore } from '../../store/appStore';
import type { Tab } from '../../types';

/** cwd の末尾フォルダ名を返す（Windows `\` / POSIX `/` 両対応）。取れなければ null。 */
export function cwdBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0 && p !== '~');
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * claude セッション名をシェルへ安全に渡せる単一トークンに整える。
 * 空白は '-' に置換し、制御文字とシェルメタ文字は除去（unicode 文字＝日本語等は許可）。
 * 60 文字に切り詰め、結果が空なら null を返す。
 * → メタ文字を除去するため引用符なしで `-n <token>` に渡しても injection しない。
 */
export function sanitizeSessionName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '') // 許可リスト: unicode文字/数字/._- のみ残す。引用符/$/バッククォート等は除去し injection 防止
    .replace(/-{2,}/g, '-')          // 連続ハイフンを 1 つに圧縮
    .replace(/^[-.]+|[-.]+$/g, '')   // 先頭・末尾のハイフン/ドットを除去
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * claude 起動コマンド文字列を組み立てる純関数。
 * - resume 指定 → `claude --resume <id>`
 * - 新規指定   → `claude --session-id <id> -n <name>`
 * - bypass=true → 末尾に `--dangerously-skip-permissions` を付与（権限バイパス）。
 * 引数 (uuid / sanitizeSessionName 済み name) は injection 安全な前提。テスト用に export する。
 *
 * ⚠️ resume の ID は**セッションファイル由来のこともある**（手動起動タブ）。
 * ここで引用符なしに埋め込んでよいのは、claudeSessions.isSessionId が UUID の形を
 * 確かめて外れ値を捨てているから。ID の入手経路を増やすときは同じ関門を通すこと。
 */
export function buildClaudeCommand(
  mode: { resume: string } | { sessionId: string; name: string },
  opts?: { bypass?: boolean },
): string {
  const skip = opts?.bypass ? ' --dangerously-skip-permissions' : '';
  return 'resume' in mode
    ? `claude --resume ${mode.resume}${skip}`
    : `claude --session-id ${mode.sessionId} -n ${mode.name}${skip}`;
}

/**
 * WSL タブの Claude 自動起動を「直接 exec 方式」で行うための spawn 引数を構築する純関数。
 *
 * 背景: spawn 直後にシェルへ `claude ...\r` をタイプ送信する方式は、wsl.exe → distro → ログイン
 * シェル (reedline 等) の多段起動の「入力受付準備前」に届きやすく、特に cold 起動で取りこぼされる。
 * そこで WSL では claude をタイプせず wsl の起動コマンドとして直接実行する
 * (`-- bash -ic "<claudeCmd>; exec \"$SHELL\""`)。claude 終了後は exec でログインシェル ($SHELL)
 * に落ちてタブが生存し続ける（手動運用で実績のある方式と同型）。
 *
 * - claudeCmd は injection 安全な形に組み立て済み（uuid + sanitizeSessionName 済みトークン）なので
 *   引用符なしで埋め込んでよい。
 * - baseArgs に既に `--`（コマンド区切り）が含まれる場合は、ユーザーが明示的に起動コマンドを
 *   指定しているとみなして注入せず baseArgs をそのまま返す。
 * - `exec "$SHELL"` により、claude 終了後・resume 失敗時のいずれもログインシェルに落ちるため、
 *   タイプ方式のような「`--resume <不正id>` で crashed のまま復帰不能」になる事故も避けられる。
 */
export function buildWslClaudeArgs(
  baseArgs: string[] | undefined,
  claudeCmd: string,
): string[] {
  const args = baseArgs ?? [];
  if (args.includes('--')) return args; // 明示コマンド指定済み: 触らない
  return [...args, '--', 'bash', '-ic', `${claudeCmd}; exec "$SHELL"`];
}

/**
 * 新しい claude セッションを発番して store に保存し、起動コマンドの材料を返す。
 *
 * **`resume` の経路からは絶対に呼ばない**（呼び出し元が plan.kind === 'new' のときだけ
 * 通す）。手動起動タブの復元は「既に持っている ID を再開する」ことであって、
 * 新しい会話を勝手に始めてよいわけではないため。この分離により、StrictMode の
 * effect 二重実行に対する既存の安全性も resume 側では副作用ゼロで自動的に保たれる。
 *
 * セッション名は タブ名 → cwd フォルダ名 → 'claude' の順（A 方式: 初回固定。以後のタブ
 * rename はアプリ表示のみで claude 側名称とは独立。resume は UUID で行うため影響なし）。
 */
function issueNewClaudeSession(tabId: string, tab: Tab): { sessionId: string; name: string } {
  const sessionId = crypto.randomUUID();
  useAppStore.getState().setClaudeSessionId(tabId, sessionId);
  const name =
    sanitizeSessionName(tab.userTitle) ??
    sanitizeSessionName(cwdBasename(tab.cwd)) ??
    'claude';
  return { sessionId, name };
}

/**
 * タブの Claude 起動方法を算出する。
 *
 * 戻り値:
 *  - args: spawn に渡す最終的な引数。WSL の Claude タブは「直接 exec 方式」を注入した args、
 *    それ以外は baseArgs をそのまま返す。
 *  - bootstrap: spawn 後にシェルへタイプ送信するコマンド。Windows ネイティブ等の Claude タブのみ
 *    返す（起動が即時で確実に届くため）。WSL の Claude タブ・起動しないタブは undefined。
 *
 * **何を起動するかの判断は持たない**。判定は claudeLaunch.planClaudeLaunch に切り出してあり、
 * ここは「決まった起動コマンドを WSL 方式 / タイプ送信方式のどちらで届けるか」だけを担う。
 * 分けている理由は claudeLaunch.ts の冒頭コメント参照（新規 UUID の誤発番を構造的に防ぐ）。
 *
 * StrictMode の effect 二重実行でも claudeSessionId が割れないよう、引数の closure ではなく
 * store の最新値 (getState) を読む。1 回目の発番＋保存を 2 回目が観測して再発番しないため、
 * 「起動した id」と「永続化した id」が必ず一致する。
 *
 * launchClaude=true のタブに加えて、**自動起動 OFF でも前回終了時に claude が動いていた
 * タブ**（手動で `claude` と打っていたケース）はここで `--resume` に倒れる。
 */
export function computeClaudeLaunch(
  tabId: string,
  baseArgs: string[] | undefined,
): { args: string[] | undefined; bootstrap: string | undefined } {
  const noLaunch = { args: baseArgs, bootstrap: undefined };
  const tab = useAppStore.getState().tabs[tabId];
  if (tab === undefined) return noLaunch;

  const plan = planClaudeLaunch(tab, { now: Date.now() });
  if (plan.kind === 'none') return noLaunch;

  // bypass の有無は plan が決める（launchClaude タブは tab.bypassPermissions を引き継ぎ、
  // 手動タブの復元では常に false。claudeLaunch.planClaudeLaunch の判定表を参照）。
  const claudeCmd =
    plan.kind === 'resume'
      ? buildClaudeCommand({ resume: plan.sessionId }, { bypass: plan.bypass })
      : buildClaudeCommand(issueNewClaudeSession(tabId, tab), { bypass: tab.bypassPermissions });

  // WSL は「直接 exec 方式」(タイプ送信しない)。それ以外 (Windows ネイティブ nu/pwsh 等) は
  // 従来通りシェルへタイプ送信する (起動が即時で確実に届くため)。
  if (isWslShell(tab.shell)) {
    const wslArgs = buildWslClaudeArgs(baseArgs, claudeCmd);
    // baseArgs に既に `--`(明示コマンド) があり直接 exec を注入できなかった場合は wslArgs===baseArgs。
    // その際は従来どおりシェルへのタイプ送信にフォールバックして
    // 「launchClaude を付けたのに何も起動しない」デグレを防ぐ。
    if (wslArgs === baseArgs) return { args: baseArgs, bootstrap: claudeCmd };
    return { args: wslArgs, bootstrap: undefined };
  }
  return { args: baseArgs, bootstrap: claudeCmd };
}

/**
 * spawn がタイムアウトしたか (= まだ `spawning` のままか) を判定する。
 *
 * タイマーが切れた時点で状態が動いていれば何もしない。判定を外に出しているのは、
 * 「まだ立ち上がっていないと決めるのは誰か」を TerminalPane から外すため。
 */
export function isStillSpawning(tabId: string): boolean {
  return useAppStore.getState().tabs[tabId]?.status === 'spawning';
}
