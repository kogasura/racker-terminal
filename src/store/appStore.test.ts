import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useAppStore,
  selectFallbackTab,
  selectNextTabId,
  selectPrevTabId,
  expandGroupContaining,
} from './appStore';
import { SPAWN_TIMEOUT_MS } from '../components/TerminalPane';
import type { AppState } from '../types';
import { getTabDisplayTitle } from '../types';
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
      expect(state.tabs[tabId].userTitle).toBe('My Tab');
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
    it('通常更新: userTitle が更新される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, 'New');
      expect(useAppStore.getState().tabs[tabId].userTitle).toBe('New');
    });

    it('trim される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, '  trimmed  ');
      expect(useAppStore.getState().tabs[tabId].userTitle).toBe('trimmed');
    });

    it('64 文字超は 64 文字に切り詰められる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, 'a'.repeat(100));
      expect(useAppStore.getState().tabs[tabId].userTitle).toHaveLength(64);
    });

    it('空文字列は no-op（userTitle が変わらない）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Old' });
      useAppStore.getState().updateTabTitle(tabId, '   ');
      expect(useAppStore.getState().tabs[tabId].userTitle).toBe('Old');
    });

    it('存在しない tabId は no-op', () => {
      expect(() =>
        useAppStore.getState().updateTabTitle('non-existent', 'New'),
      ).not.toThrow();
    });
  });

  // --- updateTabOscTitle ---
  describe('updateTabOscTitle', () => {
    it('oscTitle が更新される', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });
      useAppStore.getState().updateTabOscTitle(tabId, 'osc-title');
      expect(useAppStore.getState().tabs[tabId].oscTitle).toBe('osc-title');
    });

    it('userTitle は変わらない', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'UserTitle' });
      useAppStore.getState().updateTabOscTitle(tabId, 'osc-title');
      expect(useAppStore.getState().tabs[tabId].userTitle).toBe('UserTitle');
      expect(useAppStore.getState().tabs[tabId].oscTitle).toBe('osc-title');
    });

    it('存在しない tabId は no-op（例外を投げない）', () => {
      expect(() =>
        useAppStore.getState().updateTabOscTitle('non-existent', 'title'),
      ).not.toThrow();
    });
  });

  // --- updateTabCwd ---
  describe('updateTabCwd', () => {
    it('通常更新: cwd が新しい値に変わる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'T', cwd: 'C:\\old' });
      useAppStore.getState().updateTabCwd(tabId, 'C:\\new');
      expect(useAppStore.getState().tabs[tabId].cwd).toBe('C:\\new');
    });

    it('同じ値なら no-op（tabs 参照が変わらない）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'T', cwd: 'C:\\same' });
      const tabsBefore = useAppStore.getState().tabs;
      useAppStore.getState().updateTabCwd(tabId, 'C:\\same');
      expect(useAppStore.getState().tabs).toBe(tabsBefore);
    });

    it('存在しない tabId は no-op（例外を投げない）', () => {
      expect(() =>
        useAppStore.getState().updateTabCwd('non-existent', 'C:\\path'),
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

    it('userTitle に " (copy)" が付与される（元の表示タイトルを引き継ぐ）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'Terminal' });
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      expect(useAppStore.getState().tabs[newTabId!].userTitle).toBe('Terminal (copy)');
    });

    it('userTitle が未設定・oscTitle あり: oscTitle + " (copy)" になる', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId);
      // oscTitle のみ設定
      useAppStore.getState().updateTabOscTitle(tabId, 'OscTab');
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      expect(useAppStore.getState().tabs[newTabId!].userTitle).toBe('OscTab (copy)');
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

    // F-M3: duplicateTab で env が shallow clone される
    it('F-M3: env はシャローコピーされる（元タブの env を変更しても複製タブに影響しない）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, {
        title: 'Original',
        env: { FOO: 'original' },
      });
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      // 元タブの env を直接 setState で変更
      useAppStore.setState((s) => ({
        tabs: {
          ...s.tabs,
          [tabId]: { ...s.tabs[tabId], env: { FOO: 'mutated' } },
        },
      }));
      // 複製タブの env は変更前の値を保持する
      const newTab = useAppStore.getState().tabs[newTabId!];
      expect(newTab.env?.FOO).toBe('original');
    });

    it('F-M3: env が undefined の場合は undefined のまま（クラッシュしない）', () => {
      const groupId = useAppStore.getState().createGroup();
      const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });
      const newTabId = useAppStore.getState().duplicateTab(tabId);
      expect(useAppStore.getState().tabs[newTabId!].env).toBeUndefined();
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

  // --- addFavorite (env シャローコピー) ---
  describe('addFavorite (env shallow copy)', () => {
    it('T3: env はシャローコピーされる（元の参照と独立）', () => {
      const env = { FOO: 'bar' };
      const id = useAppStore.getState().addFavorite({ title: 'X', env });
      // 元オブジェクトを変更
      env.FOO = 'changed';
      const fav = useAppStore.getState().favorites.find((f) => f.id === id);
      // ストア内の env は変更前の値を保持する
      expect(fav?.env?.FOO).toBe('bar');
    });

    it('T3-2: env が undefined の場合は undefined のまま（クラッシュしない）', () => {
      const id = useAppStore.getState().addFavorite({ title: 'Y' });
      const fav = useAppStore.getState().favorites.find((f) => f.id === id);
      expect(fav?.env).toBeUndefined();
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

  // --- updateFavorite ---
  describe('updateFavorite', () => {
    it('通常更新: 内容が新しい値に変わる', () => {
      const id = useAppStore.getState().addFavorite({ title: 'Old', shell: 'nu', cwd: 'C:\\old' });
      useAppStore.getState().updateFavorite(id, { title: 'New', shell: 'pwsh.exe', cwd: 'C:\\new' });
      const fav = useAppStore.getState().favorites.find((f) => f.id === id);
      expect(fav?.title).toBe('New');
      expect(fav?.shell).toBe('pwsh.exe');
      expect(fav?.cwd).toBe('C:\\new');
    });

    it('存在しない favId は no-op（例外を投げない）', () => {
      useAppStore.getState().addFavorite({ title: 'Existing' });
      const favoritesBefore = useAppStore.getState().favorites;
      expect(() =>
        useAppStore.getState().updateFavorite('non-existent-fav', { title: 'Changed' }),
      ).not.toThrow();
      expect(useAppStore.getState().favorites).toBe(favoritesBefore);
    });

    it('id が変わらないこと', () => {
      const id = useAppStore.getState().addFavorite({ title: 'Original' });
      useAppStore.getState().updateFavorite(id, { title: 'Updated' });
      const fav = useAppStore.getState().favorites.find((f) => f.id === id);
      expect(fav?.id).toBe(id);
    });

    // F-M4: updateFavorite で env が shallow clone される
    it('F-M4: env はシャローコピーされる（patch.env を変更してもストア内に影響しない）', () => {
      const id = useAppStore.getState().addFavorite({ title: 'X' });
      const patchEnv = { MY_VAR: 'original' };
      useAppStore.getState().updateFavorite(id, { title: 'X', env: patchEnv });
      // patch.env を変更
      patchEnv.MY_VAR = 'changed';
      const fav = useAppStore.getState().favorites.find((f) => f.id === id);
      // ストア内の env は変更前の値を保持する
      expect(fav?.env?.MY_VAR).toBe('original');
    });

    it('F-M4: env が undefined の場合は undefined のまま（クラッシュしない）', () => {
      const id = useAppStore.getState().addFavorite({ title: 'Y' });
      useAppStore.getState().updateFavorite(id, { title: 'Y' });
      const fav = useAppStore.getState().favorites.find((f) => f.id === id);
      expect(fav?.env).toBeUndefined();
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

    it('userTitle は defaultTabTitle ?? title を使う（defaultTabTitle あり）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'FavName', defaultTabTitle: 'CustomTab' });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      expect(useAppStore.getState().tabs[tabId!].userTitle).toBe('CustomTab');
    });

    it('userTitle は defaultTabTitle ?? title を使う（defaultTabTitle なし）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'FavName' });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      expect(useAppStore.getState().tabs[tabId!].userTitle).toBe('FavName');
    });

    it('存在しない favId は null を返す', () => {
      const result = useAppStore.getState().spawnFavorite('non-existent-fav');
      expect(result).toBeNull();
    });

    // F-M2: spawnFavorite で env が shallow clone される
    it('F-M2: env はシャローコピーされる（fav.env を変更しても spawn 後タブに影響しない）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'X', env: { KEY: 'val' } });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      // spawn 後に fav.env を直接変更（ストア上の fav を変更してタブへの影響を確認）
      // favorites から fav を取得して env を上書きする
      useAppStore.setState((s) => ({
        favorites: s.favorites.map((f) =>
          f.id === favId ? { ...f, env: { KEY: 'mutated' } } : f,
        ),
      }));
      // 既に作成されたタブの env は変更前の値を保持する
      const tab = useAppStore.getState().tabs[tabId!];
      expect(tab.env?.KEY).toBe('val');
    });

    it('F-M2: env が undefined の場合は undefined のまま（クラッシュしない）', () => {
      useAppStore.getState().createGroup();
      const favId = useAppStore.getState().addFavorite({ title: 'Y' });
      const tabId = useAppStore.getState().spawnFavorite(favId);
      expect(useAppStore.getState().tabs[tabId!].env).toBeUndefined();
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

  // --- moveTab ---
  describe('moveTab', () => {
    it('同一グループ内の並び替え（前→後）', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      const t2 = useAppStore.getState().createTab(g1, { title: 'B' });
      const t3 = useAppStore.getState().createTab(g1, { title: 'C' });

      // t1 (index 0) を index 2 へ移動 → [t2, t3, t1]
      useAppStore.getState().moveTab(t1, g1, 2);

      const tabIds = useAppStore.getState().groups[0].tabIds;
      expect(tabIds).toEqual([t2, t3, t1]);
    });

    it('同一グループ内の並び替え（後→前）', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      const t2 = useAppStore.getState().createTab(g1, { title: 'B' });
      const t3 = useAppStore.getState().createTab(g1, { title: 'C' });

      // t3 (index 2) を index 0 へ移動 → [t3, t1, t2]
      useAppStore.getState().moveTab(t3, g1, 0);

      const tabIds = useAppStore.getState().groups[0].tabIds;
      expect(tabIds).toEqual([t3, t1, t2]);
    });

    it('別グループへ移動（末尾追加）', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      const t2 = useAppStore.getState().createTab(g2, { title: 'B' });

      // g2 に末尾追加 (toIndex = g2.tabIds.length = 1)
      useAppStore.getState().moveTab(t1, g2, 1);

      const state = useAppStore.getState();
      expect(state.groups[0].tabIds).not.toContain(t1);
      expect(state.groups[1].tabIds).toEqual([t2, t1]);
    });

    it('不正な tabId → no-op', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const before = useAppStore.getState().groups;

      useAppStore.getState().moveTab('non-existent-tab', g1, 0);

      expect(useAppStore.getState().groups).toBe(before);
    });

    it('不正な toGroupId → no-op', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      const before = useAppStore.getState().groups;

      useAppStore.getState().moveTab(t1, 'non-existent-group', 0);

      expect(useAppStore.getState().groups).toBe(before);
    });

    it('toIndex が負の場合は 0 にクランプされる', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      const t2 = useAppStore.getState().createTab(g1, { title: 'B' });

      // t2 を -5 (→ 0) に移動 → [t2, t1]
      useAppStore.getState().moveTab(t2, g1, -5);

      const tabIds = useAppStore.getState().groups[0].tabIds;
      expect(tabIds).toEqual([t2, t1]);
    });

    it('toIndex が超過の場合は末尾にクランプされる', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      const t2 = useAppStore.getState().createTab(g1, { title: 'B' });

      // t1 を 999 (→ 1) に移動 → [t2, t1]
      useAppStore.getState().moveTab(t1, g1, 999);

      const tabIds = useAppStore.getState().groups[0].tabIds;
      expect(tabIds).toEqual([t2, t1]);
    });

    it('別グループへ移動すると tab.groupId が更新される', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });

      useAppStore.getState().moveTab(t1, g2, 0);

      expect(useAppStore.getState().tabs[t1].groupId).toBe(g2);
    });

    it('同一グループ内移動では tab.groupId は変わらない', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      useAppStore.getState().createTab(g1, { title: 'B' });

      useAppStore.getState().moveTab(t1, g1, 1);

      expect(useAppStore.getState().tabs[t1].groupId).toBe(g1);
    });

    // F1: tab.groupId が指すグループが消失している race condition → no-op
    it('tab.groupId が指すグループが存在しない不整合状態で moveTab → no-op', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const g2 = useAppStore.getState().createGroup('G2');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });

      // 不整合状態を直接 setState で作る（tab.groupId は 'g1' だが groups に g1 が存在しない）
      useAppStore.setState((s) => ({
        groups: s.groups.filter((g) => g.id !== g1),
      }));

      const before = useAppStore.getState().groups;
      useAppStore.getState().moveTab(t1, g2, 0);

      // no-op なので groups 参照が変わらない
      expect(useAppStore.getState().groups).toBe(before);
    });

    // F5: 同一グループ同一 index への moveTab → 参照不変
    it('同一グループ同一 index への moveTab → groups 参照が変わらない', () => {
      const g1 = useAppStore.getState().createGroup('G1');
      const t1 = useAppStore.getState().createTab(g1, { title: 'A' });
      useAppStore.getState().createTab(g1, { title: 'B' });

      // t1 は index 0 → 同じ index 0 に移動
      const before = useAppStore.getState().groups;
      useAppStore.getState().moveTab(t1, g1, 0);

      expect(useAppStore.getState().groups).toBe(before);
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

// これより下は appStore describe の外 (純関数・navigateToTab 等のスタンドアロンテスト)

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

// --- (2.11) spawning タイムアウト ロジックの間接テスト ---
//
// TerminalPane の useEffect は jsdom 環境では Tauri IPC 依存のため直接テストできないが、
// タイムアウト発火後に実行される「setTabStatus(tabId, 'crashed')」が store に正しく反映
// されることを fake timer で検証する。
// これによりタイムアウトロジックの結果（spawning → crashed 遷移）がストア側で動くことを保証する。

describe('spawning タイムアウト (2.11) — setTabStatus による状態遷移の間接テスト', () => {
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

  it('spawning タブに対して fake setTimeout が発火したとき setTabStatus で crashed になる', () => {
    vi.useFakeTimers();

    const groupId = useAppStore.getState().createGroup();
    const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });

    // 初期状態: spawning
    expect(useAppStore.getState().tabs[tabId].status).toBe('spawning');

    // タイムアウトロジックを模擬: SPAWN_TIMEOUT_MS 後に spawning のままなら crashed にする
    const setTabStatus = useAppStore.getState().setTabStatus;
    const timeoutId = setTimeout(() => {
      if (useAppStore.getState().tabs[tabId]?.status === 'spawning') {
        setTabStatus(tabId, 'crashed');
      }
    }, SPAWN_TIMEOUT_MS);

    // 5 秒経過 → まだ spawning
    vi.advanceTimersByTime(5000);
    expect(useAppStore.getState().tabs[tabId].status).toBe('spawning');

    // 10 秒経過 → crashed に遷移
    vi.advanceTimersByTime(5000);
    expect(useAppStore.getState().tabs[tabId].status).toBe('crashed');

    clearTimeout(timeoutId);
    vi.useRealTimers();
  });

  it('spawning → live になった後にタイムアウトが発火しても crashed にならない', () => {
    vi.useFakeTimers();

    const groupId = useAppStore.getState().createGroup();
    const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });

    const setTabStatus = useAppStore.getState().setTabStatus;
    const timeoutId = setTimeout(() => {
      if (useAppStore.getState().tabs[tabId]?.status === 'spawning') {
        setTabStatus(tabId, 'crashed');
      }
    }, SPAWN_TIMEOUT_MS);

    // 5 秒後に live に遷移（spawn 成功）
    vi.advanceTimersByTime(5000);
    useAppStore.getState().setTabStatus(tabId, 'live', 'pty-abc');
    expect(useAppStore.getState().tabs[tabId].status).toBe('live');

    // 残り 5 秒経過 → タイムアウト発火するが spawning ではないので no-op
    vi.advanceTimersByTime(5000);
    expect(useAppStore.getState().tabs[tabId].status).toBe('live');

    clearTimeout(timeoutId);
    vi.useRealTimers();
  });

  it('crashed → spawning に再遷移したとき、新たな 10 秒タイムアウトが設定される', () => {
    vi.useFakeTimers();
    const groupId = useAppStore.getState().createGroup();
    const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });

    // crashed に遷移 (spawn 失敗を模擬)
    useAppStore.getState().setTabStatus(tabId, 'crashed');
    expect(useAppStore.getState().tabs[tabId].status).toBe('crashed');

    // restart 模擬: spawning に再遷移
    useAppStore.getState().setTabStatus(tabId, 'spawning');

    // タイムアウトロジックを再セット (TerminalPane.tsx の useEffect 相当)
    const setTabStatus = useAppStore.getState().setTabStatus;
    const timeoutId = setTimeout(() => {
      if (useAppStore.getState().tabs[tabId]?.status === 'spawning') {
        setTabStatus(tabId, 'crashed');
      }
    }, SPAWN_TIMEOUT_MS);

    // 10 秒経過
    vi.advanceTimersByTime(SPAWN_TIMEOUT_MS);

    expect(useAppStore.getState().tabs[tabId].status).toBe('crashed');

    clearTimeout(timeoutId);
    vi.useRealTimers();
  });
});

