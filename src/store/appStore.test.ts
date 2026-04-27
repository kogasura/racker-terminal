import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore, selectFallbackTab, selectNextTabId, selectPrevTabId } from './appStore';
import type { AppState } from '../types';
import * as terminalRegistry from '../lib/terminalRegistry';

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

    // T2-a: 存在しない groupId を渡し、かつ groups が空 → 新規 Default グループ作成 + そこにタブ追加
    it('存在しない groupId を渡し groups が空のとき: 新規 Default グループを作成してタブを追加する', () => {
      const tabId = useAppStore.getState().createTab('non-existent-group-id');

      const state = useAppStore.getState();
      expect(state.groups).toHaveLength(1);
      expect(state.groups[0].title).toBe('Default');
      expect(state.groups[0].tabIds).toContain(tabId);
      expect(state.tabs[tabId]).toBeDefined();
      expect(state.tabs[tabId].groupId).toBe(state.groups[0].id);
    });

    // T2-b: 存在しない groupId を渡し、かつ groups がある → groups[0] にタブ追加
    it('存在しない groupId を渡し groups があるとき: groups[0] にタブを追加する', () => {
      const group0Id = useAppStore.getState().createGroup('FirstGroup');
      useAppStore.getState().createGroup('SecondGroup');

      const tabId = useAppStore.getState().createTab('non-existent-group-id');

      const state = useAppStore.getState();
      // groups[0] のタブに追加される
      expect(state.groups[0].tabIds).toContain(tabId);
      expect(state.tabs[tabId].groupId).toBe(group0Id);
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

    // T2: 存在しない tabId → no-op（例外を投げない）
    it('存在しない tabId を渡しても例外を投げない', () => {
      expect(() =>
        useAppStore.getState().removeTab('non-existent-tab-id'),
      ).not.toThrow();
    });

    // T1: forceDisposeRuntime が set() より先に呼ばれることの検証
    it('forceDisposeRuntime は set より先に呼ばれる（タブがまだ store に残っている状態で呼ばれる）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);

      // forceDisposeRuntime が呼ばれた瞬間の tabs 状態をキャプチャする
      let tabsAtDisposeTime: Record<string, unknown> | undefined;
      vi.mocked(terminalRegistry.forceDisposeRuntime).mockImplementationOnce(() => {
        tabsAtDisposeTime = useAppStore.getState().tabs;
      });

      useAppStore.getState().removeTab(tabId);

      // forceDisposeRuntime 呼び出し時点ではタブがまだ存在する（set より前）
      expect(tabsAtDisposeTime).toBeDefined();
      expect(tabsAtDisposeTime![tabId]).toBeDefined();
      // set 完了後はタブが削除されている
      expect(useAppStore.getState().tabs[tabId]).toBeUndefined();
    });
  });

  // --- removeGroup ---
  describe('removeGroup', () => {
    it('グループが 2 個 + 対象グループの tabIds が空 → 削除される', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      useAppStore.getState().createGroup('G2');

      useAppStore.getState().removeGroup(g1);

      const { groups } = useAppStore.getState();
      expect(groups).toHaveLength(1);
      expect(groups.find((g) => g.id === g1)).toBeUndefined();
    });

    it('グループが 1 個 → no-op', () => {
      const g1 = useAppStore.getState().createGroup('G1');

      useAppStore.getState().removeGroup(g1);

      expect(useAppStore.getState().groups).toHaveLength(1);
    });

    it('対象グループに tabIds がある → no-op', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      useAppStore.getState().createGroup('G2');
      useAppStore.getState().createTab(g1);

      useAppStore.getState().removeGroup(g1);

      expect(useAppStore.getState().groups).toHaveLength(2);
    });

    // T3: 存在しない groupId → no-op（例外を投げない）
    it('存在しない groupId を渡しても例外を投げない', () => {
      useAppStore.getState().createGroup('G1');
      useAppStore.getState().createGroup('G2');

      expect(() =>
        useAppStore.getState().removeGroup('non-existent-group-id'),
      ).not.toThrow();
      expect(useAppStore.getState().groups).toHaveLength(2);
    });
  });

  // --- updateGroupTitle ---
  describe('updateGroupTitle', () => {
    it('通常更新', () => {
      const g1 = useAppStore.getState().createGroup('Old');
      useAppStore.getState().updateGroupTitle(g1, 'New');
      expect(useAppStore.getState().groups[0].title).toBe('New');
    });

    it('trim される', () => {
      const g1 = useAppStore.getState().createGroup('Old');
      useAppStore.getState().updateGroupTitle(g1, '  trimmed  ');
      expect(useAppStore.getState().groups[0].title).toBe('trimmed');
    });

    it('64 文字超は 64 文字に切り詰められる', () => {
      const g1 = useAppStore.getState().createGroup('Old');
      const long = 'a'.repeat(100);
      useAppStore.getState().updateGroupTitle(g1, long);
      expect(useAppStore.getState().groups[0].title).toHaveLength(64);
    });
  });

  // --- toggleCollapse ---
  describe('toggleCollapse', () => {
    it('false → true → false の往復', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      expect(useAppStore.getState().groups[0].collapsed).toBe(false);

      useAppStore.getState().toggleCollapse(g1);
      expect(useAppStore.getState().groups[0].collapsed).toBe(true);

      useAppStore.getState().toggleCollapse(g1);
      expect(useAppStore.getState().groups[0].collapsed).toBe(false);
    });
  });

  // --- moveGroup ---
  describe('moveGroup', () => {
    it('インデックスを入れ替える', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');
      const g3 = useAppStore.getState().createGroup('G3');

      // G1 (index 0) を index 2 に移動 → [G2, G3, G1]
      useAppStore.getState().moveGroup(g1, 2);

      const ids = useAppStore.getState().groups.map((g) => g.id);
      expect(ids).toEqual([g2, g3, g1]);
    });

    it('負のインデックスは 0 にクランプされる', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');

      useAppStore.getState().moveGroup(g2, -5);

      const ids = useAppStore.getState().groups.map((g) => g.id);
      expect(ids).toEqual([g2, g1]);
    });

    it('上限超えのインデックスは groups.length-1 にクランプされる', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');

      useAppStore.getState().moveGroup(g1, 999);

      const ids = useAppStore.getState().groups.map((g) => g.id);
      expect(ids).toEqual([g2, g1]);
    });

    // T1: 追加テスト
    it('同 index 指定 → no-op（配列参照が変わらない）', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');
      void g2;
      const before = useAppStore.getState().groups;

      // g1 は index 0 → 同じ index 0 に移動
      useAppStore.getState().moveGroup(g1, 0);

      const after = useAppStore.getState().groups;
      // no-op なので配列参照が同一のまま
      expect(after).toBe(before);
    });

    it('存在しない groupId → no-op', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      void g1;
      const before = useAppStore.getState().groups;

      useAppStore.getState().moveGroup('non-existent', 0);

      const after = useAppStore.getState().groups;
      expect(after).toBe(before);
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

// --- selectNextTabId / selectPrevTabId ---

/** テスト用に AppState の最小形を組み立てるヘルパー */
function makeState(
  groups: { id: string; tabIds: string[] }[],
  activeTabId: string | null,
): AppState {
  return {
    groups: groups.map((g) => ({ ...g, title: g.id, collapsed: false })),
    tabs: {},
    favorites: [],
    activeTabId,
    editingId: null,
    settings: { theme: 'tokyo-night', fontFamily: 'monospace', fontSize: 12.5, scrollback: 10000 },
  };
}

describe('selectNextTabId', () => {
  it('単一グループ・複数タブ: 順送りする', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2', 't3'] }], 't1');
    expect(selectNextTabId(state)).toBe('t2');
  });

  it('単一グループ・複数タブ: 末尾→先頭でラップする', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2', 't3'] }], 't3');
    expect(selectNextTabId(state)).toBe('t1');
  });

  it('複数グループ・グループ境界をまたいで次のタブへ遷移する', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1', 't2'] }, { id: 'g2', tabIds: ['t3', 't4'] }],
      't2',
    );
    expect(selectNextTabId(state)).toBe('t3');
  });

  it('複数グループ・最後のタブから先頭へラップする', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1', 't2'] }, { id: 'g2', tabIds: ['t3', 't4'] }],
      't4',
    );
    expect(selectNextTabId(state)).toBe('t1');
  });

  it('空グループを途中に含む: 空グループはスキップして次グループへ遷移する', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1'] }, { id: 'g2', tabIds: [] }, { id: 'g3', tabIds: ['t2'] }],
      't1',
    );
    // g2 は空なので g3 の t2 へ
    expect(selectNextTabId(state)).toBe('t2');
  });

  it('activeTabId === null: null を返す', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2'] }], null);
    expect(selectNextTabId(state)).toBeNull();
  });

  it('activeTabId が全タブに見つからない（不正値）: null を返す', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2'] }], 'not-exist');
    expect(selectNextTabId(state)).toBeNull();
  });

  it('タブが 1 個だけ: 自分自身へラップする', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1'] }], 't1');
    expect(selectNextTabId(state)).toBe('t1');
  });
});

