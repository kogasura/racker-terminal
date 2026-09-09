import { invoke } from '@tauri-apps/api/core';
import { applyIdleTransition, type AgentState } from '../types';
import { isWslShell, parseWslArgs } from './profileTemplates';

/**
 * Claude Code のセッション情報を読み取り、racker のタブへ結びつけるロジック。
 *
 * Claude Code は起動中のセッションごとに `~/.claude/sessions/<pid>.json` を書き出し、
 * セッション ID・作業ディレクトリ・実行状態をリアルタイムに更新している。
 * これを読むことで次の 2 つが可能になる:
 *
 * 1. **手動起動の追跡** — ユーザーが自分で `claude` と打ったタブでも
 *    セッション ID を特定でき、再起動後に `--resume` の対象にできる
 * 2. **正確な状態検出** — 画面出力の英語パターンではなく、
 *    Claude 自身が申告した status から状態を決められる
 *
 * ⚠️ セッションファイルは公式 API ではなく内部実装のため、
 * 取得できないことを常に許容する設計にしている (取れなければ画面判定に戻る)。
 */

/** Rust の `list_claude_sessions` が返すセッション情報。全フィールドが欠けうる。 */
export interface ClaudeSession {
  pid?: number;
  sessionId?: string;
  /** Windows 側は `C:\...`、WSL 側は `/home/...` 形式 */
  cwd?: string;
  /** 'busy' | 'shell' | 'idle' | 'waiting' （将来増える可能性があるため string 型） */
  status?: string;
  /** status === 'waiting' の理由。'input needed' / 'dialog open' 等 */
  waitingFor?: string;
  startedAt?: number;
  updatedAt?: number;
  name?: string;
  version?: string;
  /** racker が付与する。Windows 側は undefined、WSL 側は distro 名 */
  distro?: string;
}

/**
 * Claude Code の status を racker のタブ状態へ写す。
 *
 * 対応関係（Claude Code の実装 `wDy = ["busy","shell","idle","waiting"]` に基づく）:
 * - `waiting` → **blocked**: プロンプト / ダイアログが開いていて応答待ち
 * - `busy`    → **working**: モデルが応答を生成中
 * - `shell`   → **working**: シェルコマンドの実行中。ユーザーから見れば
 *                「動いている」点で busy と変わらないため統合する
 *                （区別は tooltip で示す）
 * - `idle`    → **idle**
 *
 * `done` は Claude 側に存在しない（完了すると idle に戻るだけ）ため、ここでは返さない。
 * 「まだ見ていない完了」は working → idle の遷移から racker 側で組み立てる。
 *
 * 未知の値は undefined を返す。呼び出し側は画面判定へフォールバックすること。
 */
export function agentStateFromStatus(status: string | undefined): AgentState | undefined {
  switch (status) {
    case 'waiting':
      return 'blocked';
    case 'busy':
    case 'shell':
      return 'working';
    case 'idle':
      return 'idle';
    default:
      return undefined;
  }
}

/**
 * status がシェルコマンド実行中かどうか。working に統合した状態を
 * tooltip で区別するためだけに使う。
 */
export function isShellStatus(status: string | undefined): boolean {
  return status === 'shell';
}

/**
 * 比較用に作業ディレクトリを正規化する。
 *
 * - 区切り文字を `/` に統一し、末尾の区切りを落とす
 * - **Windows パスのみ小文字化する**。Windows のパスは大小を区別しないが、
 *   Linux パスは区別するため、同じ扱いにすると別ディレクトリを同一視してしまう
 *
 * 空文字や undefined は null を返し、照合対象から外す
 * （cwd 不明のタブを「たまたま一致した」ことにしないため）。
 */
