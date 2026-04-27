import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useAppStore,
  selectFallbackTab,
  selectNextTabId,
  selectPrevTabId,
  expandGroupContaining,
} from './appStore';
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
    contextMenuOpen: false,
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

  // --- startEditing / stopEditing ---
  describe('startEditing / stopEditing', () => {
    it('startEditing で editingId が設定され、stopEditing で null になる', () => {
      useAppStore.getState().startEditing('some-id');
      expect(useAppStore.getState().editingId).toBe('some-id');
      useAppStore.getState().stopEditing();
      expect(useAppStore.getState().editingId).toBeNull();
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

    // M2: removeTab 中の editingId クリア
    it('削除対象タブが編集中のとき editingId が null になる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);
      useAppStore.getState().startEditing(tabId);
      expect(useAppStore.getState().editingId).toBe(tabId);

      useAppStore.getState().removeTab(tabId);

      expect(useAppStore.getState().editingId).toBeNull();
    });

    it('編集中でないタブを削除しても editingId は変わらない', () => {
      const groupId = useAppStore.getState().createGroup();
      const tab1 = useAppStore.getState().createTab(groupId);
      const tab2 = useAppStore.getState().createTab(groupId);
      useAppStore.getState().startEditing(tab1);

      useAppStore.getState().removeTab(tab2);

      expect(useAppStore.getState().editingId).toBe(tab1);
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

    // M2: removeGroup 中の editingId クリア
    it('削除対象グループが編集中のとき editingId が null になる', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      useAppStore.getState().createGroup('G2');
      useAppStore.getState().startEditing(g1);
      expect(useAppStore.getState().editingId).toBe(g1);

      useAppStore.getState().removeGroup(g1);

      expect(useAppStore.getState().editingId).toBeNull();
    });

    it('編集中でないグループを削除しても editingId は変わらない', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');
      useAppStore.getState().startEditing(g1);

      useAppStore.getState().removeGroup(g2);

      expect(useAppStore.getState().editingId).toBe(g1);
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

    // M2: 存在しない groupId は no-op
    it('存在しない groupId は no-op（例外を投げない）', () => {
      const g1 = useAppStore.getState().createGroup('Existing');
      const groupsBefore = useAppStore.getState().groups;

      expect(() =>
        useAppStore.getState().updateGroupTitle('non-existent-group', 'New'),
      ).not.toThrow();

      expect(useAppStore.getState().groups).toBe(groupsBefore);
      void g1;
    });

    // M2: 空 trim は no-op（元タイトル維持）
    it('空文字列（trim 後）は no-op（元タイトル維持）', () => {
      const g1 = useAppStore.getState().createGroup('Original');
      useAppStore.getState().updateGroupTitle(g1, '   ');
      expect(useAppStore.getState().groups[0].title).toBe('Original');
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

  // --- updateTabTitle ---
  describe('updateTabTitle', () => {
    it('通常更新', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, 'New');
      expect(useAppStore.getState().tabs[tabId].title).toBe('New');
    });

    it('trim される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, '  trimmed  ');
      expect(useAppStore.getState().tabs[tabId].title).toBe('trimmed');
    });

    it('64 文字超は 64 文字に切り詰められる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, 'a'.repeat(100));
      expect(useAppStore.getState().tabs[tabId].title).toHaveLength(64);
    });

    it('空文字列は no-op（元タイトル維持）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, '   ');
      expect(useAppStore.getState().tabs[tabId].title).toBe('Old');
    });

    it('存在しない tabId は no-op', () => {
      expect(() =>
        useAppStore.getState().updateTabTitle('non-existent', 'New'),
      ).not.toThrow();
    });
  });

  // --- duplicateTab ---
  describe('duplicateTab', () => {
    it('同一グループに新タブが追加される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Original' });
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      expect(newTabId).not.toBeNull();
      const state = useAppStore.getState();
      expect(state.tabs[newTabId!]).toBeDefined();
      expect(state.groups[0].tabIds).toContain(newTabId);
    });

    it('title に " (copy)" が付与される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Terminal' });
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      expect(useAppStore.getState().tabs[newTabId!].title).toBe('Terminal (copy)');
    });

    it('shell / cwd / env が引き継がれる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, {
        title: 'T',
        shell: 'nu',
        cwd: '/home/user',
        env: { FOO: 'bar' },
      });
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      const newTab = useAppStore.getState().tabs[newTabId!];
      expect(newTab.shell).toBe('nu');
      expect(newTab.cwd).toBe('/home/user');
      expect(newTab.env).toEqual({ FOO: 'bar' });
    });

    it('status は "spawning" になる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });
      useAppStore.getState().setTabStatus(tabId, 'live', 'pty-1');
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      expect(useAppStore.getState().tabs[newTabId!].status).toBe('spawning');
    });

    it('元タブの直後に挿入される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tab1 = useAppStore.getState().createTab(groupId, { title: 'A' });
      const tab2 = useAppStore.getState().createTab(groupId, { title: 'B' });
      // tab1 の直後に複製を挿入 → [tab1, copy, tab2]
      const copyId = useAppStore.getState().duplicateTab(tab1);
      const tabIds = useAppStore.getState().groups[0].tabIds;
      expect(tabIds[0]).toBe(tab1);
      expect(tabIds[1]).toBe(copyId);
      expect(tabIds[2]).toBe(tab2);
    });

    it('存在しない tabId は null を返す', () => {
      const result = useAppStore.getState().duplicateTab('non-existent');
      expect(result).toBeNull();
    });
  });

  // --- addFavorite ---
  describe('addFavorite', () => {
    it('お気に入りを追加して id を返す', () => {
      const id = useAppStore.getState().addFavorite({ title: 'MyFav', shell: 'nu', cwd: '/home', env: { FOO: 'bar' } });
      const { favorites } = useAppStore.getState();
      expect(favorites).toHaveLength(1);
      expect(favorites[0].id).toBe(id);
      expect(favorites[0].title).toBe('MyFav');
      expect(favorites[0].shell).toBe('nu');
      expect(favorites[0].cwd).toBe('/home');
      expect(favorites[0].env).toEqual({ FOO: 'bar' });
    });

    it('同一 title でも別 id が発行される', () => {
      const id1 = useAppStore.getState().addFavorite({ title: 'SameName' });
      const id2 = useAppStore.getState().addFavorite({ title: 'SameName' });
      expect(id1).not.toBe(id2);
      expect(useAppStore.getState().favorites).toHaveLength(2);
    });
  });

  // --- removeFavorite ---
  describe('removeFavorite', () => {
    it('指定した favId のお気に入りを削除する', () => {
      const id = useAppStore.getState().addFavorite({ title: 'ToRemove' });
      useAppStore.getState().removeFavorite(id);
      expect(useAppStore.getState().favorites).toHaveLength(0);
    });

    it('存在しない favId は no-op（例外を投げない）', () => {
      useAppStore.getState().addFavorite({ title: 'Existing' });
      expect(() => useAppStore.getState().removeFavorite('non-existent-fav')).not.toThrow();
      expect(useAppStore.getState().favorites).toHaveLength(1);
    });
  });

  // --- spawnFavorite ---
  describe('spawnFavorite', () => {
    it('有効な favId で新タブが追加される（status=spawning）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'DevFav', shell: 'nu', cwd: '/dev', env: { X: '1' } });
      const tabId = useAppStore.getState().spawnFavorite(favId);

      expect(tabId).not.toBeNull();
      const tab = useAppStore.getState().tabs[tabId!];
      expect(tab).toBeDefined();
      expect(tab.status).toBe('spawning');
    });

    it('shell / cwd / env が Favorite から引き継がれる', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'DevFav', shell: 'nu', cwd: '/dev', env: { X: '1' } });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      const tab = useAppStore.getState().tabs[tabId!];
      expect(tab.shell).toBe('nu');
      expect(tab.cwd).toBe('/dev');
      expect(tab.env).toEqual({ X: '1' });
    });

    it('title は defaultTabTitle ?? title を使う（defaultTabTitle あり）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'FavName', defaultTabTitle: 'CustomTab' });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      expect(useAppStore.getState().tabs[tabId!].title).toBe('CustomTab');
    });

    it('title は defaultTabTitle ?? title を使う（defaultTabTitle なし）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'FavName' });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      expect(useAppStore.getState().tabs[tabId!].title).toBe('FavName');
    });

    it('存在しない favId は null を返す', () => {
      const result = useAppStore.getState().spawnFavorite('non-existent-fav');
      expect(result).toBeNull();
    });
  });

  // --- setContextMenuOpen ---
  describe('setContextMenuOpen', () => {
    it('true / false を切り替えられる', () => {
      expect(useAppStore.getState().contextMenuOpen).toBe(false);
      useAppStore.getState().setContextMenuOpen(true);
      expect(useAppStore.getState().contextMenuOpen).toBe(true);
      useAppStore.getState().setContextMenuOpen(false);
      expect(useAppStore.getState().contextMenuOpen).toBe(false);
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
    contextMenuOpen: false,
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

// --- expandGroupContaining (純関数) ---

describe('expandGroupContaining', () => {
  const makeGroups = (groups: { id: string; tabIds: string[]; collapsed: boolean }[]) =>
    groups.map((g) => ({ ...g, title: g.id }));

  it('tabId が null: groups をそのまま返す', () => {
    const groups = makeGroups([{ id: 'g1', tabIds: ['t1'], collapsed: true }]);
    expect(expandGroupContaining(groups, null)).toBe(groups);
  });

  it('tabId が見つからない: groups をそのまま返す', () => {
    const groups = makeGroups([{ id: 'g1', tabIds: ['t1'], collapsed: true }]);
    expect(expandGroupContaining(groups, 'not-exist')).toBe(groups);
  });

  it('tabId のグループが折りたたまれていない: groups をそのまま返す', () => {
    const groups = makeGroups([{ id: 'g1', tabIds: ['t1'], collapsed: false }]);
    expect(expandGroupContaining(groups, 't1')).toBe(groups);
  });

  it('tabId のグループが折りたたみ中: 該当グループのみ collapsed=false にした新配列を返す', () => {
    const groups = makeGroups([
      { id: 'g1', tabIds: ['t1'], collapsed: true },
      { id: 'g2', tabIds: ['t2'], collapsed: true },
    ]);
    const result = expandGroupContaining(groups, 't2');
    expect(result[0].collapsed).toBe(true); // g1 は不変
    expect(result[1].collapsed).toBe(false); // g2 は展開
    expect(result).not.toBe(groups);
  });
});

// --- navigateToTab (Ctrl+Tab で隠れタブにジャンプしないことの保証) ---

describe('navigateToTab', () => {
  beforeEach(() => {
    useAppStore.setState({
      groups: [],
      tabs: {},
      favorites: [],
      activeTabId: null,
      editingId: null,
      contextMenuOpen: false,
      settings: {
        theme: 'tokyo-night',
        fontFamily: '"MonaspiceNe NF", monospace',
        fontSize: 12.5,
        scrollback: 10000,
      },
    });
    vi.clearAllMocks();
  });

  it('折りたたみグループのタブに遷移するとそのグループが展開される', () => {
    const g1 = useAppStore.getState().createGroup('G1');
    const g2 = useAppStore.getState().createGroup('G2');
    useAppStore.getState().createTab(g1, { title: 'A' });
    const t2 = useAppStore.getState().createTab(g2, { title: 'B' });
    useAppStore.getState().toggleCollapse(g2); // g2 を折りたたみ

    const before = useAppStore.getState().groups.find((g) => g.id === g2);
    expect(before?.collapsed).toBe(true);

    useAppStore.getState().navigateToTab(t2);

    const after = useAppStore.getState();
    expect(after.activeTabId).toBe(t2);
    expect(after.groups.find((g) => g.id === g2)?.collapsed).toBe(false);
  });

  it('折りたたみでないグループのタブ遷移は active のみ更新', () => {
    const g1 = useAppStore.getState().createGroup('G1');
    useAppStore.getState().createTab(g1, { title: 'A' });
    const t2 = useAppStore.getState().createTab(g1, { title: 'B' });

    const groupsBefore = useAppStore.getState().groups;
    useAppStore.getState().navigateToTab(t2);

    const after = useAppStore.getState();
    expect(after.activeTabId).toBe(t2);
    expect(after.groups).toBe(groupsBefore); // 参照変化なし
  });
});

// --- removeTab fallback で折りたたみグループを自動展開 ---

describe('removeTab — fallback expand', () => {
  beforeEach(() => {
    useAppStore.setState({
      groups: [],
      tabs: {},
      favorites: [],
      activeTabId: null,
      editingId: null,
      contextMenuOpen: false,
      settings: {
        theme: 'tokyo-night',
        fontFamily: '"MonaspiceNe NF", monospace',
        fontSize: 12.5,
        scrollback: 10000,
      },
    });
    vi.clearAllMocks();
  });

  it('active タブを削除した結果フォールバックが折りたたみグループ内なら自動展開', () => {
    const g1 = useAppStore.getState().createGroup('G1');
    const g2 = useAppStore.getState().createGroup('G2');
    useAppStore.getState().createTab(g2, { title: 'B' }); // g2/t-B
    const tA = useAppStore.getState().createTab(g1, { title: 'A' });
    useAppStore.getState().setActiveTab(tA);
    useAppStore.getState().toggleCollapse(g2); // g2 を折りたたむ

    expect(useAppStore.getState().groups.find((g) => g.id === g2)?.collapsed).toBe(true);

    useAppStore.getState().removeTab(tA); // tA を削除 → fallback は g2 内タブ

    const after = useAppStore.getState();
    expect(after.activeTabId).not.toBeNull();
    expect(after.groups.find((g) => g.id === g2)?.collapsed).toBe(false);
  });
});
