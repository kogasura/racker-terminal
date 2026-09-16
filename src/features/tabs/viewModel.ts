/**
 * タブ UI の描画パラメータ。純粋関数。
 *
 * タブのデータ自体はまだ store が持っているため、ここは「store のスナップショットから
 * 描画に要る値だけを取り出す」層になる。データを Mediator 側へ移すときも、
 * 入力の型が変わるだけで View 側は影響を受けない。
 */

import { prBadgeKind, prTooltip } from '../../lib/prStatus';
import {
  getTabDisplayTitle,
  AGENT_STATE_LABEL,
  type AgentState,
  type Tab,
  type TabStatus,
} from '../../types';

const STATUS_DOT_CLASS: Record<TabStatus, string> = {
  live: 'tab-item__status-dot tab-item__status-dot--live',
  spawning: 'tab-item__status-dot tab-item__status-dot--spawning',
  crashed: 'tab-item__status-dot tab-item__status-dot--crashed',
};

/**
 * ステータスドットの class を組み立てる。
 *
 * PTY のライフサイクル (TabStatus) を基底の色とし、Claude タブのエージェント状態を
 * modifier で重ねる。'idle' と未検出 (undefined) は modifier を付けず、
 * 通常のタブと同じ見た目にする (「何も起きていない」ことを装飾で主張しない)。
 *
 * ドラッグプレビュー (DragDropProvider) とも共有するため export している。
 */
export function statusDotClassName(status: TabStatus, agentState?: AgentState): string {
  const base = STATUS_DOT_CLASS[status];
  if (!agentState || agentState === 'idle') return base;
  return `${base} tab-item__status-dot--agent-${agentState}`;
}

/**
 * ステータスドットの tooltip 文言を組み立てる。
 *
 * Claude のセッション情報が取れているタブでは、状態名だけでなく理由まで出す:
 * - 応答待ちなら `waitingFor` ('input needed' 等) を添える
 * - working のうち **シェルコマンド実行中** (`status === 'shell'`) は
 *   表示上 working に統合しているため、ここで区別を補う
 */
export function agentTooltip(
  tab: Pick<Tab, 'agentState' | 'waitingFor' | 'claudeStatus'>,
): string | undefined {
  if (tab.agentState === undefined) return undefined;
  const label = AGENT_STATE_LABEL[tab.agentState];

  if (tab.agentState === 'blocked' && tab.waitingFor !== undefined) {
    return `${label}: ${tab.waitingFor}`;
  }
  if (tab.agentState === 'working' && tab.claudeStatus === 'shell') {
    return `${label}（シェルコマンド）`;
  }
  return label;
}

/** PR バッジ。出さないときは null。 */
export interface PrBadgeViewModel {
  readonly kind: string;
  readonly label: string;
  readonly tooltip: string;
  readonly url: string | undefined;
}

/** タブ 1 個ぶんの描画パラメータ。 */
export interface TabItemViewModel {
  /** タブが実在するか。削除直後などに false になる。 */
  readonly exists: boolean;
  readonly groupId: string;
  readonly title: string;
  readonly statusClass: string;
  readonly statusTooltip: string | undefined;
  readonly isEditing: boolean;
  readonly pr: PrBadgeViewModel | null;
  /** Claude セッションの記録を持っているか (メニュー項目の出し分け)。 */
  readonly hasClaudeSession: boolean;
}

const MISSING_TAB: TabItemViewModel = {
  exists: false,
  groupId: '',
  title: '',
  statusClass: '',
  statusTooltip: undefined,
  isEditing: false,
  pr: null,
  hasClaudeSession: false,
};

export function selectTabItem(tab: Tab | undefined, isEditing: boolean): TabItemViewModel {
  if (!tab) return MISSING_TAB;

  const pr = {
    branch: tab.prBranch ?? '',
    number: tab.prNumber,
    state: tab.prState,
    isDraft: tab.prIsDraft,
  };
  const kind = prBadgeKind(pr);

  return {
    exists: true,
    groupId: tab.groupId,
    title: getTabDisplayTitle(tab),
    statusClass: statusDotClassName(tab.status, tab.agentState),
    statusTooltip: agentTooltip(tab),
    isEditing,
    pr:
      kind === null || tab.prNumber === undefined
        ? null
        : { kind, label: `#${tab.prNumber}`, tooltip: prTooltip(pr), url: tab.prUrl },
    hasClaudeSession: tab.claudeSessionId !== undefined,
  };
}

/** 「別のグループへ移動」サブメニューの行。 */
export interface MoveTargetViewModel {
  readonly groupId: string;
  readonly title: string;
  /** 今いるグループへの移動は no-op なので選ばせない。 */
  readonly disabled: boolean;
}

export function selectMoveTargets(
  groupIds: readonly string[],
  groupTitles: readonly string[],
  currentGroupId: string,
): readonly MoveTargetViewModel[] {
  return groupIds.map((groupId, i) => ({
    groupId,
    title: groupTitles[i] ?? '',
    disabled: groupId === currentGroupId,
  }));
}

/** サイドバー。 */
export interface SidebarViewModel {
  readonly groupIds: readonly string[];
  /** タブをドラッグ中か (「新規グループに追加」エリアの表示に使う)。 */
  readonly isDraggingTab: boolean;
}

/** 横タブバー。 */
export interface TabBarViewModel {
  /**
   * バーごと出すか。
   * グループが 1 つも選択されていない (= グループ自体が無い) ときは出さない。
   * App の初期化がグループを必ず 1 つ作るため、通常は起動直後の一瞬だけ。
   */
  readonly visible: boolean;
  /** 選択中グループに属するタブ。並び順そのまま。 */
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

export function selectSidebar(groupIds: readonly string[], isDraggingTab: boolean): SidebarViewModel {
  return { groupIds, isDraggingTab };
}

export function selectTabBar(
  activeGroupId: string | null,
  tabIds: readonly string[],
  activeTabId: string | null,
): TabBarViewModel {
  return { visible: activeGroupId !== null, tabIds, activeTabId };
}