export function normalizeCwd(cwd: string | undefined): string | null {
  // `=== undefined` ではなく型で判定するのは、Rust の `Option::None` が
  // null として届く経路（normalizeSession の説明を参照）や、
  // 正規化前に永続化された古い値が紛れ込んでも落ちないようにするため。
  if (typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (trimmed.length === 0) return null;

  const unified = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  if (unified.length === 0) return null;

  // ドライブレター始まり (`C:/...`) を Windows パスとみなす
  const isWindowsPath = /^[A-Za-z]:\//.test(unified) || /^[A-Za-z]:$/.test(unified);
  return isWindowsPath ? unified.toLowerCase() : unified;
}

/**
 * セッションの status から、タブに設定すべき次の状態を決める。
 *
 * status をそのまま写すだけでは `done`（まだ見ていない完了）を作れない。
 * Claude は処理が終わると `idle` に戻るだけで「終わったばかり」という情報を持たないため、
 * **working から idle への遷移**を racker 側で完了とみなして done に読み替える。
 *
 * ルール:
 * - working / blocked はそのまま反映する
 * - idle に落ちたとき:
 *   - アクティブタブなら idle（見えているので通知の意味がない）
 *   - 直前が working なら **done**（処理が完了した）
 *   - すでに done ならそのまま **done を維持**（見るまで消さない）
 *   - それ以外は idle
 * - status が未知なら前の状態を保つ（勝手に消さない）
 *
 * blocked からの idle 遷移を done にしないのは、ダイアログのキャンセル等で
 * 「何も完了していないのに完了と表示される」ことを避けるため。
 */
export function nextAgentStateFromSession(
  prev: AgentState | undefined,
  status: string | undefined,
  isActive: boolean,
): AgentState | undefined {
  const mapped = agentStateFromStatus(status);
  if (mapped === undefined) return prev;   // 未知の status では触らない
  // idle への遷移を done に読み替える規則は OSC 経由と共通 (types の applyIdleTransition)
  return applyIdleTransition(prev, mapped, isActive);
}

/**
 * WSL 側を見に行く頻度（Windows 側の何回に 1 回か）。
 *
 * Windows 側はローカルのファイル読み取りなので安いが、WSL 側は
 * `\\wsl.localhost\` = 9P 越しのネットワークファイルシステムで、
 * **停止した WSL を起こしてしまう**。2 秒ごとに触ると WSL は永久に眠れず、
 * ノート PC ではそのぶんバッテリーを食う。
 *
 * Claude の状態表示が数秒遅れても実用上は困らないので、WSL 側だけ間引く。
 */
export const WSL_POLL_EVERY_N_TICKS = 5;

/**
 * この tick で WSL 側も見に行くかを決める純関数。
 *
 * 初回 (tick 0) は必ず見る。起動直後に WSL の Claude セッションを
 * 取りこぼすと、再開対象の特定が最初の 1 回ぶん遅れるため。
 */
export function shouldPollWsl(tickCount: number, everyN: number = WSL_POLL_EVERY_N_TICKS): boolean {
  if (everyN <= 1) return true;
  return tickCount % everyN === 0;
}

/**
 * WSL タブが使っている distro を集める。
 *
 * `list_claude_sessions` に渡す distro を、実際に開いているものだけに絞るために使う。
 * `\\wsl.localhost\` へのアクセスは停止中の WSL を起動させてしまうため、
 * 使っていない distro を渡すとポーリングのたびに WSL が起きてしまう。
 */
export function collectWslDistros(tabs: { args?: string[] }[]): string[] {
  const found = new Set<string>();
  for (const tab of tabs) {
    const i = tab.args?.indexOf('-d') ?? -1;
    if (i !== -1 && tab.args !== undefined) {
      const distro = tab.args[i + 1];
      if (distro !== undefined && distro.length > 0) found.add(distro);
    }
  }
  return [...found];
}

/**
 * セッションを「生きている候補」とみなす上限の経過時間（3 日）。
 *
 * WSL では claude が強制終了されるとセッションファイルが消えずに残る。
 * 実機の `\\wsl.localhost\<distro>\home\<user>\.claude\sessions` には
 * 2〜4 ヶ月前の死んだ json が 25 件残っており、しかもすべて
 * `kind:"interactive"` / `entrypoint:"cli"` なので、フィールドの値では 1 件も落とせない。
 * **時間だけが唯一の判別材料**であり、このしきい値がこの機能の安全性を単独で支えている。
 *
 * 3 日は経験則。実機の亡霊は最短でも 2.5 ヶ月前なので十分な余裕がある。
 */
export const SESSION_STALE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * セッションが最後に動いていた時刻。
 *
 * `updatedAt` は claude が状態を書き換えるたびに更新されるので鮮度として最も正確だが、
 * 実機には `updatedAt` を持たない古い形式のファイルもあるため `startedAt` に落とす。
 * どちらも無いセッションは鮮度を判定できない = 安全側に倒して落とすので undefined を返す。
 */
export function sessionLastActiveAt(session: ClaudeSession): number | undefined {
  return session.updatedAt ?? session.startedAt;
}

/**
 * 死んだセッション（亡霊）を落とす。
 *
 * **照合の前に**適用すること。ここで落としておけば、状態ドットの表示も
 * `--resume` の対象決定も同時に亡霊から守られる。逆に採用側だけで弾くと、
 * 表示だけが 4 ヶ月前のセッションに引きずられる。
 *
 * 時刻を引数で受け取るのはテスト可能にするため（内部で Date.now() を呼ばない）。
 * ゲスト側クロックが進んでいて `now` より未来のセッションは、
 * 「新しすぎる」ことを理由に落とすと WSL が丸ごと死ぬので残す。
 */
export function freshSessions(
  sessions: ClaudeSession[],
  now: number,
  maxAgeMs: number = SESSION_STALE_MS,
): ClaudeSession[] {
  return sessions.filter((s) => {
    const lastActive = sessionLastActiveAt(s);
    return lastActive !== undefined && now - lastActive <= maxAgeMs;
  });
}

/** 照合に必要なタブ情報だけを抜き出した型（store 全体に依存させない）。 */
export interface TabForMatch {
  id: string;
  cwd?: string;
  args?: string[];
  claudeSessionId?: string;
  /** WSL タブかどうかの判定に使う。`-d` を書いていない既定 distro のタブを見分ける唯一の手掛かり */
  shell?: string;
}

/**
 * タブの「実際の作業ディレクトリ」を取り出す。
 *
 * WSL タブは Windows 側の cwd ではなく、起動引数 `--cd <path>` に渡した
 * Linux パスで動いている。Claude が書く cwd もそちらなので、
 * 引数があればそれを優先する。
 */
export function tabCwdForMatch(tab: TabForMatch): string | null {
  const cdIndex = tab.args?.indexOf('--cd') ?? -1;
  if (cdIndex !== -1 && tab.args !== undefined) {
    const linuxCwd = tab.args[cdIndex + 1];
    // `~` はホームを指すが実際のパスに解決できないので照合に使わない
    if (linuxCwd !== undefined && linuxCwd !== '~') {
      return normalizeCwd(linuxCwd);
    }
  }
  return normalizeCwd(tab.cwd);
}

/**
 * 正規化済みの Linux パスから、ホームディレクトリらしき先頭部分を取り出す。
 *
 * racker からは distro の実ホームを知る手段がないため、
 * 「`/root` か `/home/<1 セグメント>` の配下ならその先頭がホーム」と逆算する。
 * カスタムホーム（/mnt/... 等）の distro では null になる。
 */
function homePrefixOf(path: string): string | null {
  if (path === '/root' || path.startsWith('/root/')) return '/root';
  return /^\/home\/[^/]+/.exec(path)?.[0] ?? null;
}

/**
 * WSL の `~` 始まりの作業ディレクトリを、セッションが申告した絶対パスと照合する。
 *
 * WSL お気に入りの既定引数は `--cd ~`（profileTemplates.buildWslArgs）なので、
 * `~` を諦めると **WSL の既定お気に入りではセッションが一度も紐付かない**。
 * そこでホームを逆算して照合する（homePrefixOf 参照）。
 *
 * 解決できない distro では false を返す。紐付かないだけで害は無いので安全側に倒す。
 */
export function matchesHomeRelative(cd: string, sessionCwd: string): boolean {
  const trimmed = cd.trim();
  if (!trimmed.startsWith('~')) return false;
  // `~` → ''、`~/dev/foo` → '/dev/foo'。`~other`（別ユーザーのホーム）は解決しない
  const tail = trimmed.slice(1);
  if (tail !== '' && !tail.startsWith('/')) return false;

  const target = normalizeCwd(sessionCwd);
  if (target === null) return false;
  const home = homePrefixOf(target);
  if (home === null) return false;
  return target === normalizeCwd(home + tail);
}

/**
 * タブが動いている WSL distro を取り出す。無ければ undefined（= Windows 側）。
 *
 * shell ではなく **args の `-d` を根拠にする**。同じファイルの collectWslDistros /
 * tabCwdForMatch が既に args だけを見ており、shell を必須にすると
 * shell を持たないタブ情報で急に照合が外れるため。
 * `-d` を書いていない既定 distro のタブは undefined になるが、
 * そちらは cwdMatches が shell と組み合わせて Windows セッションと区別する。
 */
export function tabDistro(tab: TabForMatch): string | undefined {
  const distro = parseWslArgs(tab.args).distro;
  return distro.length > 0 ? distro : undefined;
}

/**
 * セッション側の distro。空文字は Windows 側と同じ undefined として扱う。
 *
 * `!== undefined` ではなく型で判定している。Windows 側のセッションは
 * distro が **null** で届きうる（normalizeSession の説明を参照）ため、
 * undefined だけを弾くと null が素通しされて `.length` で毎回落ちる。
 * ここは Windows で claude を使っている限り必ず通る経路なので、
 * 落ちるとセッション追跡が丸ごと死ぬ。
 */
function sessionDistroOf(session: Pick<ClaudeSession, 'distro'>): string | undefined {
  const distro = session.distro;
  return typeof distro === 'string' && distro.length > 0 ? distro : undefined;
}

/**
 * タブとセッションが同じ distro（あるいは同じ Windows 側）にいるか。
 *
 * 同じ Linux パスは distro をまたいで普通に存在する（`/home/me/dev` は
 * どの distro にもある）ので、distro 一致は cwd 一致より先に効かせる必要がある。
 */
function distroMatches(tab: TabForMatch, session: Pick<ClaudeSession, 'distro'>): boolean {
  const tabSide = tabDistro(tab);
  const sessionSide = sessionDistroOf(session);
  if (tabSide !== undefined || sessionSide !== undefined) return tabSide === sessionSide;
  // 両方 undefined。`-d` を書いていない WSL タブ（既定 distro）を
  // Windows 側のセッションと同一視しないよう、ここだけ shell で切り分ける
  return !isWslShell(tab.shell);
}

/**
 * タブとセッションが「同じ階層で動いている」と言えるか。
 *
 * **照合（matchSessionsToTabs のステージ 2）・採用（adoptableTabIds）・
 * 復元前の整合チェック（claudeLaunch）の 3 箇所がこの 1 つの述語を共有する。**
 * 判断を 1 箇所に集約することで、「照合では一致とみなしたのに復元時には不一致」
 * のような食い違いが原理的に起きないようにしている。
 *
 * `--cd ~` のときだけホーム解決へ回し、それ以外は従来どおり tabCwdForMatch の完全一致。
 */
export function cwdMatches(
  tab: TabForMatch,
  session: Pick<ClaudeSession, 'cwd' | 'distro'>,
): boolean {
  if (!distroMatches(tab, session)) return false;

  const dir = parseWslArgs(tab.args).dir;
  if (dir.startsWith('~')) {
    return session.cwd !== undefined && matchesHomeRelative(dir, session.cwd);
  }

  const target = normalizeCwd(session.cwd);
  return target !== null && tabCwdForMatch(tab) === target;
}

/**
 * セッション一覧をタブへ割り当てる。
 *
 * 2 段階で照合する:
 *
 * 1. **セッション ID の完全一致** — racker が `--session-id` を付けて起動したタブは
 *    ID を知っているので確実に結びつく。これを先に確定させることで、
 *    同じディレクトリに複数タブがあっても取り違えない
 * 2. **作業ディレクトリの一致** — 手動で `claude` と打ったタブ用。
 *    未割り当てのタブと未割り当てのセッションだけを対象にし、
 *    古いセッションから順に、同じ cwd（cwdMatches）のタブへ 1 対 1 で割り当てる
 *
 * 曖昧なとき（同じ cwd にタブが複数ある等）は開始が早いもの同士を組にする。
 * 完全な正解は PID の親子関係を辿らないと出せないが、
 * **ここでの誤りは表示される状態が入れ替わるだけ**で破壊的な操作は起きない。
 * この緩さは表示にだけ許されるものなので、`--resume` の根拠にしてよいかは
 * 別関数 adoptableTabIds が厳密な条件で判断する（責務を分けている）。
 *
 * @returns tabId → ClaudeSession の対応表
 */
export function matchSessionsToTabs(
  sessions: ClaudeSession[],
  tabs: TabForMatch[],
): Map<string, ClaudeSession> {
  const result = new Map<string, ClaudeSession>();
  const usedSessions = new Set<ClaudeSession>();

  // --- 1. セッション ID の完全一致 ---
  const byId = new Map<string, ClaudeSession>();
  for (const s of sessions) {
    if (s.sessionId !== undefined) byId.set(s.sessionId, s);
  }
  for (const tab of tabs) {
    if (tab.claudeSessionId === undefined) continue;
    const hit = byId.get(tab.claudeSessionId);
    if (hit !== undefined) {
      result.set(tab.id, hit);
      usedSessions.add(hit);
    }
  }

  // --- 2. 作業ディレクトリの一致（手動起動タブ向け） ---
  const remainingTabs = tabs.filter((t) => !result.has(t.id));
  const remainingSessions = sessions
    .filter((s) => !usedSessions.has(s) && normalizeCwd(s.cwd) !== null)
    // 開始が早いものから割り当てる。undefined は最後に回す
    .sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER));

  for (const session of remainingSessions) {
    const tab = remainingTabs.find((t) => !result.has(t.id) && cwdMatches(t, session));
    if (tab !== undefined) {
      result.set(tab.id, session);
      usedSessions.add(session);
    }
  }

  return result;
}

