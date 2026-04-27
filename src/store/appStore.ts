import { create } from 'zustand';
import type { AppState, Favorite, Group, Settings, Tab, TabStatus } from '../types';
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
   * お気に入りの設定で新しいタブを spawn する。
   * - shell / cwd / env を Favorite から引き継ぐ
   * - title は Favorite.defaultTabTitle ?? Favorite.title
   * - 存在しない favId は null を返す
   */
  spawnFavorite: (favId: string) => string | null;
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
   * タブのタイトルを更新する。
   * title は trim され最大 64 文字に切り詰める。
   * 結果が空文字列なら no-op（元タイトル維持）。
   * 存在しない tabId は no-op。
   */
  updateTabTitle: (tabId: string, title: string) => void;

  /**
   * タブを同一グループ内に複製する。
   * - 元タブの groupId / shell / cwd / env を引き継ぐ
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
   * タブを別グループの指定 index に移動する。
   * - fromGroup の tabIds から対象を除去
   * - toGroup の tabIds の toIndex 位置に挿入 (toIndex は [0, toGroup.tabIds.length] にクランプ)
   * - 同一グループ内移動: from 除去 → 同 group 内に再挿入
   * - 不正な tabId / toGroupId は no-op
   * - tab.groupId フィールドも更新
   */
  moveTab: (tabId: string, toGroupId: string, toIndex: number) => void;
}

type Store = AppState & AppActions;

export const useAppStore = create<Store>()((set, get) => ({
  groups: [],
  tabs: {},
  favorites: [],
  activeTabId: null,
  editingId: null,
  contextMenuOpen: false,
  settings: defaultSettings,

  addFavorite: (fav) => {
    const id = newId();
    set((state) => ({
      favorites: [
        ...state.favorites,
        { ...fav, id, env: fav.env ? { ...fav.env } : undefined },
      ],
    }));
    return id;
  },

  removeFavorite: (favId) => {
    set((state) => ({
      favorites: state.favorites.filter((f) => f.id !== favId),
    }));
  },

  spawnFavorite: (favId) => {
    const fav = get().favorites.find((f) => f.id === favId);
    if (!fav) return null;
    const title = fav.defaultTabTitle ?? fav.title;
    return get().createTab(undefined, {
      title,
      shell: fav.shell,
      cwd: fav.cwd,
      env: fav.env,
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),
  navigateToTab: (tabId) =>
    set((state) => ({
      activeTabId: tabId,
      groups: expandGroupContaining(state.groups, tabId),
    })),
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

      // フォールバック先タブが折りたたみグループ内にあるとき自動展開する
      const finalGroups =
        state.activeTabId === tabId && newActiveTabId !== null
          ? expandGroupContaining(newGroups, newActiveTabId)
          : newGroups;

      // M2: 削除対象タブが編集中だった場合は editingId をクリアする
      const newEditingId = state.editingId === tabId ? null : state.editingId;
      return { groups: finalGroups, tabs: newTabs, activeTabId: newActiveTabId, editingId: newEditingId };
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
      return { tabs: { ...state.tabs, [tabId]: { ...tab, title: trimmed } } };
    });
  },

  duplicateTab: (tabId) => {
    // N12: set 外で存在チェックして早期リターン（set コールバック外で読み取り一貫性を確保）
    if (!get().tabs[tabId]) return null;
    const newTabId = newId();
    let inserted = false;

    set((state) => {
      const src = state.tabs[tabId];
      if (!src) return {};

      const newTab: Tab = {
        id: newTabId,
        groupId: src.groupId,
        title: `${src.title} (copy)`,
        shell: src.shell,
        cwd: src.cwd,
        env: src.env,
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

  moveTab: (tabId, toGroupId, toIndex) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return {};
      const toGroup = state.groups.find((g) => g.id === toGroupId);
      if (!toGroup) return {};

      const fromGroupId = tab.groupId;

      // fromGroup から除去した後の toGroup.tabIds を計算する
      // 同一グループ内移動の場合は除去後の長さを基準にクランプする
      const fromTabIds = state.groups
        .find((g) => g.id === fromGroupId)!
        .tabIds.filter((id) => id !== tabId);

      const toTabIdsBase =
        fromGroupId === toGroupId
          ? fromTabIds
          : toGroup.tabIds;

      const clamped = Math.max(0, Math.min(toIndex, toTabIdsBase.length));

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

