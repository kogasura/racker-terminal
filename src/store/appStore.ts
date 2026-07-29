import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AgentState, AppState, ClosedTab, DragKind, Favorite, Group, Settings, Tab, TabStatus } from '../types';
import { applyIdleTransition } from '../types';
import { newId } from '../lib/id';
import {
  nextAgentStateFromSession,
  type ClaudeSession as ClaudeSessionInfo,
} from '../lib/claudeSessions';
import type { PrInfo as PrInfoValue } from '../lib/prStatus';
import { forceDisposeRuntime } from '../lib/terminalRegistry';
import { checkForUpdate, downloadUpdate, installAndRelaunch, type UpdateAvailable } from '../lib/updater';

// Update ハンドルは state には入れない (zustand の構造比較で重い object を引きずらないため)
let pendingUpdateHandle: UpdateAvailable | null = null;

export const CLOSED_TABS_MAX = 10;

const defaultSettings: Settings = {
  shell: undefined,
  theme: 'tokyo-night',
  fontFamily: '"MonaspiceNe NF", "Cascadia Code", "Consolas", monospace',
  fontSize: 12.5,
  scrollback: 10000,
  transparency: 1.0,
};

/**
 * 削除されたタブの代わりにアクティブにするタブ ID を決定する純関数。
 * テスト容易性のため appStore 外から import できる形で export する。
 *
 * 優先順: 同グループ末尾 → 前グループ末尾 → 後グループ先頭 → null
 */
export function selectFallbackTab(
  removedGroupId: string,
  updatedGroups: Group[],
): string | null {
  const group = updatedGroups.find((g) => g.id === removedGroupId);
  if (group && group.tabIds.length > 0) {
    return group.tabIds[group.tabIds.length - 1];
  }
  const idx = updatedGroups.findIndex((g) => g.id === removedGroupId);
  if (idx === -1) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (updatedGroups[i].tabIds.length > 0) {
      return updatedGroups[i].tabIds[updatedGroups[i].tabIds.length - 1];
    }
  }
  for (let i = idx + 1; i < updatedGroups.length; i++) {
    if (updatedGroups[i].tabIds.length > 0) {
      return updatedGroups[i].tabIds[0];
    }
  }
  return null;
}

/**
 * サイドバー表示順（groups 配列順 → 各グループの tabIds 順）でタブをフラット化し、
 * 現在の activeTabId の次のタブ ID を返す。末尾→先頭でラップ。
 * activeTabId が null か全タブにマッチしない場合は null。
 */
export function selectNextTabId(state: AppState): string | null {
  // 空グループはスキップしてフラットなタブ ID 一覧を構築する
  const flatIds = state.groups.flatMap((g) => g.tabIds);
  if (flatIds.length === 0) return null;
  if (state.activeTabId === null) return null;
  const idx = flatIds.indexOf(state.activeTabId);
  if (idx === -1) return null;
  // 末尾の場合は先頭へラップ
  return flatIds[(idx + 1) % flatIds.length];
}

/** 同上、前のタブを返す。先頭→末尾でラップ */
export function selectPrevTabId(state: AppState): string | null {
  const flatIds = state.groups.flatMap((g) => g.tabIds);
  if (flatIds.length === 0) return null;
  if (state.activeTabId === null) return null;
  const idx = flatIds.indexOf(state.activeTabId);
  if (idx === -1) return null;
  // 先頭の場合は末尾へラップ
  return flatIds[(idx - 1 + flatIds.length) % flatIds.length];
}

/**
 * tabId を含むグループが折りたたまれていれば展開した groups を返す。
 * tabId が null か該当グループが見つからない、または折りたたまれていない場合は groups をそのまま返す。
 * Ctrl+Tab 等のキーボード操作・removeTab のフォールバックで、active タブが折りたたみグループ内に
 * 隠れて見えなくなる UX 問題を解消するために使用する。
 */
export function expandGroupContaining(
  groups: Group[],
  tabId: string | null,
): Group[] {
  if (tabId === null) return groups;
  const target = groups.find((g) => g.tabIds.includes(tabId));
  if (!target?.collapsed) return groups;
  return groups.map((g) =>
    g.id === target.id ? { ...g, collapsed: false } : g,
  );
}

/**
 * グループを選択したときにアクティブにすべきタブ ID を返す純関数。
 *
 * 優先順位:
 *   1. そのグループで最後に見ていたタブ（現存し、まだそのグループに属している場合）
 *   2. グループ先頭のタブ
 *   3. タブが 1 つもなければ null
 *
 * lastActiveTabByGroup には削除済みタブの ID が残りうるので、必ず現存確認を通す。
 */
export function selectTabForGroup(
  group: Group | undefined,
  lastActiveTabByGroup: Record<string, string>,
  tabs: Record<string, Tab>,
): string | null {
  if (!group) return null;
  const last = lastActiveTabByGroup[group.id];
  if (last !== undefined && tabs[last] !== undefined && group.tabIds.includes(last)) {
    return last;
  }
  return group.tabIds[0] ?? null;
}

/**
 * activeTabId の変更に追随して activeGroupId と lastActiveTabByGroup を更新する純関数。
 * set() に spread して使う想定で、更新が不要な場合は空オブジェクトを返す。
 *
 * tabId が null / 不明のときは **activeGroupId を変更しない**。
 * 最後のタブを閉じたときにグループ選択まで外れると、サイドバーの選択が飛んで
 * 「新しいタブをどこに作るか」の文脈が失われるため。
 */
export function syncGroupSelection(
  tabs: Record<string, Tab>,
  lastActiveTabByGroup: Record<string, string>,
  tabId: string | null,
): { activeGroupId?: string; lastActiveTabByGroup?: Record<string, string> } {
  if (tabId === null) return {};
  const tab = tabs[tabId];
  if (tab === undefined) return {};
  return {
    activeGroupId: tab.groupId,
    lastActiveTabByGroup: { ...lastActiveTabByGroup, [tab.groupId]: tabId },
  };
}

/**
 * パス末尾のフォルダ名を返す純関数（Windows `\` / POSIX `/` 両対応）。
 * ドライブ直下（例: `C:\`）や取得できない場合は 'Terminal' を返す。
 * Explorer「Racker Terminal で開く」で開いたタブのタイトルに使う。
 */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0 && p !== '~');
  const last = parts[parts.length - 1];
  // `C:` のようなドライブレターだけになった場合はフォールバックする
  if (!last || /^[A-Za-z]:$/.test(last)) return 'Terminal';
  return last;
}

/** createTab が受け取るオプション。 */
type CreateTabOptions = Partial<
  Pick<
    Tab,
    | 'userTitle'
    | 'shell'
    | 'cwd'
    | 'env'
    | 'args'
    | 'launchClaude'
    | 'claudeSessionId'
    | 'bypassPermissions'
  >
> & { title?: string };

