/**
 * タブ操作の Root。
 *
 * `UpdaterRoot` と同じ形で、Mediator の保持・チェーンの組み立て・View モデルの配布を
 * 担います。`tabs/` 宛てのイベントだけを自分の Mediator に渡し、それ以外は上へ流すので、
 * Root どうしは自由に入れ子にできます。
 */

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { EventScope, mediatorLink, type Link } from '../../architecture/chain';
import { createMachine, type Machine } from '../../architecture/machine';
import { DRAG_KIND } from '../../lib/dndResolve';
import { useAppStore } from '../../store/appStore';
import { dominantAgentState, getTabDisplayTitle } from '../../types';
import { createEffectRunner, type EffectDeps } from './effects';
import type { TabsEvent } from './events';
import { initialState, transition, type TabsEffect, type TabsState } from './machine';
import {
  EMPTY_DRAG_OVERLAY,
  selectFavorites,
  selectGroup,
  selectNewTabMenu,
  selectMoveTargets,
  selectSidebar,
  selectTabBar,
  selectTabItem,
  statusDotClassName,
  type DragOverlayViewModel,
  type FavoritesViewModel,
  type GroupViewModel,
  type NewTabMenuViewModel,
  type MoveTargetViewModel,
  type SidebarViewModel,
  type TabBarViewModel,
  type TabItemViewModel,
} from './viewModel';

export interface TabsViewModel {
  /**
   * キーコマンドが今は止まっているか。
   *
   * View 側でこれを見るのは、xterm の `attachCustomKeyEventHandler` に返す値を
   * 決めるためだけです (止まっている間は `preventDefault` せず xterm に通常処理させる)。
   * コマンドを実行するかどうかの裁定は Mediator が持っていて、View の判断ではありません。
   */
  readonly commandsSuspended: boolean;
  readonly sidebar: SidebarViewModel;
  readonly tabBar: TabBarViewModel;
}

const TabsViewContext = createContext<TabsViewModel | null>(null);

/**
 * Mediator そのものを配るコンテキスト。
 *
 * View モデルとは別に持つのは、購読の粒度を分けるため。ここから
 * `useSyncExternalStore` で個別に購読すれば、関係のない状態変化で
 * 描き直されずに済む。
 */
const TabsMachineContext = createContext<Machine<TabsState, TabsEvent> | null>(null);

/** Mediator の現在の状態を購読する。 */
export function useTabsMachineState(): TabsState {
  const machine = useContext(TabsMachineContext);
  if (!machine) throw new Error('useTabsMachineState は TabsRoot の内側でしか使えません。');
  return useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);
}

/** タブを掴んでいる最中か (drop ホバーの見た目、「新規グループに追加」エリアの表示)。 */
function useIsDraggingTab(): boolean {
  return useTabsMachineState().drag?.kind === DRAG_KIND.TAB;
}

export function useTabsView(): TabsViewModel {
  const vm = useContext(TabsViewContext);
  if (!vm) throw new Error('useTabsView は TabsRoot の内側でしか使えません。');
  return vm;
}

/**
 * タブ 1 個ぶんの描画パラメータ。
 *
 * 一覧ぶんをまとめて Root から配ると、1 タブの変化で全タブが再描画される。
 * ここだけは tabId で引く形にして、変わったタブだけが描き直されるようにしている
 * (移行前のコンポーネントが個別 subscribe していたのと同じ性質)。
 *
 * View から見れば「Root から降ってくる View モデル」であることに変わりはなく、
 * store の形も、そこから何を導くかも知らないままでいられる。
 */
export function useTabItemView(tabId: string): TabItemViewModel {
  const tab = useAppStore((s) => s.tabs[tabId]);
  // boolean だけ subscribe することで、自分以外の editingId 変化では再描画されない
  const isEditing = useAppStore((s) => s.editingId === tabId);
  return useMemo(() => selectTabItem(tab, isEditing), [tab, isEditing]);
}

/**
 * お気に入り一覧の描画パラメータ。
 *
 * 一覧はサイドバーに 1 つしか無いので、tabId のように引数で絞る必要はない。
 */
export function useFavoritesView(): FavoritesViewModel {
  const favorites = useAppStore(useShallow((s) => s.favorites));
  const defaultFavoriteId = useAppStore((s) => s.settings.defaultFavoriteId);
  return useMemo(() => selectFavorites(favorites, defaultFavoriteId), [favorites, defaultFavoriteId]);
}

/**
 * ドラッグプレビュー。
 *
 * 何を掴んでいるかは Mediator の状態、表示に要る中身は store から拾う。
 * Tab オブジェクト全体を返すと OSC タイトル更新などで描き直され、DndContext の
 * 当たり判定が走り直すので、必要な値だけを取り出す。
 */