/**
 * その組が「セッション ID の完全一致（ステージ 1）で成立したか」。
 *
 * racker が `--session-id` を付けて起動したタブは自分が発番した ID を知っているので、
 * この一致は取り違えようがない。よって採用条件を課す必要が無い。
 */
function isIdBound(tab: TabForMatch, session: ClaudeSession | undefined): boolean {
  return (
    session !== undefined &&
    tab.claudeSessionId !== undefined &&
    session.sessionId === tab.claudeSessionId
  );
}

/**
 * その組が「厳密な 1 対 1」か。
 *
 * 同じ階層に一致するセッションがちょうど 1 件、かつ一致するタブもちょうど 1 枚のときだけ true。
 * 案として検討した「セッション数 ≦ タブ数」では、同じフォルダにタブが 2 枚（片方は素のシェル）
 * あって外部アプリの claude が 1 つ動いている、という現実的な配置で成立してしまい、
 * claude を一度も打っていないタブが他所の会話 ID を採用してしまう。
 */
function isExclusivePair(
  tab: TabForMatch,
  session: ClaudeSession,
  freeTabs: TabForMatch[],
  freeSessions: ClaudeSession[],
): boolean {
  const sessionCount = freeSessions.filter((s) => cwdMatches(tab, s)).length;
  const tabCount = freeTabs.filter((t) => cwdMatches(t, session)).length;
  return sessionCount === 1 && tabCount === 1;
}