/** タブに載せる PR 関連フィールドを PrInfo から作る。 */
function prFields(pr: PrInfoValue | null) {
  return {
    prNumber: pr?.number,
    prState: pr?.state,
    prUrl: pr?.url,
    prIsDraft: pr?.isDraft,
    prBranch: pr?.branch,
  };
}

/** タブの PR 関連フィールドが next と一致するか。 */
function hasSamePrFields(tab: Tab, next: ReturnType<typeof prFields>): boolean {
  return (
    tab.prNumber === next.prNumber &&
    tab.prState === next.prState &&
    tab.prUrl === next.prUrl &&
    tab.prIsDraft === next.prIsDraft &&
    tab.prBranch === next.prBranch
  );
}

/** タブの claude セッション関連フィールドが、これから入れる値と一致するか。 */
function hasSameClaudeSession(
  tab: Tab,
  session: ClaudeSessionInfo,
  nextAgentState: AgentState | undefined,
  nextSessionId: string | undefined,
): boolean {
  return (
    tab.agentState === nextAgentState &&
    tab.agentStateFromSession === true &&
    tab.claudeSessionId === nextSessionId &&
    tab.waitingFor === session.waitingFor &&
    tab.claudeStatus === session.status
  );
}

/**
 * セッション情報 1 件をタブへ反映した結果を返す。
 * 変更が無ければ元の tab をそのまま返すので、呼び出し側は参照比較で変更有無を判定できる。
 */
function tabWithClaudeSession(
  tab: Tab,
  session: ClaudeSessionInfo | undefined,
  isActive: boolean,
): Tab {
  if (session === undefined) {
    // セッションが見つからない = claude が終了した / 検出できない。
    // 画面パターン判定へフォールバックできるようフラグを落とす。
    if (tab.agentStateFromSession !== true) return tab;
    return {
      ...tab,
      agentStateFromSession: false,
      waitingFor: undefined,
      claudeStatus: undefined,
    };
  }

  const nextAgentState = nextAgentStateFromSession(tab.agentState, session.status, isActive);
  // 手動起動タブでも resume できるよう、未設定なら検出した ID を採用する。
  // すでに ID を持つタブ（racker が --session-id で起動した）は上書きしない。
  const nextSessionId = tab.claudeSessionId ?? session.sessionId;

  if (hasSameClaudeSession(tab, session, nextAgentState, nextSessionId)) return tab;

  return {
    ...tab,
    agentState: nextAgentState,
    agentStateFromSession: true,
    claudeSessionId: nextSessionId,
    waitingFor: session.waitingFor,
    claudeStatus: session.status,
  };
}

/**
 * 新規タブの所属グループを解決する。
 *   1. 指定されかつ存在 → そのグループを使う
 *   2. groups が空 → Default グループを自動作成
 *   3. 未指定 or 不正:
 *      - アクティブタブが存在し、その所属グループが現存 → そのグループに追加
 *        (favorite / Ctrl+T / 既定タブ起動など、現在の作業文脈を維持する目的)
 *      - そうでなければ groups[0] にフォールバック
 */
function resolveTabGroup(
  state: Pick<AppState, 'groups' | 'tabs' | 'activeTabId'>,
  groupId: string | undefined,
): { groupId: string; groups: Group[] } {
  if (groupId !== undefined && state.groups.some((g) => g.id === groupId)) {
    return { groupId, groups: state.groups };
  }

  if (state.groups.length === 0) {
    const newGroupId = newId();
    return {
      groupId: newGroupId,
      groups: [{ id: newGroupId, title: 'Default', collapsed: false, tabIds: [] }],
    };
  }

  // activeTabId は string | null。Truthy 判定ではなく null 比較で意図を明示する
  // (将来空文字列が入る可能性に対する防御は state.tabs[id] が undefined を返すことで担保される)
  const activeTab = state.activeTabId !== null ? state.tabs[state.activeTabId] : undefined;
  if (activeTab !== undefined && state.groups.some((g) => g.id === activeTab.groupId)) {
    return { groupId: activeTab.groupId, groups: state.groups };
  }
  return { groupId: state.groups[0].id, groups: state.groups };
}

/** 新規タブのオブジェクトを組み立てる。 */
function buildTab(tabId: string, groupId: string, opts?: CreateTabOptions): Tab {
  const o = opts ?? {};
  return {
    id: tabId,
    groupId,
    // o.title は後方互換のために受け付け、userTitle にセットする
    userTitle: o.userTitle ?? o.title,
    shell: o.shell,
    cwd: o.cwd,
    args: o.args ? [...o.args] : undefined,
    env: o.env ? { ...o.env } : undefined,
    launchClaude: o.launchClaude,
    claudeSessionId: o.claudeSessionId,
    bypassPermissions: o.bypassPermissions,
    status: 'spawning',
  };
}

/**
 * 復元した group.tabIds を整える。
 * - state.tabs に存在しない ID を除去
 * - 重複 tabId を除去（最初に現れた group に属させる）
 */