export function useDragOverlayView(): DragOverlayViewModel {
  const drag = useTabsMachineState().drag;
  const dragId = drag?.dragId ?? null;
  const kind = drag?.kind ?? null;

  const tab = useAppStore(
    useShallow((s) => {
      if (!dragId || kind !== DRAG_KIND.TAB) return null;
      const t = s.tabs[dragId];
      if (!t) return null;
      return {
        displayTitle: getTabDisplayTitle(t),
        statusClass: statusDotClassName(t.status, t.agentState),
      };
    }),
  );

  const groupTitle = useAppStore((s) => {
    if (!dragId || kind !== DRAG_KIND.GROUP) return null;
    return s.groups.find((g) => g.id === dragId)?.title ?? null;
  });

  const favoriteTitle = useAppStore((s) => {
    if (!dragId || kind !== DRAG_KIND.FAVORITE) return null;
    return s.favorites.find((f) => f.id === dragId)?.title ?? null;
  });

  return useMemo(() => {
    if (!dragId) return EMPTY_DRAG_OVERLAY;
    return { tab, groupTitle, favoriteTitle };
  }, [dragId, tab, groupTitle, favoriteTitle]);
}

/** タイトルバーの新規タブメニュー。 */
export function useNewTabMenuView(): NewTabMenuViewModel {
  const favorites = useAppStore(useShallow((s) => s.favorites));
  const defaultFavoriteId = useAppStore((s) => s.settings.defaultFavoriteId);
  return useMemo(
    () => selectNewTabMenu(favorites, defaultFavoriteId),
    [favorites, defaultFavoriteId],
  );
}

/**
 * グループ 1 行ぶんの描画パラメータ。
 *
 * タブと同じく groupId で引く。一覧ぶんをまとめて配ると、1 グループの変化で
 * 全グループが描き直されるため。
 */
export function useGroupView(groupId: string): GroupViewModel {
  // 必要なフィールドだけ抽出する (他グループの変化で描き直されないように)
  const snapshot = useAppStore(
    useShallow((s) => {
      const g = s.groups.find((x) => x.id === groupId);
      if (!g) return null;
      return {
        title: g.title,
        tabCount: g.tabIds.length,
        agentState: dominantAgentState(g.tabIds.map((id) => s.tabs[id]?.agentState)),
        isActive: s.activeGroupId === groupId,
      };
    }),
  );
  // boolean だけ subscribe することで、自分以外の editingId 変化では描き直されない
  const isEditing = useAppStore((s) => s.editingId === groupId);
  const groupCount = useAppStore((s) => s.groups.length);
  const isDraggingTab = useIsDraggingTab();

  return useMemo(
    () => selectGroup(snapshot, isEditing, groupCount, isDraggingTab),
    [snapshot, isEditing, groupCount, isDraggingTab],
  );
}

/**
 * 「別のグループへ移動」サブメニューの行。
 *
 * 右クリックでメニューを開いたときだけ呼ばれる。タブ本体でグループ一覧を
 * subscribe すると、全タブがグループのタイトル変更で再描画されてしまう。
 */
export function useMoveTargetsView(currentGroupId: string): readonly MoveTargetViewModel[] {
  // id / title を別々に subscribe する。
  // オブジェクトの配列にすると useShallow の要素比較が毎回 false になる。
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupTitles = useAppStore(useShallow((s) => s.groups.map((g) => g.title)));
  return useMemo(
    () => selectMoveTargets(groupIds, groupTitles, currentGroupId),
    [groupIds, groupTitles, currentGroupId],
  );
}

/** 開発時にイベントの流れを追えるようにするリンク。何も消費しない。 */
const traceLink: Link<TabsEvent> = (event, next) => {
  if (import.meta.env.DEV) console.debug('[tabs] event:', event.type);
  next(event);
};

export interface TabsRootProps {
  readonly children: ReactNode;
  /** テスト用の差し替え。 */
  readonly deps?: EffectDeps;
}

export function TabsRoot({ children, deps }: TabsRootProps) {
  const machineRef = useRef<Machine<TabsState, TabsEvent> | null>(null);
  if (!machineRef.current) {
    machineRef.current = createMachine<TabsState, TabsEvent, TabsEffect>({
      initial: initialState,
      transition,
      run: createEffectRunner(deps),
    });
  }
  const machine = machineRef.current;

  const state = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);

  const links = useMemo<readonly Link<TabsEvent>[]>(
    () => [traceLink, mediatorLink('tabs/', (event) => machine.send(event))],
    [machine],
  );

  // タブのデータはまだ store にあるので、ここで拾って View モデルに畳む。
  // 配列は useShallow で中身比較し、変わっていなければ参照を据え置く
  // (毎回作り直すと memo した View が素通しで再描画される)。
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const isDraggingTab = state.drag?.kind === DRAG_KIND.TAB;
  const activeGroupId = useAppStore((s) => s.activeGroupId);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabIds = useAppStore(
    useShallow((s) => s.groups.find((g) => g.id === activeGroupId)?.tabIds ?? []),
  );

  const viewModel = useMemo<TabsViewModel>(
    () => ({
      commandsSuspended: state.input === 'suspended',
      sidebar: selectSidebar(groupIds, isDraggingTab),
      tabBar: selectTabBar(activeGroupId, tabIds, activeTabId),
    }),
    [state, groupIds, isDraggingTab, activeGroupId, tabIds, activeTabId],
  );

  return (
    <EventScope<TabsEvent> links={links}>
      <TabsMachineContext.Provider value={machine}>
        <TabsViewContext.Provider value={viewModel}>{children}</TabsViewContext.Provider>
      </TabsMachineContext.Provider>
    </EventScope>
  );
}
