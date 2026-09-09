import type { Tab } from '../types';
import { cwdMatches, isSessionId, type TabForMatch } from './claudeSessions';

/**
 * タブを spawn するときに claude をどう起動するかの判断。
 *
 * 起動側 (TerminalPane.computeClaudeLaunch) から判断だけを切り出した純関数。
 * 分けている理由は 2 つある:
 *
 * 1. **新規 UUID の誤発番を構造的に禁じるため。** 手動起動タブの復元は
 *    「既に持っている ID で `--resume` する」だけであって、新しい会話を
 *    始めてよいわけではない。判断を `kind` に閉じ込めることで、
 *    resume の経路から crypto.randomUUID() へ到達できなくなる
 *    （発番は `new` を受け取ったときにしか書かれていない）。
 * 2. **テストできるようにするため。** computeClaudeLaunch は store と
 *    crypto を触るので単体テストが重い。判定表そのものはここで固定する。
 */
export type ClaudeLaunchPlan =
  /** 何も起動しない（素のシェルで開く）。 */
  | { kind: 'none' }
  /** 新しい会話を始める。UUID の発番と保存は呼び出し側の責務。 */
  | { kind: 'new' }
  /** 既存の会話を再開する。**ここから新規発番は絶対に起きない**。 */
  | { kind: 'resume'; sessionId: string; bypass: boolean };

/**
 * planClaudeLaunch が見るタブ情報だけを抜き出した型。
 * Tab 全体に依存させないことで、テストから最小限の入力で呼べるようにしている。
 */
export type ClaudeLaunchTab = Pick<
  Tab,
  | 'launchClaude'
  | 'claudeSessionId'
  | 'claudeSessionCwd'
  | 'claudeSessionDistro'
  | 'claudeSessionLive'
  | 'claudeSeenAt'
  | 'bypassPermissions'
  | 'shell'
  | 'cwd'
  | 'args'
>;

/**
 * 手動起動タブの記録を信用してよい上限の経過時間（7 日）。
 *
 * `claudeSeenAt` は racker が最後に「そのセッションが生きている」と観測した時刻。
 * racker がクラッシュすると claudeSessionLive=true のまま残るため、
 * 何ヶ月も後に立ち上げたときに古い会話が一斉に開く事故が起こりうる。
 * セッション側の鮮度 (claudeSessions.SESSION_STALE_MS = 3 日) より緩いのは、
 * こちらは「racker を数日開かなかった」だけで消えてほしくない記録だから。
 */
export const MANUAL_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * cwd 整合チェック用に TabForMatch へ詰め替える。
 *
 * `id` はダミーで構わない。cwdMatches は cwd / args / shell しか見ておらず、
 * id は matchSessionsToTabs が結果マップのキーに使うためだけのフィールドだから。
 * planClaudeLaunch に id を要求させると「使わない値を渡させる」ことになるので、
 * 型の都合はここで吸収する。
 */
function tabForCwdCheck(tab: ClaudeLaunchTab): TabForMatch {
  return { id: '', cwd: tab.cwd, args: tab.args, shell: tab.shell };
}

/**
 * 手動起動タブ（launchClaude が true でないタブ）を復元してよいか。
 *
 * 3 つのゲートをすべて通ったときだけ true:
 *
 * 1. **live** — 前回 racker を閉じた時点で claude が動いていたか。
 *    自分で `/exit` していたら次の巡回で false に落ちるので、
 *    「終わらせたタブが勝手に復活する」ことがない。
 * 2. **鮮度** — 記録そのものが古すぎないか（MANUAL_RESUME_MAX_AGE_MS 参照）。
 *    未設定も「いつの観測か分からない」として落とす（安全側）。
 * 3. **階層の一致** — 記録した「claude が動いていた階層」と、
 *    これから spawn する階層が一致するか。**`claude --resume <id>` は cwd が
 *    違っても失敗せず、前回の会話を新しいディレクトリに対して継続する**
 *    （実機で確認済み）ため、これが唯一の防御になる。claude を抜けたあとに
 *    `cd` して別リポジトリへ移動したタブで、前の会話が勝手に再開すると
 *    その続きで指示したファイル操作が別リポジトリに対して走ってしまう。
 *
 * 3 の判定は claudeSessions.cwdMatches を **import して共有する**。
 * 照合（matchSessionsToTabs）・採用（adoptableTabIds）・ここ、の 3 箇所が
 * 同じ述語を使うので、「照合では一致とみなしたのに復元時には不一致」という
 * 食い違いが原理的に起きない。
 */
function isManualResumable(
  tab: ClaudeLaunchTab,
  opts: { now: number; maxAgeMs?: number },
): boolean {
  if (tab.claudeSessionLive !== true) return false;

  const seenAt = tab.claudeSeenAt;
  const maxAgeMs = opts.maxAgeMs ?? MANUAL_RESUME_MAX_AGE_MS;
  if (seenAt === undefined || opts.now - seenAt > maxAgeMs) return false;

  return cwdMatches(tabForCwdCheck(tab), {
    cwd: tab.claudeSessionCwd,
    distro: tab.claudeSessionDistro,
  });
}

/**
 * タブの claude 起動方法を決める。
 *
 * | launchClaude | 条件 | 結果 |
 * |---|---|---|
 * | true | claudeSessionId あり | resume（bypass = tab.bypassPermissions）— 従来どおり |
 * | true | ID なし | new — 従来どおり |
 * | それ以外 | ID なし | none |
 * | それ以外 | claudeSessionLive !== true | none（自分で /exit した） |
 * | それ以外 | claudeSeenAt が maxAgeMs 超 / 未設定 | none |
 * | それ以外 | 記録した階層と食い違う | none |
 * | それ以外 | 上記をすべて通過 | resume（bypass = false） |
 *
 * 手動タブの resume に bypass を付けないのは、ユーザーが
 * `claude --dangerously-skip-permissions` と打っていたかどうかが
 * セッションファイルに一切残らないため。**推測で権限を緩めない**方針を優先した
 * （安全側だが、常用していた人には挙動差になる。README に明記している）。
 *
 * 時刻は引数で受け取る（内部で Date.now() を呼ばない）。
 */
export function planClaudeLaunch(
  tab: ClaudeLaunchTab,
  opts: { now: number; maxAgeMs?: number },
): ClaudeLaunchPlan {
  // launchClaude=true の Claude タブは従来どおり。手動タブ向けのゲート
  // (live / 鮮度 / 階層一致) は一切適用しない。ID は racker 自身が発番したもので
  // 取り違えようがなく、ユーザーは「このタブは claude で開く」と明示しているため。
  // ID の形は **resume を組み立てる直前にもう一度**確かめる（claudeSessions の
  // 入口でも捨てているが、ここは「シェルへ渡す最後の関門」なので二重に守る）。
  // 永続化済みの古い値や、将来 ID の入手経路が増えたときに素通しさせないため。
  if (tab.launchClaude === true) {
    return isSessionId(tab.claudeSessionId)
      ? { kind: 'resume', sessionId: tab.claudeSessionId, bypass: tab.bypassPermissions === true }
      : { kind: 'new' };   // Claude タブは「必ず claude が立つ」ので発番し直す
  }

  // ここから下は手動起動タブ。ID が無ければそもそも再開する会話が無いので、
  // **`new` には決して倒さない**（自動起動 OFF のタブで勝手に claude が立ち上がる）。
  const sessionId = tab.claudeSessionId;
  if (!isSessionId(sessionId)) return { kind: 'none' };
  if (!isManualResumable(tab, opts)) return { kind: 'none' };
  return { kind: 'resume', sessionId, bypass: false };
}