// --- getTabDisplayTitle (純関数テスト) ---

describe('getTabDisplayTitle', () => {
  const baseTab = {
    id: 't1',
    groupId: 'g1',
    status: 'spawning' as const,
  };

  it('userTitle が設定されているとき userTitle を返す', () => {
    const tab = { ...baseTab, userTitle: 'User', oscTitle: 'Osc' };
    expect(getTabDisplayTitle(tab)).toBe('User');
  });

  it('userTitle が未設定・oscTitle あり: oscTitle を返す', () => {
    const tab = { ...baseTab, oscTitle: 'Osc' };
    expect(getTabDisplayTitle(tab)).toBe('Osc');
  });

  it('userTitle も oscTitle も未設定: デフォルト "Terminal" を返す', () => {
    const tab = { ...baseTab };
    expect(getTabDisplayTitle(tab)).toBe('Terminal');
  });

  it('userTitle も oscTitle も未設定: カスタムデフォルト値が使われる', () => {
    const tab = { ...baseTab };
    expect(getTabDisplayTitle(tab, 'Custom Default')).toBe('Custom Default');
  });

  it('userTitle が空文字列のとき oscTitle にフォールバックしない（空文字列は有効な userTitle）', () => {
    // userTitle が '' の場合は '' が返る（undefined でないため）
    // 実際には updateTabTitle で空文字列は弾くが型上は可能
    const tab = { ...baseTab, userTitle: '', oscTitle: 'Osc' };
    // '' ?? 'Osc' → '' (空文字列は nullish ではない)
    expect(getTabDisplayTitle(tab)).toBe('');
  });
});

