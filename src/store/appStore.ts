import { create } from 'zustand';
import type { AppState, Group, Settings, Tab, TabStatus } from '../types';
import { newId } from '../lib/id';
import { forceDisposeRuntime } from '../lib/terminalRegistry';

const defaultSettings: Settings = {
  shell: undefined,
  theme: 'tokyo-night',
  fontFamily: '"MonaspiceNe NF", "Cascadia Code", "Consolas", monospace',
  fontSize: 12.5,
  scrollback: 10000,
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

interface AppActions {
  setActiveTab: (tabId: string | null) => void;
  startEditing: (id: string) => void;
  stopEditing: () => void;

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
   */
  createTab: (
    groupId?: string,
    opts?: Partial<Pick<Tab, 'title' | 'shell' | 'cwd' | 'env'>>,
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
}

type Store = AppState & AppActions;

export const useAppStore = create<Store>()((set) => ({
  groups: [],
  tabs: {},
  favorites: [],
  activeTabId: null,
  editingId: null,
  settings: defaultSettings,

  setActiveTab: (tabId) => set({ activeTabId: tabId }),
  startEditing: (id) => set({ editingId: id }),
  stopEditing: () => set({ editingId: null }),

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
      // groupId の解決:
      //   1. 未指定 or 存在しない groupId → groups[0] を使う
      //   2. groups も空 → Default グループを自動作成
      const existsGroup =
        groupId !== undefined && state.groups.some((g) => g.id === groupId);

      let resolvedGroupId: string;
      let newGroups = state.groups;

      if (existsGroup) {
        // groupId は undefined でないことが確定している
        resolvedGroupId = groupId as string;
      } else if (state.groups.length === 0) {
        // グループが 1 つもない場合は Default グループを自動作成
        const newGroupId = newId();
        newGroups = [{ id: newGroupId, title: 'Default', collapsed: false, tabIds: [] }];
        resolvedGroupId = newGroupId;
      } else {
        // groupId 未指定 or 不正: groups[0] にフォールバック
        resolvedGroupId = state.groups[0].id;
      }

      const tab: Tab = {
        id: tabId,
        groupId: resolvedGroupId,
        title: opts?.title ?? 'Terminal',
        shell: opts?.shell,
        cwd: opts?.cwd,
        env: opts?.env,
        status: 'spawning',
      };

      const updatedGroups = newGroups.map((g) =>
        g.id === resolvedGroupId
          ? { ...g, tabIds: [...g.tabIds, tabId] }
          : g,
      );

      return {
        groups: updatedGroups,
        tabs: { ...state.tabs, [tabId]: tab },
        activeTabId: tabId,
      };
    });
    return tabId;
  },

  removeTab: (tabId) => {
    // forceDisposeRuntime を set より先に呼ぶ（設計書 §6 参照）
    forceDisposeRuntime(tabId);

    set((state) => {
      const removedTab = state.tabs[tabId];
      const newGroups = state.groups.map((g) => ({
        ...g,
        tabIds: g.tabIds.filter((id) => id !== tabId),
      }));
      const { [tabId]: _removed, ...newTabs } = state.tabs;
      const newActiveTabId =
        state.activeTabId === tabId
          ? selectFallbackTab(removedTab?.groupId ?? '', newGroups)
          : state.activeTabId;

      return { groups: newGroups, tabs: newTabs, activeTabId: newActiveTabId };
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

  removeGroup: (groupId) => {
    set((state) => {
      if (state.groups.length === 1) return {};
      const target = state.groups.find((g) => g.id === groupId);
      if (!target || target.tabIds.length > 0) return {};
      return { groups: state.groups.filter((g) => g.id !== groupId) };
    });
  },

  updateGroupTitle: (groupId, title) => {
    const trimmed = title.trim().slice(0, 64);
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, title: trimmed } : g,
      ),
    }));
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
}));

// Phase 3 persist 方針の詳細は src/types/index.ts の AppState JSDoc を参照。
// partialize で OFF にすべきランタイム状態: activeTabId, editingId, tabs[*].status, tabs[*].ptyId
//
// Phase 3 persist 追加時:
//   create<Store>()(persist((set, get) => ({ ... }), {
//     name: 'racker-terminal',
//     partialize: (state) => ({ groups: state.groups, tabs: state.tabs, ... }),
//   }))
// 現状の curried 記法からスムーズに移行できる。

