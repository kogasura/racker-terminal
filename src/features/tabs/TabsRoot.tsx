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
import { createEffectRunner, type EffectDeps } from './effects';
import type { TabsEvent } from './events';
import { initialState, transition, type TabsEffect, type TabsState } from './machine';
import {
  selectSidebar,
  selectTabBar,
  type SidebarViewModel,
  type TabBarViewModel,
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

export function useTabsView(): TabsViewModel {
  const vm = useContext(TabsViewContext);
  if (!vm) throw new Error('useTabsView は TabsRoot の内側でしか使えません。');
  return vm;
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
  const isDraggingTab = useAppStore((s) => s.dragKind === DRAG_KIND.TAB);
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
      <TabsViewContext.Provider value={viewModel}>{children}</TabsViewContext.Provider>
    </EventScope>
  );
}