/**
 * 「復元の根拠にしてよい」タブ ID を返す。
 *
 * 表示（状態ドット）は多少取り違えても表示が入れ替わるだけだが、
 * `--resume` の根拠にした瞬間に **他所の会話が勝手に開く**ことになる。
 * そこで matchSessionsToTabs の緩い照合結果に、ここで厳しいふるいを掛ける。
 *
 * 規則:
 * 1. ステージ 1 由来（racker 発番の ID が一致した組）は常に採用する
 * 2. それ以外は「一致する未割当セッションがちょうど 1 件、かつ
 *    一致する未割当タブもちょうど 1 枚」のときだけ採用する
 *
 * 「racker を起動した後に始まったセッションか」という条件は **意図的に持たない**。
 * 別のターミナルで先に claude を動かしておき、後から同じフォルダで racker のタブを開く、
 * という使い方を潰してしまうため。そのぶん「同じフォルダで racker 以外の claude が
 * 1 つだけ動いている」ケースでは他所のセッションを採用しうるが、これは承知のうえで
 * 受け入れた挙動（タブ右クリックの「Claude セッションの記録を消す」で回復できる）。
 *
 * matchSessionsToTabs の戻り型を変えず別関数にしているのは、
 * 既存の呼び出し元とテストへの波及をゼロにするため。
 *
 * @param sessions  鮮度フィルタ済みのセッション一覧
 * @param tabs      照合対象のタブ
 * @param matches   matchSessionsToTabs の結果
 */
