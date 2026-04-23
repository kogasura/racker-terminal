import { create } from 'zustand';
import type { AppState, Settings } from '../types';

// Phase 2 初期の Settings ハードコード値（Phase 3 で設定 UI を足す前提）
const defaultSettings: Settings = {
  shell: undefined,
  theme: 'tokyo-night',
  fontFamily: '"MonaspiceNe NF", "Cascadia Code", "Consolas", monospace',
  fontSize: 12.5,
  scrollback: 10000,
};

/**
 * 最低限のアクション型。Unit D+E で本格拡張する。
 */
interface AppActions {
  // placeholder — Unit D+E で実装
  setActiveTab: (tabId: string | null) => void;
  startEditing: (id: string) => void;
  stopEditing: () => void;
}

type Store = AppState & AppActions;

export const useAppStore = create<Store>((set) => ({
  // 初期状態
  groups: [],
  tabs: {},
  favorites: [],
  activeTabId: null,
  editingId: null,
  settings: defaultSettings,

  // 最小アクション
  setActiveTab: (tabId) => set({ activeTabId: tabId }),
  startEditing: (id) => set({ editingId: id }),
  stopEditing: () => set({ editingId: null }),
}));

// Phase 3 persist partialize の計画コメント:
// persist 対象 ON: groups, tabs[*].{id, groupId, title, shell, cwd, env}, favorites, settings
// persist 対象 OFF: activeTabId, editingId, tabs[*].status, tabs[*].ptyId
// Unit D+E で partialize 実装のコメントを追加予定。
