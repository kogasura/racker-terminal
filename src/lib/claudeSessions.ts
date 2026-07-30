import { invoke } from '@tauri-apps/api/core';
import { applyIdleTransition, type AgentState } from '../types';

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
  if (cwd === undefined) return null;
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

/** 照合に必要なタブ情報だけを抜き出した型（store 全体に依存させない）。 */
export interface TabForMatch {
  id: string;
  cwd?: string;
  args?: string[];
  claudeSessionId?: string;
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
 * セッション一覧をタブへ割り当てる。
 *
 * 2 段階で照合する:
 *
 * 1. **セッション ID の完全一致** — racker が `--session-id` を付けて起動したタブは
 *    ID を知っているので確実に結びつく。これを先に確定させることで、
 *    同じディレクトリに複数タブがあっても取り違えない
 * 2. **作業ディレクトリの一致** — 手動で `claude` と打ったタブ用。
 *    未割り当てのタブと未割り当てのセッションだけを対象にし、
 *    古いセッションから順に、同じ cwd のタブへ 1 対 1 で割り当てる
 *
 * 曖昧なとき（同じ cwd にタブが複数ある等）は開始が早いもの同士を組にする。
 * 完全な正解は PID の親子関係を辿らないと出せないが、
 * 誤った組を作っても表示される状態が入れ替わるだけで、破壊的な操作は起きない。
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
    const sessionCwd = normalizeCwd(session.cwd);
    const tab = remainingTabs.find(
      (t) => !result.has(t.id) && tabCwdForMatch(t) === sessionCwd,
    );
    if (tab !== undefined) {
      result.set(tab.id, session);
      usedSessions.add(session);
    }
  }

  return result;
}

/**
 * 起動中の Claude セッション一覧を Rust から取得する。
 *
 * `distros` には **実際に WSL タブが開いている distro だけ** を渡すこと。
 * `\\wsl.localhost\` へのアクセスは停止中の WSL を起動させてしまうため、
 * 使っていない distro まで渡すとポーリングのたびに WSL を起こしてしまう。
 *
 * 失敗時は空配列を返す（Claude を使っていない環境・形式変更・権限エラー）。
 * 呼び出し側は「取れないこともある」前提で扱うこと。
 */
export async function listClaudeSessions(distros: string[] = []): Promise<ClaudeSession[]> {
  try {
    return await invoke<ClaudeSession[]>('list_claude_sessions', { distros });
  } catch (e) {
    console.warn('[claudeSessions] list_claude_sessions failed:', e);
    return [];
  }
}