export function adoptableTabIds(
  sessions: ClaudeSession[],
  tabs: TabForMatch[],
  matches: ReadonlyMap<string, ClaudeSession>,
): Set<string> {
  const idBoundTabs = tabs.filter((t) => isIdBound(t, matches.get(t.id)));
  const boundSessions = new Set(idBoundTabs.map((t) => matches.get(t.id)));
  const freeTabs = tabs.filter((t) => !isIdBound(t, matches.get(t.id)));
  const freeSessions = sessions.filter((s) => !boundSessions.has(s));

  const result = new Set(idBoundTabs.map((t) => t.id));
  for (const tab of freeTabs) {
    const session = matches.get(tab.id);
    if (session !== undefined && isExclusivePair(tab, session, freeTabs, freeSessions)) {
      result.add(tab.id);
    }
  }
  return result;
}

/**
 * この巡回で「実際に観測できた」タブ ID を返す。
 *
 * WSL 側は 5 tick に 1 回しか見に行かない（WSL_POLL_EVERY_N_TICKS）ため、
 * 見ていない tick の結果をそのまま反映すると **WSL タブのセッションが
 * 2 秒ごとに消えては復活する**。状態ドットのちらつきの正体であり、
 * 「前回終了時に claude が生きていたか」の記録も誤って false に落ちてしまう。
 *
 * 見ていない範囲のタブは「消えた」ではなく「分からない」として扱うため、
 * 呼び出し側はこの集合に含まれないタブへ一切書き込まないこと。
 *
 * `-d` を書いていない WSL タブ（既定 distro）は distros に載せようがないので
 * **常に未観測**になる。既存の穴をそのまま引き継ぐが、
 * 誤って状態を消すことがなくなるぶん安全側になる。
 */
