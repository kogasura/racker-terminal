/**
 * Claude Code のセッションファイルを定期的に読み、タブと突き合わせる Root。
 *
 * これにより (1) ユーザーが自分で `claude` と打ったタブのセッション ID を特定して
 * 再起動後の resume 対象にでき、(2) タブの状態を画面パターンの推測ではなく
 * Claude 自身が申告した status から決められる。
 *
 * ファイル読み取りが失敗する環境 (Claude 未使用・形式変更) では null が返り、
 * 何も反映せずに従来どおり画面パターン判定へフォールバックする。
 * 「取得できて 0 件」(= claude が 1 つも動いていない) とは区別する必要がある。
 * 後者は「ユーザーが自分で /exit した」という観測であり、反映しないと
 * 再起動時に終了済みのセッションを復元してしまう。
 *
 * ついでにアクティブタブの会話ログも読む (セッション ID と cwd がここで揃うため)。
 * 読めた結果はステータスバーへイベントで流す。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useEmit } from '../../architecture/chain';
import {
  listClaudeSessions,
  matchSessionsToTabs,
  freshSessions,
  adoptableTabIds,
  coveredTabIds,
  collectWslDistros,
  shouldPollWsl,
  relaunchedSessionCandidates,
  relaunchedSessionTabs,
  claudeTranscriptExists,
  type ClaudeSession,
  type RelaunchTab,
} from '../../lib/claudeSessions';
import { getTranscriptMeta, shouldPollTranscript, type ClaudeTranscriptMeta } from '../../lib/claudeMeta';
import { useAppStore } from '../../store/appStore';
import type { ClaudeStatusEvent } from '../claudeStatus/events';

const POLL_INTERVAL_MS = 2000;

/**
 * アクティブタブで動いている Claude の会話ログを読み、モデル / effort /
 * コンテキスト量を返す。ステータスバーへ渡すのは呼び出し側。
 *
 * アクティブタブぶんしか読まない。会話ログは 50MB を超えることがあり、
 * 全タブぶんを数秒ごとに読むのは割に合わない（見えていないタブの
 * モデル名を知っても使い道がない）。
 *
 * セッションが紐づかないタブ（claude を起動していない・終了した）では
 * null を渡して表示を消す。
 *
 * テストのため export している。
 */
export async function readActiveTranscript(
  session: ClaudeSession | undefined,
): Promise<ClaudeTranscriptMeta | null> {
  // セッションが紐づかない (claude を起動していない・終了した) なら表示を消す
  if (session?.sessionId === undefined) return null;
  return getTranscriptMeta(session.sessionId, session.cwd, session.distro);
}

/**
 * この巡回でアクティブタブの会話ログを読み直してよいか。
 *
 * readActiveTranscript は「セッションが紐づかない = null (表示を消す)」を返すため、
 * **見に行っていない範囲のタブに対して呼ぶと、見えている情報を消してしまう**。
 * WSL を間引いた tick では WSL タブのセッションが一覧に出ないので、
 * ステータスバーの表示が数秒ごとに点滅することになる。
 *
 * タブが 1 枚も無いとき (null) は「消す」処理そのものが要るので通す。
 */
function canReadTranscript(
  activeTabId: string | null,
  covered: ReadonlySet<string>,
  matches: ReadonlyMap<string, unknown>,
): boolean {
  if (activeTabId === null) return true;
  return covered.has(activeTabId) || matches.has(activeTabId);
}

/**
 * 記録した ID を捨てて、いま動いている会話へ乗り換えてよい Claude タブを求める。
 *
 * 候補の絞り込みは純関数 (relaunchedSessionCandidates) に任せ、ここでは
 * 「記録した ID の会話ログが本当に無いか」だけをファイルで確かめる。
 * 候補が無い tick (ほぼすべて) では何も問い合わせない。
 *
 * `knownTranscripts` は「ログがあった」と分かった ID の控え。アプリの起動中に会話ログが
 * 消えることはまず無いので、一度見つかった ID を毎 tick 問い合わせ直さずに済む
 * （WSL では 9P 越しになる）。
 *
 * テストのため export している。
 */
export async function resolveRelaunchedTabs(
  tabs: RelaunchTab[],
  matches: ReadonlyMap<string, ClaudeSession>,
  adoptable: ReadonlySet<string>,
  knownTranscripts: Set<string>,
): Promise<Set<string>> {
  const candidates = relaunchedSessionCandidates(tabs, matches, adoptable)
    .filter((c) => !knownTranscripts.has(c.recordedId));
  if (candidates.length === 0) return new Set();
  return relaunchedSessionTabs(candidates, async (c) => {
    const exists = await claudeTranscriptExists(c.recordedId, c.cwd, c.distro);
    if (exists === true) knownTranscripts.add(c.recordedId);
    return exists;
  });
}

/**
 * 巡回 1 回ぶんの「照合 → 乗り換え判定 → store へ反映」。
 *
 * ClaudeSessionsRoot の巡回から呼ぶ本体で、テストも同じ関数を通す
 * (配線の書き漏れ — relaunched を渡し忘れる等 — をテストで拾うため)。
 *
 * 途中で `isCancelled()` が true になったら何も反映せず null を返す。
 *
 * @param raw       listClaudeSessions の結果（取得失敗の null は呼び出し側で弾くこと）
 * @param distros   この巡回で見に行った WSL distro
 */
