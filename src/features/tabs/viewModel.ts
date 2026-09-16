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
  type Favorite,
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

/** お気に入り 1 件ぶん。 */
export interface FavoriteViewModel {
  readonly favorite: Favorite;
  /** 既定のお気に入り (Ctrl+T で開くもの) か。 */
  readonly isDefault: boolean;
}

/** お気に入り一覧。 */
export interface FavoritesViewModel {
  readonly items: readonly FavoriteViewModel[];
  /** 空のときは案内文を出す。 */
  readonly isEmpty: boolean;
}

export function selectFavorites(
  favorites: readonly Favorite[],
  defaultFavoriteId: string | null | undefined,
): FavoritesViewModel {
  return {
    items: favorites.map((favorite) => ({
      favorite,
      isDefault: favorite.id === defaultFavoriteId,
    })),
    isEmpty: favorites.length === 0,
  };
}

/** タイトルバーの新規タブメニューの 1 行。 */
export interface NewTabMenuItemViewModel {
  readonly favoriteId: string;
  readonly title: string;
  /** 既定のお気に入りだけ塗りつぶしの星にする。 */
  readonly icon: string;
  /** ショートカットの表示。割り当てが無ければ undefined。 */
  readonly shortcut: string | undefined;
}

export interface NewTabMenuViewModel {
  /** お気に入りが 0 件ならセパレータごと出さない。 */
  readonly hasFavorites: boolean;
  readonly items: readonly NewTabMenuItemViewModel[];
}

/** ショートカットが割り当たるのは先頭 9 件まで (Ctrl+Shift+1..9)。 */
const SHORTCUT_LIMIT = 9;

export function selectNewTabMenu(
  favorites: readonly Favorite[],
  defaultFavoriteId: string | null | undefined,
): NewTabMenuViewModel {
  return {
    hasFavorites: favorites.length > 0,
    items: favorites.map((fav, index) => ({
      favoriteId: fav.id,
      title: fav.title,
      icon: fav.id === defaultFavoriteId ? '⭐' : '★',
      shortcut: index < SHORTCUT_LIMIT ? `Ctrl+Shift+${index + 1}` : undefined,
    })),
  };
}

/** グループ 1 行ぶんの描画パラメータ。 */
export interface GroupViewModel {
  /** グループが実在するか。削除直後などに false になる。 */
  readonly exists: boolean;
  readonly title: string;
  readonly tabCount: number;
  /**
   * 配下タブの代表エージェント状態 (優先度: blocked > working > done > idle)。
   * タブ自体がサイドバーに見えないため、グループ単位での集約表示が
   * 「どのフォルダが応答待ちか」を知る唯一の手がかりになる。
   */
  readonly agentState: AgentState | undefined;
  readonly isActive: boolean;
  readonly isEditing: boolean;
  /** 閉じられるか。空のグループで、かつ 2 個以上あるときだけ。 */
  readonly canDelete: boolean;
  /** タブをドラッグ中か (drop ホバーの見た目に使う)。 */
  readonly isDraggingTab: boolean;
}

const MISSING_GROUP: GroupViewModel = {
  exists: false,
  title: '',
  tabCount: 0,
  agentState: undefined,
  isActive: false,
  isEditing: false,
  canDelete: false,
  isDraggingTab: false,
};

export interface GroupSnapshot {
  readonly title: string;
  readonly tabCount: number;
  readonly agentState: AgentState | undefined;
  readonly isActive: boolean;
}

export function selectGroup(
  snapshot: GroupSnapshot | null,
  isEditing: boolean,
  groupCount: number,
  isDraggingTab: boolean,
): GroupViewModel {
  if (!snapshot) return MISSING_GROUP;
  return {
    exists: true,
    title: snapshot.title,
    tabCount: snapshot.tabCount,
    agentState: snapshot.agentState,
    isActive: snapshot.isActive,
    isEditing,
    // 最後の 1 個は残す (グループが 0 になるとタブの置き場が無くなる)
    canDelete: snapshot.tabCount === 0 && groupCount > 1,
    isDraggingTab,
  };
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