export function coveredTabIds(tabs: TabForMatch[], polledDistros: readonly string[]): Set<string> {
  const polled = new Set(polledDistros);
  const result = new Set<string>();
  for (const tab of tabs) {
    const distro = tabDistro(tab);
    const isWsl = distro !== undefined || isWslShell(tab.shell);
    if (!isWsl || (distro !== undefined && polled.has(distro))) result.add(tab.id);
  }
  return result;
}

/**
 * Rust から届く「正規化前」のセッション。
 *
 * Rust 側の `ClaudeSession` は全フィールドが `Option<_>` で、
 * `#[serde(skip_serializing_if)]` を付けていない。serde の既定では
 * `Option::None` は **キーごと消えるのではなく `null` として直列化される**ため、
 * IPC を越えて届く値は `undefined` ではなく `null` になる。
 * とくに `distro` は「Windows 側なら None」= **Windows で claude を使っている限り
 * 必ず null** で届くフィールドで、TS 側が宣言している `distro?: string`
 * （= `string | undefined`）とは実態が食い違っている。
 *
 * この型は「宣言と実態のズレ」を境界の内側だけに閉じ込めるためのもの。
 */
type RawClaudeSession = { [K in keyof ClaudeSession]: ClaudeSession[K] | null };

/** Rust の `Option::None`（= null）を undefined に寄せる。 */
function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/** セッション ID として受け入れる形（UUID）。 */
const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * セッション ID が「そのまま `claude --resume <id>` に渡してよい形」か。
 *
 * この値は最終的に **シェルコマンド文字列へ引用符なしで埋め込まれる**
 * (TerminalPane の buildClaudeCommand → PTY へタイプ送信 / WSL は `bash -ic`)。
 * racker が `crypto.randomUUID()` で発番していたあいだは自明に安全だったが、
 * 手動起動タブでは `~/.claude/sessions/*.json` の中身をそのまま採用するため、
 * **外部ファイルの文字列がシェルに届く経路**になった。しかも Rust の
 * `wsl_session_dirs` は distro 内の他ユーザーの home も走査する。
 *
 * 実データはすべて UUID なので、ここで形を確かめて外れ値は捨てる。
 * 形式が変わったら「復元しない」に倒れるだけで（racker の他の Claude 連携と
 * 同じ「取れないことを許容する」方針）、壊れた文字列がシェルへ流れることはない。
 */
