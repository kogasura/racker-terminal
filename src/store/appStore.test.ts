import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore, selectFallbackTab } from './appStore';

// forceDisposeRuntime を no-op にしてテストから Tauri IPC を切り離す
vi.mock('../lib/terminalRegistry', () => ({
  forceDisposeRuntime: vi.fn(),
  acquireRuntime: vi.fn(),
  releaseRuntime: vi.fn(),
}));

function resetStore() {
  useAppStore.setState({
    groups: [],
    tabs: {},
    favorites: [],
    activeTabId: null,
    editingId: null,
    settings: {
      theme: 'tokyo-night',
      fontFamily: '"MonaspiceNe NF", monospace',
      fontSize: 12.5,
      scrollback: 10000,
    },
  });
}

describe('appStore', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  // --- createGroup ---
  describe('createGroup', () => {
    it('グループを作成して ID を返す', () => {
      const groupId = useAppStore.getState().createGroup('Work');
      const { groups } = useAppStore.getState();
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(groupId);
      expect(groups[0].title).toBe('Work');
      expect(groups[0].collapsed).toBe(false);
      expect(groups[0].tabIds).toEqual([]);
    });

    it('タイトル未指定時は "Default" になる', () => {
      useAppStore.getState().createGroup();
      expect(useAppStore.getState().groups[0].title).toBe('Default');
    });
  });

  // --- createTab ---
  describe('createTab', () => {
    it('グループを指定してタブを作成する', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'My Tab' });

      const state = useAppStore.getState();
      expect(state.tabs[tabId]).toBeDefined();
      expect(state.tabs[tabId].title).toBe('My Tab');
      expect(state.tabs[tabId].status).toBe('spawning');
      expect(state.tabs[tabId].groupId).toBe(groupId);
      expect(state.groups[0].tabIds).toContain(tabId);
      expect(state.activeTabId).toBe(tabId);
    });

    it('グループ未指定時は groups[0] を使う', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab();

      const state = useAppStore.getState();
      expect(state.tabs[tabId].groupId).toBe(groupId);
      expect(state.groups[0].tabIds).toContain(tabId);
    });

    it('グループ未指定でグループが存在しない場合は自動作成される', () => {
      const tabId = useAppStore.getState().createTab();

      const state = useAppStore.getState();
      expect(state.groups).toHaveLength(1);
      expect(state.tabs[tabId]).toBeDefined();
    });

    it('activeTabId が新しいタブに設定される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tab1 = useAppStore.getState().createTab(groupId);
      const tab2 = useAppStore.getState().createTab(groupId);

      expect(useAppStore.getState().activeTabId).toBe(tab2);
      void tab1;
    });
  });

  // --- removeTab ---
  describe('removeTab', () => {
    it('タブと groups.tabIds から削除する', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);

      useAppStore.getState().removeTab(tabId);

      const state = useAppStore.getState();
      expect(state.tabs[tabId]).toBeUndefined();
      expect(state.groups[0].tabIds).not.toContain(tabId);
    });

    it('アクティブタブ削除後: 同グループの前のタブがアクティブになる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tab1 = useAppStore.getState().createTab(groupId);
      const tab2 = useAppStore.getState().createTab(groupId);

      // tab2 がアクティブ
      useAppStore.getState().removeTab(tab2);

      expect(useAppStore.getState().activeTabId).toBe(tab1);
    });

    it('最後の 1 タブを削除すると activeTabId が null になる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);

      useAppStore.getState().removeTab(tabId);

      expect(useAppStore.getState().activeTabId).toBeNull();
    });

    it('アクティブでないタブを削除しても activeTabId は変わらない', () => {
      const groupId = useAppStore.getState().createGroup();
      const tab1 = useAppStore.getState().createTab(groupId);
      const tab2 = useAppStore.getState().createTab(groupId);
      useAppStore.getState().setActiveTab(tab1);

      useAppStore.getState().removeTab(tab2);

      expect(useAppStore.getState().activeTabId).toBe(tab1);
    });
  });

  // --- setTabStatus ---
  describe('setTabStatus', () => {
    it('spawning → live に変更し ptyId を設定する', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);

      useAppStore.getState().setTabStatus(tabId, 'live', 'pty-123');

      const tab = useAppStore.getState().tabs[tabId];
      expect(tab.status).toBe('live');
      expect(tab.ptyId).toBe('pty-123');
    });

    it('crashed 時は ptyId が undefined になる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);
      useAppStore.getState().setTabStatus(tabId, 'live', 'pty-123');

      useAppStore.getState().setTabStatus(tabId, 'crashed');

      const tab = useAppStore.getState().tabs[tabId];
      expect(tab.status).toBe('crashed');
      expect(tab.ptyId).toBeUndefined();
    });

    it('存在しない tabId に対しては no-op（例外を投げない）', () => {
      expect(() =>
        useAppStore.getState().setTabStatus('non-existent', 'live'),
      ).not.toThrow();
    });
  });
});

// --- selectFallbackTab ---
describe('selectFallbackTab', () => {
  it('同グループに残存タブがある場合: 末尾を返す', () => {
    const groups = [
      { id: 'g1', title: 'G1', collapsed: false, tabIds: ['t1', 't2'] },
    ];
    expect(selectFallbackTab('g1', groups)).toBe('t2');
  });

  it('同グループが空で前グループに残存タブがある場合: 前グループの末尾を返す', () => {
    const groups = [
      { id: 'g0', title: 'G0', collapsed: false, tabIds: ['t0'] },
      { id: 'g1', title: 'G1', collapsed: false, tabIds: [] },
    ];
    expect(selectFallbackTab('g1', groups)).toBe('t0');
  });

  it('前グループが空で後グループに残存タブがある場合: 後グループの先頭を返す', () => {
    const groups = [
      { id: 'g1', title: 'G1', collapsed: false, tabIds: [] },
      { id: 'g2', title: 'G2', collapsed: false, tabIds: ['t2', 't3'] },
    ];
    expect(selectFallbackTab('g1', groups)).toBe('t2');
  });

  it('全グループが空の場合: null を返す', () => {
    const groups = [
      { id: 'g1', title: 'G1', collapsed: false, tabIds: [] },
    ];
    expect(selectFallbackTab('g1', groups)).toBeNull();
  });

  it('存在しない groupId の場合: null を返す', () => {
    const groups = [
      { id: 'g1', title: 'G1', collapsed: false, tabIds: ['t1'] },
    ];
    expect(selectFallbackTab('non-existent', groups)).toBeNull();
  });
});