describe('selectPrevTabId', () => {
  it('単一グループ・複数タブ: 逆順送りする', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2', 't3'] }], 't3');
    expect(selectPrevTabId(state)).toBe('t2');
  });

  it('単一グループ・複数タブ: 先頭→末尾でラップする', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2', 't3'] }], 't1');
    expect(selectPrevTabId(state)).toBe('t3');
  });

  it('複数グループ・グループ境界をまたいで前のタブへ遷移する', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1', 't2'] }, { id: 'g2', tabIds: ['t3', 't4'] }],
      't3',
    );
    expect(selectPrevTabId(state)).toBe('t2');
  });

  it('複数グループ・先頭タブから末尾へラップする', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1', 't2'] }, { id: 'g2', tabIds: ['t3', 't4'] }],
      't1',
    );
    expect(selectPrevTabId(state)).toBe('t4');
  });

  it('空グループを途中に含む: 空グループはスキップして前グループへ遷移する', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1'] }, { id: 'g2', tabIds: [] }, { id: 'g3', tabIds: ['t2'] }],
      't2',
    );
    // g2 は空なので g1 の t1 へ
    expect(selectPrevTabId(state)).toBe('t1');
  });

  it('activeTabId === null: null を返す', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2'] }], null);
    expect(selectPrevTabId(state)).toBeNull();
  });

  it('activeTabId が全タブに見つからない（不正値）: null を返す', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1', 't2'] }], 'not-exist');
    expect(selectPrevTabId(state)).toBeNull();
  });

  it('タブが 1 個だけ: 自分自身へラップする', () => {
    const state = makeState([{ id: 'g1', tabIds: ['t1'] }], 't1');
    expect(selectPrevTabId(state)).toBe('t1');
  });
});