function sanitizeGroupTabIds(groups: Group[], validTabIds: Set<string>): Group[] {
  const seen = new Set<string>();
  return groups.map((g) => ({
    ...g,
    tabIds: g.tabIds.filter((id) => {
      if (!validTabIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  }));
}

/**
 * 復元直後のアクティブ選択を決める。
 *
 * activeTabId / activeGroupId は persist 対象外なので復元直後は null になる。
 * 横タブバーは activeGroupId のタブを並べるため、未選択のままだと再起動後に
 * タブが 1 つも表示されない。タブを持つ最初のグループの先頭タブを選ぶ。
 */
function initialSelection(groups: Group[]): {
  activeGroupId: string | null;
  activeTabId: string | null;
  lastActiveTabByGroup: Record<string, string>;
} {
  const first = groups.find((g) => g.tabIds.length > 0) ?? groups[0] ?? null;
  if (first === null) {
    return { activeGroupId: null, activeTabId: null, lastActiveTabByGroup: {} };
  }
  const activeTabId = first.tabIds[0] ?? null;
  return {
    activeGroupId: first.id,
    activeTabId,
    lastActiveTabByGroup: activeTabId !== null ? { [first.id]: activeTabId } : {},
  };
}

interface AppActions {
  /**
   * tabId を active に設定する（直接更新経路）。
   * Sidebar のタブクリック等、ユーザーが直接タブを選択した場合に使用する。
   * 折りたたみグループの自動展開は行わない。
   * キーボード遷移（Ctrl+Tab 等）では navigateToTab を使うこと。
   */
  setActiveTab: (tabId: string | null) => void;

  /**
   * お気に入りを追加し、発行した id を返す。
   * 同一 title でも別 id が発行されるため重複登録が可能。
   */
  addFavorite: (fav: Omit<Favorite, 'id'>) => string;

  /**
   * お気に入りを削除する。
   * 存在しない favId は no-op。
   */
  removeFavorite: (favId: string) => void;

  /**
   * お気に入りを編集する。
   * id は変更されない。存在しない favId は no-op。
   * Phase 4 P-G で追加 (FavoriteDialog 編集機能)。
   */
  updateFavorite: (favId: string, patch: Omit<Favorite, 'id'>) => void;

  /**
   * お気に入りの設定で新しいタブを spawn する。
   * - shell / cwd / env を Favorite から引き継ぐ
   * - title は Favorite.defaultTabTitle ?? Favorite.title
   * - 存在しない favId は null を返す
   */
  spawnFavorite: (favId: string) => string | null;

  /**
   * 指定フォルダを cwd にした新しいタブを spawn し、そのタブ ID を返す。
   * Windows Explorer の「Racker Terminal で開く」コンテキストメニューから使う。
   * - 既定お気に入りが設定されている場合は、その shell / args / env / Claude 設定を
   *   引き継ぎつつ cwd だけを指定フォルダに差し替える。
   * - 既定お気に入りが無い場合は、フォルダ名をタイトルにした plain タブを開く。
   */
  spawnAtPath: (path: string) => string;
  /**
   * tabId を active にし、その tabId を含むグループが折りたたまれていれば自動展開する。
   * Ctrl+Tab / Ctrl+Shift+Tab のキーボード遷移で使用する。
   * 隠れタブにジャンプして active が見えなくなる UX 問題を防ぐ。
   * Sidebar クリック等の直接更新経路では setActiveTab を使うこと。
   */
  navigateToTab: (tabId: string) => void;
  startEditing: (id: string) => void;
  stopEditing: () => void;

  /** 右クリックコンテキストメニューの open 状態を同期する。
   * ContextMenu の onOpenChange から呼ぶ。
   * TerminalPane の attachCustomKeyEventHandler で contextMenuOpen===true のとき
   * Ctrl+Tab 等のキーバインドを suspend する。
   */
  setContextMenuOpen: (open: boolean) => void;

  /**
   * グループを新規作成し、そのグループ ID を返す。
   * A2 では起動時の default グループ自動生成のみに使用。
   * Unit B でグループ UI を実装する際に本格利用する。
   */
  createGroup: (title?: string) => string;

  /**
   * タブを新規作成し、そのタブ ID を返す。
   * groupId 未指定時は groups[0] を使うか、なければ createGroup('Default') を自動呼び出し。
   * PTY 操作は行わない。TerminalPane が mount されてから status=spawning を検知して startSpawn を呼ぶ。
   *
   * opts.title は後方互換のために受け付け、userTitle にセットする。
   */
  createTab: (
    groupId?: string,
    opts?: Partial<
      Pick<Tab, 'userTitle' | 'shell' | 'cwd' | 'env' | 'args' | 'launchClaude' | 'claudeSessionId' | 'bypassPermissions'>
    > & { title?: string },
  ) => string;

  /**
   * タブを削除する。
   * forceDisposeRuntime を set より先に呼ぶことで、React が TerminalPane を unmount して
   * releaseRuntime が来ても無害化される（設計書 §6 removeTab 参照）。
   */
  removeTab: (tabId: string) => void;

  /**
   * タブの status と ptyId を更新する。
   * removeTab 後の非同期更新（spawn Promise の resolve）に対して防御コードを持つ。
   */
  setTabStatus: (tabId: string, status: TabStatus, ptyId?: string) => void;

  /**
   * ユーザー手動編集によるタイトルを更新する (userTitle を更新)。
   * title は trim され最大 64 文字に切り詰める。
   * 結果が空文字列なら no-op（元タイトル維持）。
   * 存在しない tabId は no-op。
   */
  updateTabTitle: (tabId: string, title: string) => void;

  /**
   * shell の OSC タイトルシーケンス経由で受信したタイトルを更新する (oscTitle を更新)。
   * userTitle が設定されている場合は OSC タイトルより優先されるが、oscTitle は保存される。
   * 存在しない tabId は no-op。
   * Phase 4 P-A で追加。
   */
  updateTabOscTitle: (tabId: string, oscTitle: string) => void;

  /**
   * OSC 7 経由で受信した shell の現在 cwd を tab.cwd に反映する。
   * 同じ値なら no-op（不要な再レンダーを回避）。
   * 存在しない tabId は no-op。
   * Phase 4 P-G で追加。
   */
  updateTabCwd: (tabId: string, cwd: string) => void;

  /**
   * Claude タブの管理セッション ID を設定する。
   * 初回 spawn 時に TerminalPane が crypto.randomUUID() を発番して呼ぶ。
   * 永続化されるため、再起動後は `claude --resume <id>` で同一セッションを再開できる。
   * 存在しない tabId は no-op。
   */
  setClaudeSessionId: (tabId: string, sessionId: string) => void;

  /**
   * タブを同一グループ内に複製する。
   * - 元タブの groupId / shell / cwd / args / env を引き継ぐ
   * - title は元 title + " (copy)"
   * - 元タブの直後に挿入
   * - status は 'spawning'
   * - 返り値: 新タブの ID。元タブが見つからなければ null
   */
  duplicateTab: (tabId: string) => string | null;

  /**
   * グループを削除する。
   * - groups.length === 1 なら no-op（最後の 1 個保護）
   * - 対象グループの tabIds が空でなければ no-op（タブ残存防御）
   */
  removeGroup: (groupId: string) => void;

  /**
   * グループタイトルを更新する。
   * title は trim され、最大 64 文字に切り詰める。
   */
  updateGroupTitle: (groupId: string, title: string) => void;

  /** グループの collapsed 状態をトグルする。 */
  toggleCollapse: (groupId: string) => void;

  /**
   * groups 配列の並び順を変更する（Unit F D&D 用の先回り実装）。
   * toIndex は [0, groups.length-1] にクランプされる。
   */
  moveGroup: (groupId: string, toIndex: number) => void;

  /**
   * favorites 配列の並び順を変更する。
   * toIndex は [0, favorites.length-1] にクランプされる。
   * Phase 4 P-B-1 で追加。
   */
  moveFavorite: (favId: string, toIndex: number) => void;

  /**
   * タブを別グループの指定 index に移動する。
   * - fromGroup の tabIds から対象を除去
   * - toGroup の tabIds の toIndex 位置に挿入 (toIndex は [0, toGroup.tabIds.length] にクランプ)
   * - 同一グループ内移動: from 除去 → 同 group 内に再挿入
   * - 不正な tabId / toGroupId は no-op
   * - tab.groupId フィールドも更新
   */
  moveTab: (tabId: string, toGroupId: string, toIndex: number) => void;

  /**
   * Settings を一括更新する。Phase 4 P-B-2 で追加。
   * applySettings broadcast 機構経由で全 runtime に反映される。
   */
  updateSettings: (patch: Partial<Settings>) => void;

  /**
   * 既定お気に入りを設定する (null で解除)。
   * 存在しない favId が渡された場合は no-op。
   * Phase 4 P-H で追加。
   */
  setDefaultFavorite: (favId: string | null) => void;

  /**
   * 既定お気に入りで新規タブを spawn する。
   * - settings.defaultFavoriteId が設定されていて、その favorite が存在する → spawnFavorite を呼ぶ
   * - そうでなければ createTab(undefined, { userTitle: 'Terminal' }) で plain タブを作成
   * - 返り値: 作成したタブの ID
   * Phase 4 P-H で追加。
   */
  spawnDefaultOrNew: () => string;

  /**
   * index 番目 (0-indexed) のお気に入りで新規タブを spawn する。
   * - 存在しない index は null を返す
   * Phase 4 P-H で追加。
   */
  spawnFavoriteByIndex: (index: number) => string | null;

  /**
   * インストール済 WSL distro 一覧を更新する。
   * App 起動時に listWslDistros() から取得した値をセットする。
   * persist 対象外（ランタイム状態）。
   * Phase 4 P-K で追加。
   */
  setWslDistros: (distros: string[]) => void;

  /**
   * タブのエージェント状態を設定する。
   * terminalRegistry の状態検出 → TerminalPane 経由で、状態が変化したときだけ呼ばれる。
   *
   * - 存在しない tabId は no-op
   * - 'done' をアクティブタブに設定しようとした場合は 'idle' に落とす
   *   （完了通知は「見るまで残す」ものなので、見ているタブでは即座に用済み）
   * - 'blocked' はアクティブタブでも保持する（見ているだけでは応答待ちは解消しないため）
   * - 既に同じ値なら no-op（不要な再レンダ抑止）
   */
  setTabAgentState: (tabId: string, state: AgentState) => void;

  /**
   * Claude Code のセッション一覧との照合結果を一括反映する。
   *
   * ポーリングのたびに全タブぶんの対応表を受け取り、次を行う:
   * 1. セッション ID 未設定のタブに検出した ID を書き込む
   *    → **手動で `claude` と打ったタブも再起動後に `--resume` できるようになる**
   * 2. Claude が申告した status からタブの状態を更新する
   *    （working → idle の遷移を done に読み替える。nextAgentStateFromSession 参照）
   * 3. セッションが見つからなかったタブは agentStateFromSession を落とし、
   *    画面パターン判定へフォールバックさせる
   *
   * 変化がまったく無ければ tabs の参照を変えない（毎秒の再レンダーを避ける）。
   */
  applyClaudeSessions: (matches: Map<string, ClaudeSessionInfo>) => void;

  /**
   * OSC 21337 (TAB_STATUS) で受け取った状態を反映する。
   *
   * Claude Code が端末へ直接送ってくる状態なので、セッションファイル由来と同じく
   * **画面パターン判定より優先**する（agentStateFromSession を立てる）。
   * PTY を流れてくるぶん、WSL でもファイルパスの解決に依存せず確実に届く。
   *
   * - `state === null` は「表示の解除」= claude の終了。状態を消して
   *   画面パターン判定へフォールバックさせる
   * - Claude タブとして登録していないタブ（手動で `claude` と打った等）にも適用する
   */
  applyTabStatusOsc: (tabId: string, state: AgentState | null) => void;

  /**
   * 作業ディレクトリごとに引いた PR 状態を、該当タブへまとめて反映する。
   *
   * 同じリポジトリを複数タブで開いていることが多いため、cwd 単位で 1 回引いた結果を
   * 複数タブへ配る形にしている（`gh` はネットワークを伴うので回数を抑えたい）。
   *
   * `pr === null` は「PR が無い / 取得できない」。既存の表示を消す。
   * 変化が無ければ tabs の参照を据え置く。
   */
  applyPrStatus: (tabIds: string[], pr: PrInfoValue | null) => void;

  /**
   * サイドバーでグループを選択する。横タブバーの表示対象がこのグループに切り替わる。
   *
   * そのグループで最後に見ていたタブ（なければ先頭タブ）を自動でアクティブにする。
   * タブが 1 つもないグループを選んだ場合は activeTabId を null にして、
   * ターミナル領域を空表示にする。
   * - 存在しない groupId は no-op
   */
  setActiveGroup: (groupId: string) => void;

  /**
   * D&D の進行状態を記録する。DragDropProvider の onDragStart / onDragEnd から呼ぶ。
   * ドラッグ終了時は (null, null) を渡す。
   */
  setDragState: (dragId: string | null, dragKind: DragKind | null) => void;

  // --- updater アクション ---
  /**
   * 起動時に App.tsx から呼ぶ。更新チェックを実行し、利用可能な更新があれば
   * バックグラウンドで自動 DL して updatePhase を 'ready' に遷移させる。
   * 再入防止: phase !== 'idle' のとき no-op。
   */
  runUpdateCheck: () => Promise<void>;

  /** 更新ダイアログを開く。 */
  openUpdateDialog: () => void;

  /** 更新ダイアログを閉じる。 */
  closeUpdateDialog: () => void;

  /**
   * ユーザーが Dialog の「今すぐ再起動」をクリックして呼ぶ。
   * インストール + relaunch を実行する。
   * 再入防止: phase が 'ready' でも 'error' でもないとき no-op。
   */
  applyUpdate: () => Promise<void>;

  /**
   * エラー状態をリセットして idle に戻す。
   * 更新ダイアログの「閉じる」ボタンから呼ぶ。
   */
  resetUpdateError: () => void;

  /**
   * 最後に閉じたタブを復元する。Ctrl+Shift+T から呼ぶ。
   * - スタックが空 → null を返す (no-op)
   * - 元グループが残っていればそこに、なければ groups[0] にフォールバック
   * - 戻り値: 復元した tabId | null
   */
  restoreLastClosedTab: () => string | null;
}

type Store = AppState & AppActions;

export const useAppStore = create<Store>()(
  persist(
    (set, get) => ({
  groups: [],
  tabs: {},
  favorites: [],
  activeTabId: null,
  activeGroupId: null,
  lastActiveTabByGroup: {},
  dragId: null,
  dragKind: null,
  editingId: null,
  contextMenuOpen: false,
  settings: defaultSettings,
  wslDistros: [],
  closedTabs: [],
  updateInfo: null,
  updatePhase: 'idle',
  updateProgress: 0,
  updateError: null,
  updateDialogOpen: false,

  addFavorite: (fav) => {
    const id = newId();
    set((state) => ({
      favorites: [
        ...state.favorites,
        {
          ...fav,
          id,
          args: fav.args ? [...fav.args] : undefined,
          env: fav.env ? { ...fav.env } : undefined,
        },
      ],
    }));
    return id;
  },

  removeFavorite: (favId) => {
    set((state) => {
      const isDefault = state.settings.defaultFavoriteId === favId;
      return {
        favorites: state.favorites.filter((f) => f.id !== favId),
        // 削除対象が defaultFavoriteId と一致する場合は併せてクリアする (R3)
        settings: isDefault
          ? { ...state.settings, defaultFavoriteId: undefined }
          : state.settings,
      };
    });
  },

  updateFavorite: (favId, patch) =>
    set((state) => {
      if (!state.favorites.some((f) => f.id === favId)) return {};  // 存在しない favId は no-op
      return {
        favorites: state.favorites.map((f) =>
          // F-M4: patch.env / patch.args を shallow clone して addFavorite と対称化する
          f.id === favId
            ? {
                ...patch,
                id: favId,
                args: patch.args ? [...patch.args] : undefined,
                env: patch.env ? { ...patch.env } : undefined,
              }
            : f,
        ),
      };
    }),

  spawnFavorite: (favId) => {
    const fav = get().favorites.find((f) => f.id === favId);
    if (!fav) return null;
    const userTitle = fav.defaultTabTitle ?? fav.title;
    return get().createTab(undefined, {
      userTitle,
      shell: fav.shell,
      cwd: fav.cwd,
      // F-M2: fav.args / fav.env を shallow clone して参照を独立させる
      args: fav.args ? [...fav.args] : undefined,
      env: fav.env ? { ...fav.env } : undefined,
      launchClaude: fav.launchClaude,
      bypassPermissions: fav.bypassPermissions,
    });
  },

  spawnAtPath: (path) => {
    const state = get();
    const { defaultFavoriteId } = state.settings;
    // 既定お気に入りがあれば、その設定を引き継ぎつつ cwd を上書きして開く。
    if (defaultFavoriteId) {
      const fav = state.favorites.find((f) => f.id === defaultFavoriteId);
      if (fav) {
        return get().createTab(undefined, {
          userTitle: fav.defaultTabTitle ?? fav.title,
          shell: fav.shell,
          cwd: path,
          args: fav.args ? [...fav.args] : undefined,
          env: fav.env ? { ...fav.env } : undefined,
          launchClaude: fav.launchClaude,
          bypassPermissions: fav.bypassPermissions,
        });
      }
    }
    // 既定お気に入りなし → フォルダ名をタイトルにした plain タブ
    return get().createTab(undefined, { userTitle: pathBasename(path), cwd: path });
  },

  setActiveTab: (tabId) =>
    set((state) => {
      const tab = tabId !== null ? state.tabs[tabId] : undefined;
      // グループ選択（サイドバーのハイライトと横タブバーの表示対象）を追随させる
      const groupSync = syncGroupSelection(state.tabs, state.lastActiveTabByGroup, tabId);
      // 完了通知 ('done') は「ユーザーが見るまで残す」状態なので、見た時点でクリアする。
      // 'blocked' は応答するまで残す（タブを開いただけでは応答待ちは解消しない）。
      if (tab?.agentState === 'done') {
        return {
          activeTabId: tabId,
          ...groupSync,
          tabs: { ...state.tabs, [tabId!]: { ...tab, agentState: 'idle' } },
        };
      }
      return { activeTabId: tabId, ...groupSync };
    }),
  navigateToTab: (tabId) =>
    set((state) => {
      const tab = state.tabs[tabId];
      const base = {
        activeTabId: tabId,
        groups: expandGroupContaining(state.groups, tabId),
        // Ctrl+Tab で別グループのタブへ渡ったときも、サイドバーの選択と
        // 横タブバーの表示対象を追随させる
        ...syncGroupSelection(state.tabs, state.lastActiveTabByGroup, tabId),
      };
      // setActiveTab と同じ規約: 完了通知だけをクリアし、応答待ち ('blocked') は残す
      if (tab?.agentState === 'done') {
        return { ...base, tabs: { ...state.tabs, [tabId]: { ...tab, agentState: 'idle' } } };
      }
      return base;
    }),
  setActiveGroup: (groupId) => {
    const state = get();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;  // 存在しない groupId は no-op

    const tabId = selectTabForGroup(group, state.lastActiveTabByGroup, state.tabs);
    if (tabId === null) {
      // タブが 1 つもないグループ: 選択だけ移してターミナル領域は空表示にする
      set({ activeGroupId: groupId, activeTabId: null });
      return;
    }
    // activeGroupId / lastActiveTabByGroup の更新と done のクリアは setActiveTab に委ねる
    get().setActiveTab(tabId);
  },

  setDragState: (dragId, dragKind) => set({ dragId, dragKind }),

  applyPrStatus: (tabIds, pr) =>
    set((state) => {
      let changed = false;
      const tabs = { ...state.tabs };
      // tab に依存しないのでループの外で 1 回だけ作る
      const next = prFields(pr);

      for (const id of tabIds) {
        const tab = state.tabs[id];
        if (!tab) continue;
        if (hasSamePrFields(tab, next)) continue;

        tabs[id] = { ...tab, ...next };
        changed = true;
      }

      return changed ? { tabs } : {};
    }),

  applyTabStatusOsc: (tabId, agentState) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};

      // 解除（claude 終了）: 状態を消して画面パターン判定へ戻す
      if (agentState === null) {
        if (tab.agentState === undefined && tab.agentStateFromSession !== true) return {};
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              agentState: undefined,
              agentStateFromSession: false,
              waitingFor: undefined,
              claudeStatus: undefined,
            },
          },
        };
      }

      // idle への遷移を done に読み替える規則はセッションファイル経由と共通
      const next = applyIdleTransition(tab.agentState, agentState, tabId === state.activeTabId);
      if (tab.agentState === next && tab.agentStateFromSession === true) return {};

      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, agentState: next, agentStateFromSession: true },
        },
      };
    }),

  applyClaudeSessions: (matches) =>
    set((state) => {
      let changed = false;
      const tabs: Record<string, Tab> = {};

      for (const [id, tab] of Object.entries(state.tabs)) {
        // 変更が無ければ元の参照が返るので、それで変更有無を判定する
        const next = tabWithClaudeSession(tab, matches.get(id), id === state.activeTabId);
        tabs[id] = next;
        if (next !== tab) changed = true;
      }

      // 何も変わっていなければ参照ごと据え置く（毎秒の再レンダーを防ぐ）
      return changed ? { tabs } : {};
    }),

  startEditing: (id) => set({ editingId: id }),
  stopEditing: () => set({ editingId: null }),
  setContextMenuOpen: (open) => set({ contextMenuOpen: open }),

  createGroup: (title = 'Default') => {
    const id = newId();
    set((state) => ({
      groups: [...state.groups, { id, title, collapsed: false, tabIds: [] }],
    }));
    return id;
  },

  createTab: (groupId, opts) => {
    const tabId = newId();
    set((state) => {
      const { groupId: resolvedGroupId, groups: newGroups } = resolveTabGroup(state, groupId);
      const tab = buildTab(tabId, resolvedGroupId, opts);

      const updatedGroups = newGroups.map((g) =>
        g.id === resolvedGroupId
          ? { ...g, tabIds: [...g.tabIds, tabId] }
          : g,
      );

      // 折りたたまれたグループに新規タブを追加した場合、UI 上は隠れたまま
      // activeTabId だけ更新されてしまうため、対象グループを展開する。
      // navigateToTab / removeTab フォールバックと同じ整合性。
      return {
        groups: expandGroupContaining(updatedGroups, tabId),
        tabs: { ...state.tabs, [tabId]: tab },
        activeTabId: tabId,
        // 新規タブの所属グループをサイドバーの選択にも反映する
        // (syncGroupSelection は state.tabs を見るため、まだ追加前の tab を直接参照する)
        activeGroupId: resolvedGroupId,
        lastActiveTabByGroup: { ...state.lastActiveTabByGroup, [resolvedGroupId]: tabId },
      };
    });
    return tabId;
  },

  removeTab: (tabId) => {
    // forceDisposeRuntime を set より先に呼ぶ（設計書 §6 参照）
    forceDisposeRuntime(tabId);

    set((state) => {
      const removedTab = state.tabs[tabId];
      if (!removedTab) return {};

      const newGroups = state.groups.map((g) => ({
        ...g,
        tabIds: g.tabIds.filter((id) => id !== tabId),
      }));
      const { [tabId]: _removed, ...newTabs } = state.tabs;
      const newActiveTabId =
        state.activeTabId === tabId
          ? selectFallbackTab(removedTab.groupId, newGroups)
          : state.activeTabId;

      // フォールバック先タブが折りたたみグループ内にあるとき自動展開する
      const finalGroups =
        state.activeTabId === tabId && newActiveTabId !== null
          ? expandGroupContaining(newGroups, newActiveTabId)
          : newGroups;

      // M2: 削除対象タブが編集中だった場合は editingId をクリアする
      const newEditingId = state.editingId === tabId ? null : state.editingId;

      // closedTabs に push（先頭追加、上限 CLOSED_TABS_MAX）
      const closed: ClosedTab = {
        groupId: removedTab.groupId,
        userTitle: removedTab.userTitle,
        shell: removedTab.shell,
        cwd: removedTab.cwd,
        args: removedTab.args ? [...removedTab.args] : undefined,
        env: removedTab.env ? { ...removedTab.env } : undefined,
        // Claude タブ属性とセッション ID を保持し、再オープンで同一セッションを resume する
        launchClaude: removedTab.launchClaude,
        claudeSessionId: removedTab.claudeSessionId,
        bypassPermissions: removedTab.bypassPermissions,
      };
      const newClosedTabs = [closed, ...state.closedTabs].slice(0, CLOSED_TABS_MAX);

      return {
        groups: finalGroups,
        tabs: newTabs,
        activeTabId: newActiveTabId,
        editingId: newEditingId,
        closedTabs: newClosedTabs,
        // フォールバック先が別グループのタブなら選択も移す。
        // グループ内の最後のタブを閉じた場合 (newActiveTabId が null) は
        // syncGroupSelection が空を返し、そのグループの選択が維持される。
        ...syncGroupSelection(newTabs, state.lastActiveTabByGroup, newActiveTabId),
      };
    });
  },

  setTabStatus: (tabId, status, ptyId) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};  // removeTab 後の非同期更新を防ぐ防御コード
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            status,
            ptyId: status === 'live' ? ptyId : undefined,
          },
        },
      };
    });
  },

  updateTabTitle: (tabId, title) => {
    const trimmed = title.trim().slice(0, 64);
    if (trimmed.length === 0) return;  // 空文字列は no-op
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};  // 存在しない tabId は no-op
      return { tabs: { ...state.tabs, [tabId]: { ...tab, userTitle: trimmed } } };
    });
  },

  updateTabOscTitle: (tabId, oscTitle) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};  // 存在しない tabId は no-op
      if (tab.oscTitle === oscTitle) return {};  // 同値 no-op (partialize オーバヘッド回避)
      return { tabs: { ...state.tabs, [tabId]: { ...tab, oscTitle } } };
    }),

  updateTabCwd: (tabId, cwd) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};         // 存在しない tabId は no-op
      if (tab.cwd === cwd) return {};  // 同じ値なら no-op (不要な再レンダーを回避)
      return {
        tabs: { ...state.tabs, [tabId]: { ...tab, cwd } },
      };
    }),

  setClaudeSessionId: (tabId, sessionId) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};                        // 存在しない tabId は no-op
      if (tab.claudeSessionId === sessionId) return {};  // 同値 no-op
      return {
        tabs: { ...state.tabs, [tabId]: { ...tab, claudeSessionId: sessionId } },
      };
    }),

  duplicateTab: (tabId) => {
    // N12: set 外で存在チェックして早期リターン（set コールバック外で読み取り一貫性を確保）
    if (!get().tabs[tabId]) return null;
    const newTabId = newId();
    let inserted = false;

    set((state) => {
      const src = state.tabs[tabId];
      if (!src) return {};

      // getTabDisplayTitle 相当のロジックで表示タイトルを取得して "(copy)" を付加する
      // 空文字列の userTitle は未設定と同様に扱い oscTitle にフォールバックする
      const displayTitle =
        src.userTitle && src.userTitle.length > 0
          ? src.userTitle
          : (src.oscTitle ?? 'Terminal');
      const newTab: Tab = {
        id: newTabId,
        groupId: src.groupId,
        userTitle: `${displayTitle} (copy)`,
        shell: src.shell,
        cwd: src.cwd,
        // F-M3: src.args / src.env を shallow clone して参照を独立させる
        args: src.args ? [...src.args] : undefined,
        env: src.env ? { ...src.env } : undefined,
        // 複製は Claude タブ属性を引き継ぐが、claudeSessionId は引き継がない
        // (複製先は新しい claude セッションとして --session-id で起動させる)
        launchClaude: src.launchClaude,
        bypassPermissions: src.bypassPermissions,
        status: 'spawning',
      };

      // 元タブの直後に挿入
      const updatedGroups = state.groups.map((g) => {
        if (g.id !== src.groupId) return g;
        const idx = g.tabIds.indexOf(tabId);
        const newTabIds = [...g.tabIds];
        if (idx === -1) {
          newTabIds.push(newTabId);
        } else {
          newTabIds.splice(idx + 1, 0, newTabId);
        }
        return { ...g, tabIds: newTabIds };
      });

      inserted = true;
      return {
        groups: updatedGroups,
        tabs: { ...state.tabs, [newTabId]: newTab },
        activeTabId: newTabId,
      };
    });

    return inserted ? newTabId : null;
  },

  removeGroup: (groupId) => {
    set((state) => {
      if (state.groups.length === 1) return {};
      const target = state.groups.find((g) => g.id === groupId);
      if (!target || target.tabIds.length > 0) return {};
      // M2: 削除対象グループが編集中だった場合は editingId をクリアする
      const newEditingId = state.editingId === groupId ? null : state.editingId;
      return { groups: state.groups.filter((g) => g.id !== groupId), editingId: newEditingId };
    });
  },

  updateGroupTitle: (groupId, title) => {
    set((state) => {
      // M2: 存在しない groupId は no-op
      if (!state.groups.some((g) => g.id === groupId)) return {};
      const trimmed = title.trim().slice(0, 64);
      // M2: trim 後が空文字列なら no-op（元タイトル維持）
      if (!trimmed) return {};
      return {
        groups: state.groups.map((g) =>
          g.id === groupId ? { ...g, title: trimmed } : g,
        ),
      };
    });
  },

  toggleCollapse: (groupId) => {
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
      ),
    }));
  },

  moveGroup: (groupId, toIndex) => {
    set((state) => {
      const from = state.groups.findIndex((g) => g.id === groupId);
      if (from === -1) return {};
      const clamped = Math.max(0, Math.min(toIndex, state.groups.length - 1));
      if (from === clamped) return {};
      const next = [...state.groups];
      const [item] = next.splice(from, 1);
      next.splice(clamped, 0, item);
      return { groups: next };
    });
  },

  moveFavorite: (favId, toIndex) => {
    set((state) => {
      const from = state.favorites.findIndex((f) => f.id === favId);
      if (from === -1) return {};
      const clamped = Math.max(0, Math.min(toIndex, state.favorites.length - 1));
      if (from === clamped) return {};
      const next = [...state.favorites];
      const [item] = next.splice(from, 1);
      next.splice(clamped, 0, item);
      return { favorites: next };
    });
  },

  moveTab: (tabId, toGroupId, toIndex) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};

      const fromGroupId = tab.groupId;
      const fromGroup = state.groups.find((g) => g.id === fromGroupId);
      if (!fromGroup) return {}; // race: グループが削除済み

      const toGroup = state.groups.find((g) => g.id === toGroupId);
      if (!toGroup) return {}; // 不正な toGroupId

      // fromGroup から除去した後の toGroup.tabIds を計算する
      // 同一グループ内移動の場合は除去後の長さを基準にクランプする
      const fromTabIds = fromGroup.tabIds.filter((id) => id !== tabId);

      const toTabIdsBase =
        fromGroupId === toGroupId
          ? fromTabIds
          : toGroup.tabIds;

      const clamped = Math.max(0, Math.min(toIndex, toTabIdsBase.length));

      // F5: 同一グループ内で位置が変わらない場合は no-op（参照を変えない）
      if (fromGroupId === toGroupId) {
        const originalIdx = fromGroup.tabIds.indexOf(tabId);
        if (originalIdx === clamped) return {};
      }

      const newToTabIds = [...toTabIdsBase];
      newToTabIds.splice(clamped, 0, tabId);

      const updatedGroups = state.groups.map((g) => {
        if (g.id === fromGroupId && g.id === toGroupId) {
          return { ...g, tabIds: newToTabIds };
        }
        if (g.id === fromGroupId) {
          return { ...g, tabIds: fromTabIds };
        }
        if (g.id === toGroupId) {
          return { ...g, tabIds: newToTabIds };
        }
        return g;
      });

      const updatedTab =
        fromGroupId !== toGroupId
          ? { ...state.tabs, [tabId]: { ...tab, groupId: toGroupId } }
          : state.tabs;

      return { groups: updatedGroups, tabs: updatedTab };
    });
  },

  updateSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),

  setDefaultFavorite: (favId) => {
    set((state) => {
      // null の場合は解除
      if (favId === null) {
        return { settings: { ...state.settings, defaultFavoriteId: undefined } };
      }
      // 存在しない favId は no-op
      if (!state.favorites.some((f) => f.id === favId)) return {};
      return { settings: { ...state.settings, defaultFavoriteId: favId } };
    });
  },

  spawnDefaultOrNew: () => {
    const state = get();
    const { defaultFavoriteId } = state.settings;
    if (defaultFavoriteId) {
      const fav = state.favorites.find((f) => f.id === defaultFavoriteId);
      if (fav) {
        const tabId = state.spawnFavorite(defaultFavoriteId);
        // spawnFavorite は favorite が存在する場合必ず string を返す
        return tabId as string;
      }
    }
    // defaultFavoriteId 未設定 or favorite が削除済 → plain Terminal タブ
    return get().createTab(undefined, { userTitle: 'Terminal' });
  },

  spawnFavoriteByIndex: (index) => {
    const { favorites } = get();
    if (index < 0 || index >= favorites.length) return null;
    return get().spawnFavorite(favorites[index].id);
  },

  setWslDistros: (distros) => set({ wslDistros: distros }),

  setTabAgentState: (tabId, agentState) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};  // 存在しない tabId は no-op
      // Claude 自身が申告した status を持つタブでは、画面パターンによる推測を採用しない。
      // このアクションの呼び出し元は画面判定 (terminalRegistry) だけなので、
      // ここで弾けばセッション由来の状態が推測に上書きされることはない。
      if (tab.agentStateFromSession === true) return {};
      // 'done' は「まだ見ていない完了」を伝える状態。見えているタブでは意味を持たないため
      // 'idle' に落とす。'blocked' は見ていても応答するまで解消しないのでそのまま通す。
      const next: AgentState =
        agentState === 'done' && tabId === state.activeTabId ? 'idle' : agentState;
      if (tab.agentState === next) return {};  // 同値は no-op（不要な再レンダ抑止）
      return { tabs: { ...state.tabs, [tabId]: { ...tab, agentState: next } } };
    }),

  runUpdateCheck: async () => {
    if (get().updatePhase !== 'idle') return;

    set({ updatePhase: 'checking', updateError: null });
    const info = await checkForUpdate();

    if (!info) {
      set({ updatePhase: 'idle', updateInfo: null });
      return;
    }

    // ハンドルをモジュールスコープに退避し、state には含めない
    pendingUpdateHandle = info;
    const { _handle, ...persistableInfo } = info;
    set({ updateInfo: persistableInfo, updatePhase: 'downloading', updateProgress: 0 });

    // 自動でバックグラウンド DL を開始する（ユーザー承認なし）
    try {
      await downloadUpdate(info, (p) => {
        const next = p.ratio ?? -1;
        const prev = get().updateProgress;
        // クオンタイズ (1% 単位): 不明 ↔ 既知の遷移、または 1% 以上変化したときのみ更新
        if ((next < 0 && prev >= 0) || (next >= 0 && prev < 0) || (next >= 0 && Math.abs(next - prev) >= 0.01)) {
          set({ updateProgress: next });
        }
      });
      set({ updatePhase: 'ready' });
    } catch (e) {
      // バックグラウンド失敗はユーザーに見せず idle に戻して次回起動でリトライ (Chrome 流)
      console.warn('[updater] background download failed:', e);
      // DL 中に外部から phase が変更されていた場合は上書きしない
      if (get().updatePhase === 'downloading') {
        pendingUpdateHandle = null;
        set({ updatePhase: 'idle', updateInfo: null, updateProgress: 0 });
      }
    }
  },

  openUpdateDialog: () => set({ updateDialogOpen: true }),

  closeUpdateDialog: () => set({ updateDialogOpen: false }),

  applyUpdate: async () => {
    const phase = get().updatePhase;
    // 再入防止ガード: ready または error のときのみ実行
    if (phase !== 'ready' && phase !== 'error') return;
    if (!pendingUpdateHandle) {
      set({
        updatePhase: 'error',
        updateError: '更新ハンドルが失われました。アプリを再起動してください。',
      });
      return;
    }

    set({ updatePhase: 'installing', updateError: null });

    try {
      await installAndRelaunch(pendingUpdateHandle);
      // relaunch 後は到達しない
    } catch (e) {
      set({
        updatePhase: 'error',
        updateError: (e as Error)?.message ?? String(e),
      });
    }
  },

  resetUpdateError: () => {
    pendingUpdateHandle = null;
    set({
      updatePhase: 'idle',
      updateError: null,
      updateInfo: null,
      updateProgress: 0,
      updateDialogOpen: false,
    });
  },

  restoreLastClosedTab: () => {
    const { closedTabs, groups } = get();
    if (closedTabs.length === 0) return null;
    const closed = closedTabs[0];

    // 元グループの存在チェック → なければ groups[0]
    const targetGroupId = groups.some((g) => g.id === closed.groupId)
      ? closed.groupId
      : groups[0]?.id;

    // createTab を先に呼ぶ (失敗時はスタック保持してリトライ可能にする)
    const newTabId = get().createTab(targetGroupId, {
      userTitle: closed.userTitle,
      shell: closed.shell,
      cwd: closed.cwd,
      args: closed.args ? [...closed.args] : undefined,
      env: closed.env ? { ...closed.env } : undefined,
      launchClaude: closed.launchClaude,
      claudeSessionId: closed.claudeSessionId,
      bypassPermissions: closed.bypassPermissions,
    });
    // 成功後にスタックから pop
    set((s) => ({ closedTabs: s.closedTabs.slice(1) }));
    return newTabId;
  },
    }),
    {
      name: 'racker-terminal',
      version: 4,
      // F-M7: localStorage quota 超過時のエラーを握り潰してアプリをクラッシュさせない
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try { return localStorage.getItem(key); }
          catch (e) { console.error('[racker] persist getItem failed:', e); return null; }
        },
        setItem: (key, value) => {
          try { localStorage.setItem(key, value); }
          catch (e) {
            if (e instanceof DOMException && e.name === 'QuotaExceededError') {
              console.error('[racker] localStorage quota exceeded — persistence disabled until restart');
            } else {
              console.error('[racker] persist setItem failed:', e);
            }
          }
        },
        removeItem: (key) => {
          try { localStorage.removeItem(key); }
          catch (e) { console.error('[racker] persist removeItem failed:', e); }
        },
      })),
      // F-M3: スキーマ migration (v0 → v1: tab.title → tab.userTitle)
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, any>;

        // v0 → v1: tab.title → tab.userTitle に変換
        if (version < 1 && state?.tabs) {
          for (const id of Object.keys(state.tabs)) {
            const tab = state.tabs[id];
            if (tab.title !== undefined && tab.userTitle === undefined) {
              tab.userTitle = tab.title;
              delete tab.title;
            }
          }
        }

        // v1 → v4 は optional フィールドの追加のみでデータ変換が不要なため、分岐を持たない。
        //   v1 → v2: settings.defaultFavoriteId
        //   v2 → v3: Tab.args / Favorite.args
        //   v3 → v4: Tab.launchClaude / Tab.claudeSessionId / Favorite.launchClaude
        // いずれも既存データに含まれなくても undefined のままで正常動作する。

        return state;
      },
      partialize: (state) => ({
        groups: state.groups,
        tabs: Object.fromEntries(
          Object.entries(state.tabs).map(([id, tab]) => [
            id,
            {
              id: tab.id,
              groupId: tab.groupId,
              userTitle: tab.userTitle,   // ユーザー編集タイトルのみ永続化 (oscTitle は保存しない)
              shell: tab.shell,
              cwd: tab.cwd,
              args: tab.args,
              env: tab.env,
              launchClaude: tab.launchClaude,       // Claude タブ属性 (復元対象)
              claudeSessionId: tab.claudeSessionId, // claude セッション ID (resume に使用)
              bypassPermissions: tab.bypassPermissions, // 権限バイパス設定 (復元対象)
              // status / ptyId / oscTitle / agentState は OFF (ランタイム状態)
            },
          ]),
        ),
        favorites: state.favorites,
        settings: state.settings,
        // activeTabId / editingId / contextMenuOpen / wslDistros は OFF
        // updater 系 (updateInfo, updatePhase, updateProgress, updateError, updateDialogOpen)
        // は永続化対象外。再起動時はデフォルト値で初期化される。
        // closedTabs は永続化対象外（再起動でクリア）。
      }),
      // F-M2: 復元時の整合性ガード
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        // 1. group.tabIds から state.tabs に存在しない ID と重複を除去
        state.groups = sanitizeGroupTabIds(state.groups, new Set(Object.keys(state.tabs)));

        // 2. 孤立 tab (どの group の tabIds にも参照されていない) を落としつつ、
        //    status/ptyId をリセットする (一括代入で性能改善)。
        //    oscTitle は partialize 対象外なので保存されないが、念のためクリア不要 (型上も存在しないはず)
        const referenced = new Set(state.groups.flatMap((g) => g.tabIds));
        const newTabs: Record<string, Tab> = {};
        for (const [id, t] of Object.entries(state.tabs)) {
          if (!referenced.has(id)) continue;
          newTabs[id] = { ...t, status: 'spawning', ptyId: undefined };
        }
        state.tabs = newTabs;

        // 3. アクティブ選択を張り直す
        const selection = initialSelection(state.groups);
        state.activeGroupId = selection.activeGroupId;
        state.activeTabId = selection.activeTabId;
        state.lastActiveTabByGroup = selection.lastActiveTabByGroup;

        // ランタイム状態は復元しない
        state.editingId = null;
        state.contextMenuOpen = false;
        state.dragId = null;
        state.dragKind = null;

        // updater 系は永続化対象外のため再起動時にデフォルト値で明示初期化する
        state.updateInfo = null;
        state.updatePhase = 'idle';
        state.updateProgress = 0;
        state.updateError = null;
        state.updateDialogOpen = false;

        // closedTabs は永続化対象外のため再起動時に明示初期化する
        state.closedTabs = [];
      },
    },
  ),
);