// --- persist partialize テスト ---

describe('persist partialize — ランタイム状態が保存対象外であること', () => {
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

  it('partialize: status と ptyId がシリアライズ対象外になる', () => {
    const groupId = useAppStore.getState().createGroup();
    const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });
    useAppStore.getState().setTabStatus(tabId, 'live', 'pty-001');

    // partialize 関数を直接呼び出して検証
    const partializeResult = useAppStore.persist.getOptions().partialize!(useAppStore.getState());

    const serializedTab = (partializeResult as { tabs: Record<string, unknown> }).tabs[tabId];
    expect(serializedTab).toBeDefined();
    // status / ptyId は含まれない
    expect((serializedTab as Record<string, unknown>).status).toBeUndefined();
    expect((serializedTab as Record<string, unknown>).ptyId).toBeUndefined();
    // userTitle / shell / cwd / env は保存される
    expect((serializedTab as Record<string, unknown>).id).toBe(tabId);
    expect((serializedTab as Record<string, unknown>).groupId).toBe(groupId);
  });

  it('partialize: oscTitle がシリアライズ対象外になる', () => {
    const groupId = useAppStore.getState().createGroup();
    const tabId = useAppStore.getState().createTab(groupId, { title: 'T' });
    useAppStore.getState().updateTabOscTitle(tabId, 'shell-title');

    const partializeResult = useAppStore.persist.getOptions().partialize!(useAppStore.getState());
    const serializedTab = (partializeResult as { tabs: Record<string, unknown> }).tabs[tabId];

    // oscTitle は含まれない
    expect((serializedTab as Record<string, unknown>).oscTitle).toBeUndefined();
    // userTitle は保存される（ここでは opts.title='T' で userTitle='T'）
    expect((serializedTab as Record<string, unknown>).userTitle).toBe('T');
  });

  it('partialize: activeTabId / editingId / contextMenuOpen が保存されない', () => {
    const groupId = useAppStore.getState().createGroup();
    useAppStore.getState().createTab(groupId, { title: 'T' });
    useAppStore.getState().startEditing('some-id');
    useAppStore.getState().setContextMenuOpen(true);

    const partializeResult = useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as Record<string, unknown>;

    expect(partializeResult.activeTabId).toBeUndefined();
    expect(partializeResult.editingId).toBeUndefined();
    expect(partializeResult.contextMenuOpen).toBeUndefined();
  });

  it('partialize: userTitle が保存される', () => {
    const groupId = useAppStore.getState().createGroup();
    const tabId = useAppStore.getState().createTab(groupId, { title: 'MyTitle' });

    const partializeResult = useAppStore.persist.getOptions().partialize!(useAppStore.getState());
    const serializedTab = (partializeResult as { tabs: Record<string, unknown> }).tabs[tabId];

    expect((serializedTab as Record<string, unknown>).userTitle).toBe('MyTitle');
  });
});

