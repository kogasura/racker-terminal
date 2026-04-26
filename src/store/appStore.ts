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

export const useAppStore = create<Store>()((set) => ({
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

// Phase 3 persist 方針の詳細は src/types/index.ts の AppState JSDoc を参照。
// partialize で OFF にすべきランタイム状態: activeTabId, editingId, tabs[*].status, tabs[*].ptyId
//
// Phase 3 persist 追加時:
//   create<Store>()(persist((set) => ({ ... }), {
//     name: 'racker-terminal',
//     partialize: (state) => ({ groups: state.groups, tabs: state.tabs, ... }),
//   }))
// 現状の curried 記法からスムーズに移行できる。