export function isSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * 生のセッションを、`ClaudeSession` の宣言どおり「値が無ければ undefined」へ正規化する。
 *
 * **ここで寄せておかないと `x !== undefined` 形の判定がすべて null を素通しする。**
 * 各利用箇所で個別に null を気にするのは漏れるので、入口の 1 箇所で潰す。
 */
function normalizeSession(raw: RawClaudeSession): ClaudeSession {
  const sessionId = orUndefined(raw.sessionId);
  return {
    pid: orUndefined(raw.pid),
    // UUID の形をしていない ID は捨てる（isSessionId の説明を参照）。
    // 落としても状態表示は cwd 一致で動き続け、resume の対象から外れるだけ。
    sessionId: isSessionId(sessionId) ? sessionId : undefined,
    cwd: orUndefined(raw.cwd),
    status: orUndefined(raw.status),
    waitingFor: orUndefined(raw.waitingFor),
    startedAt: orUndefined(raw.startedAt),
    updatedAt: orUndefined(raw.updatedAt),
    name: orUndefined(raw.name),
    version: orUndefined(raw.version),
    distro: orUndefined(raw.distro),
  };
}

/**
 * 起動中の Claude セッション一覧を Rust から取得する。
 *
 * `distros` には **実際に WSL タブが開いている distro だけ** を渡すこと。
 * `\\wsl.localhost\` へのアクセスは停止中の WSL を起動させてしまうため、
 * 使っていない distro まで渡すとポーリングのたびに WSL を起こしてしまう。
 *
 * **失敗は `null`、成功して 0 件は `[]`** を返す。かつては両方 `[]` だったが、
 * それでは「claude を全部終了した」と「取得に失敗した」が区別できない。
 * 前者は「ユーザーが自分で /exit した」という復元可否を決める最重要の観測であり、
 * 後者で同じ扱いをすると一時的な失敗のたびに全タブが消失扱いになる。
 */
export async function listClaudeSessions(distros: string[] = []): Promise<ClaudeSession[] | null> {
  try {
    const raw = await invoke<RawClaudeSession[]>('list_claude_sessions', { distros });
    return raw.map(normalizeSession);
  } catch (e) {
    console.warn('[claudeSessions] list_claude_sessions failed:', e);
    return null;
  }
}