// --- F-S6: persist onRehydrateStorage 整合性ガード ---

describe('persist onRehydrateStorage 整合性ガード', () => {
  /**
   * onRehydrateStorage のコールバックを直接呼び出して動作を検証する。
   * zustand の persist は onRehydrateStorage() の戻り値 (コールバック) を
   * hydration 完了時に呼ぶ。ここでは直接呼び出して内部ロジックをテストする。
   */
  function callOnRehydrate(state: Record<string, any>) {
    const opts = useAppStore.persist.getOptions();
    // onRehydrateStorage は () => (state) => void の形
    const cb = (opts.onRehydrateStorage as () => (s: any) => void)();
    cb(state);
    return state;
  }

  it('orphan tab (どの group の tabIds にも含まれていない) を削除する', () => {
    const state = {
      groups: [{ id: 'g1', title: 'G1', collapsed: false, tabIds: ['t1'] }],
      tabs: {
        t1: { id: 't1', groupId: 'g1', status: 'live', ptyId: 'p1' },
        orphan: { id: 'orphan', groupId: 'g1', status: 'live', ptyId: 'p2' },
      },
      editingId: 'something',
      contextMenuOpen: true,
    };
    callOnRehydrate(state);
    expect(state.tabs['orphan']).toBeUndefined();
    expect(state.tabs['t1']).toBeDefined();
  });

  it('group.tabIds に存在しない tabId が含まれていれば除去する', () => {
    const state = {
      groups: [{ id: 'g1', title: 'G1', collapsed: false, tabIds: ['t1', 'ghost'] }],
      tabs: { t1: { id: 't1', groupId: 'g1', status: 'live' } },
      editingId: null,
      contextMenuOpen: false,
    };
    callOnRehydrate(state);
    expect(state.groups[0].tabIds).toEqual(['t1']);
    expect(state.groups[0].tabIds).not.toContain('ghost');
  });

  it('重複 tabId を最初の group のみ残す', () => {
    const state = {
      groups: [
        { id: 'g1', title: 'G1', collapsed: false, tabIds: ['t1', 't2'] },
        { id: 'g2', title: 'G2', collapsed: false, tabIds: ['t2', 't3'] }, // t2 が重複
      ],
      tabs: {
        t1: { id: 't1', groupId: 'g1', status: 'live' },
        t2: { id: 't2', groupId: 'g1', status: 'live' },
        t3: { id: 't3', groupId: 'g2', status: 'live' },
      },
      editingId: null,
      contextMenuOpen: false,
    };
    callOnRehydrate(state);
    // t2 は g1 に残り、g2 から除去される
    expect(state.groups[0].tabIds).toContain('t2');
    expect(state.groups[1].tabIds).not.toContain('t2');
    // t3 は g2 に残る
    expect(state.groups[1].tabIds).toContain('t3');
  });

  it('status/ptyId をリセットする', () => {
    const state = {
      groups: [{ id: 'g1', title: 'G1', collapsed: false, tabIds: ['t1'] }],
      tabs: {
        t1: { id: 't1', groupId: 'g1', status: 'live', ptyId: 'pty-123' },
      },
      editingId: 'edit-id',
      contextMenuOpen: true,
    };
    callOnRehydrate(state);
    expect(state.tabs['t1'].status).toBe('spawning');
    expect(state.tabs['t1'].ptyId).toBeUndefined();
    expect(state.editingId).toBeNull();
    expect(state.contextMenuOpen).toBe(false);
  });
});