export async function reflectSessions(
  raw: ClaudeSession[],
  distros: string[],
  knownTranscripts: Set<string>,
  isCancelled: () => boolean,
): Promise<{
  matches: Map<string, ClaudeSession>;
  covered: Set<string>;
  activeTabId: string | null;
} | null> {
  // 照合の **前に** 亡霊セッションを落とす。WSL では claude が強制終了しても
  // セッションファイルが消えず、数ヶ月前の死んだ json が残り続けるため、
  // ここで落とさないと状態ドットの表示も resume の対象も同じだけ引きずられる。
  const sessions = freshSessions(raw, Date.now());

  // await の前後で store が変化しうるので、照合には最新のタブ一覧を使う
  const after = useAppStore.getState();
  const tabsForMatch = Object.values(after.tabs).map((t) => ({
    id: t.id,
    cwd: t.cwd,
    args: t.args,
    claudeSessionId: t.claudeSessionId,
    // `-d` を書いていない WSL タブ（既定 distro）を Windows 側と混同しないために要る
    shell: t.shell,
  }));
  const matches = matchSessionsToTabs(sessions, tabsForMatch);
  // 表示（状態ドット）は従来どおり緩い cwd 一致のまま、
  // 復元の根拠になる書き込みだけを adoptable で絞る。
  // covered には「この巡回で実際に見に行った範囲」を渡す。WSL を間引いた tick では
  // distros が空になるので、見ていない WSL タブを「消えた」と誤判定せずに済む。
  const covered = coveredTabIds(tabsForMatch, distros);
  const adoptable = adoptableTabIds(sessions, tabsForMatch, matches);
  // 起動時の --resume が失敗して自分で claude を打ち直した Claude タブを、
  // いま話している会話へ乗り換えさせる（relaunchedSessionCandidates 参照）。
  // 候補があるときだけファイルを見に行く。
  const relaunched = await resolveRelaunchedTabs(
    Object.values(after.tabs), matches, adoptable, knownTranscripts,
  );
  if (isCancelled()) return null;
  // 待っているあいだに store が動いていても、反映は set の中で最新の tabs に対して行われる
  useAppStore.getState().applyClaudeSessions(matches, { adoptable, covered, relaunched });
  return { matches, covered, activeTabId: after.activeTabId };
}

export function ClaudeSessionsRoot({ children }: { children: ReactNode }) {
  // 巡回は長命な effect の中で回るので、最新の emit を ref 越しに読む
  // (依存に入れると巡回ごと張り直しになる)。
  const emit = useEmit<ClaudeStatusEvent>();
  const emitRef = useRef(emit);
  emitRef.current = emit;

  useEffect(() => {
    let cancelled = false;
    // WSL 側を間引くための通し番号（shouldPollWsl 参照）
    let tickCount = 0;
    // 会話ログがあると分かった claude セッション ID (resolveRelaunchedTabs 参照)
    const knownTranscripts = new Set<string>();
    // 前回が終わるまで次を出さない。WSL 側は `\\wsl.localhost\` 越しで
    // 1 回に数秒かかることがあり、2 秒間隔だと要求が積み上がってしまう。
    let running = false;

    /**
     * アクティブタブの会話ログを読んでステータスバーへ流す。
     *
     * セッションの巡回より頻度を落とす: モデルや effort はめったに変わらず、
     * WSL タブでは 9P 越しのファイル読み取りになるため。
     *
     * **この巡回で見に行っていないタブでは読み直さない。** WSL を間引いた tick では
     * WSL タブのセッションが一覧に出ないため、そのまま呼ぶと「セッションが無い」と
     * 判断して表示を消してしまい、モデル / コンテキスト表示が数秒ごとに消える
     * （applyClaudeSessions 側の covered と同じ理屈）。
     */
    const pollTranscript = async (
      currentTick: number,
      activeTabId: string | null,
      covered: ReadonlySet<string>,
      matches: Map<string, ClaudeSession>,
    ) => {
      if (activeTabId === null) return;
      if (!shouldPollTranscript(currentTick)) return;
      if (cancelled || !canReadTranscript(activeTabId, covered, matches)) return;

      const meta = await readActiveTranscript(matches.get(activeTabId));
      if (cancelled) return;
      emitRef.current({ type: 'claude-status/meta-observed', tabId: activeTabId, meta });
    };

    const pollOnce = async () => {
      const before = useAppStore.getState();
      const tabList = Object.values(before.tabs);
      // 実際に開いている WSL タブの distro だけを渡す。
      // 使っていない distro を渡すと、停止中の WSL をポーリングのたびに起こしてしまう。
      //
      // さらに、開いている distro であっても毎回は見に行かない。
      // `\\wsl.localhost\` へのアクセスは 9P 越しで高く、2 秒ごとに触ると
      // WSL が眠れなくなる。Windows 側だけ 2 秒、WSL 側は 10 秒に 1 回にする。
      const currentTick = tickCount;
      const wslPolled = shouldPollWsl(currentTick);
      const distros = wslPolled ? collectWslDistros(tabList) : [];
      tickCount += 1;

      const raw = await listClaudeSessions(distros);
      // 弾くのは取得失敗（null）だけで、0 件（= claude が 1 つも動いていない）は通す。
      // 0 件で早期 return すると「ユーザーが自分で /exit した」という、
      // 復元してよいかを決める最重要の観測を取りこぼす（claudeSessionLive が false に落ちない）。
      // 逆に失敗まで通すと、invoke が一度こけただけで全タブが「消えた」扱いになる。
      if (cancelled || raw === null) return;

      const reflected = await reflectSessions(raw, distros, knownTranscripts, () => cancelled);
      if (reflected === null) return;

      // ついでにアクティブタブの会話ログも読み、ステータスバーへ流す。
      await pollTranscript(currentTick, reflected.activeTabId, reflected.covered, reflected.matches);
    };

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await pollOnce();
      } finally {
        running = false;
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return <>{children}</>;
}