// --- F-S6: persist migrate v0 → v1 ---

describe('persist migrate v0 → v1', () => {
  it('tab.title が tab.userTitle に変換される', () => {
    const opts = useAppStore.persist.getOptions();
    const oldState = {
      tabs: { t1: { id: 't1', groupId: 'g1', title: 'Old Title' } },
    };
    const migrated = opts.migrate!(oldState, 0) as Record<string, any>;
    expect(migrated.tabs.t1.userTitle).toBe('Old Title');
    expect(migrated.tabs.t1.title).toBeUndefined();
  });

  it('userTitle が既にあれば title は変換されない', () => {
    const opts = useAppStore.persist.getOptions();
    const oldState = {
      tabs: { t1: { id: 't1', groupId: 'g1', title: 'OldTitle', userTitle: 'ExistingUserTitle' } },
    };
    const migrated = opts.migrate!(oldState, 0) as Record<string, any>;
    // userTitle が既にある場合は title → userTitle 変換をスキップ（title は残る可能性があるが userTitle は上書きされない）
    expect(migrated.tabs.t1.userTitle).toBe('ExistingUserTitle');
  });

  it('version 1 ならパススルー (title は変換されない)', () => {
    const opts = useAppStore.persist.getOptions();
    const state = {
      tabs: { t1: { id: 't1', groupId: 'g1', title: 'ShouldNotChange' } },
    };
    const migrated = opts.migrate!(state, 1) as Record<string, any>;
    // version >= 1 では title→userTitle 変換を行わない
    expect(migrated.tabs.t1.title).toBe('ShouldNotChange');
    expect(migrated.tabs.t1.userTitle).toBeUndefined();
  });
});
