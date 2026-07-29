import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dropGroup, dropFavorite, dropTab } from './DragDropProvider';
import { useAppStore } from '../store/appStore';
import {
  GROUP_DROPPABLE_PREFIX,
  GROUP_HEADER_DROPPABLE_PREFIX,
  DROP_AS_NEW_GROUP_ID,
  DRAG_KIND,
} from '../lib/dndResolve';
import type { DragEndEvent } from '@dnd-kit/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../lib/terminalRegistry', () => ({ forceDisposeRuntime: vi.fn() }));

/**
 * D&D の drop 処理。
 *
 * handleDragEnd は kind によって 3 つの経路に分岐する。分岐の取り違えは
 * 「タブをドラッグしたらグループが並び替わる」のような壊れ方をするため、
 * それぞれの経路を個別に固定する。
 */

/** dropTab に渡す active の最小スタブ。 */
function activeTab(id: string, groupId: string): DragEndEvent['active'] {
  return {
    id,
    data: { current: { kind: DRAG_KIND.TAB, groupId } },
  } as unknown as DragEndEvent['active'];
}

describe('D&D の drop 処理', () => {
  beforeEach(() => {
    useAppStore.setState({
      groups: [
        { id: 'g1', title: 'A', collapsed: false, tabIds: ['t1'] },
        { id: 'g2', title: 'B', collapsed: false, tabIds: ['t2'] },
      ],
      tabs: {
        t1: { id: 't1', groupId: 'g1', status: 'live' },
        t2: { id: 't2', groupId: 'g2', status: 'live' },
      },
      favorites: [
        { id: 'f1', title: 'fav1' },
        { id: 'f2', title: 'fav2' },
      ],
      activeTabId: 't1',
      activeGroupId: 'g1',
    });
  });

  describe('dropGroup', () => {
    it('生の groupId をターゲットにできる', () => {
      dropGroup('g2', 'g1');
      expect(useAppStore.getState().groups.map((g) => g.id)).toEqual(['g2', 'g1']);
    });

    it('group-{id} 形式の droppable id でもターゲット解決できる', () => {
      dropGroup('g2', `${GROUP_DROPPABLE_PREFIX}g1`);
      expect(useAppStore.getState().groups.map((g) => g.id)).toEqual(['g2', 'g1']);
    });

    it('group-header- 接頭辞（auto-expand 専用）は並び替え対象外', () => {
      dropGroup('g2', `${GROUP_HEADER_DROPPABLE_PREFIX}g1`);
      expect(useAppStore.getState().groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    });

    it('存在しないグループへの drop は no-op', () => {
      dropGroup('g2', 'missing');
      expect(useAppStore.getState().groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    });
  });

  describe('dropFavorite', () => {
    it('お気に入りを並び替える', () => {
      dropFavorite('f2', 'f1');
      expect(useAppStore.getState().favorites.map((f) => f.id)).toEqual(['f2', 'f1']);
    });

    it('存在しないお気に入りへの drop は no-op', () => {
      dropFavorite('f2', 'missing');
      expect(useAppStore.getState().favorites.map((f) => f.id)).toEqual(['f1', 'f2']);
    });
  });

  describe('dropTab', () => {
    it('group-{id} への drop で別グループの末尾へ移動する', () => {
      dropTab(activeTab('t1', 'g1'), `${GROUP_DROPPABLE_PREFIX}g2`);
      expect(useAppStore.getState().tabs.t1.groupId).toBe('g2');
    });

    it('タブ ID への drop でそのタブの位置に挿入される', () => {
      dropTab(activeTab('t1', 'g1'), 't2');
      const s = useAppStore.getState();
      expect(s.tabs.t1.groupId).toBe('g2');
      expect(s.groups.find((g) => g.id === 'g2')!.tabIds).toEqual(['t1', 't2']);
    });

    it('新規グループとして drop すると、グループが作られてそこへ移動する', () => {
      const before = useAppStore.getState().groups.length;
      dropTab(activeTab('t1', 'g1'), DROP_AS_NEW_GROUP_ID);
      const s = useAppStore.getState();
      expect(s.groups).toHaveLength(before + 1);
      // 新しいグループに t1 が入っていること
      const owner = s.groups.find((g) => g.tabIds.includes('t1'));
      expect(owner!.id).not.toBe('g1');
      expect(s.tabs.t1.groupId).toBe(owner!.id);
    });

    it('groupId を持たない active は no-op（グループが増えない）', () => {
      const before = useAppStore.getState().groups.length;
      dropTab(
        { id: 't1', data: { current: {} } } as unknown as DragEndEvent['active'],
        `${GROUP_DROPPABLE_PREFIX}g2`,
      );
      expect(useAppStore.getState().groups).toHaveLength(before);
      expect(useAppStore.getState().tabs.t1.groupId).toBe('g1');
    });

    it('解決できない drop ターゲットは no-op', () => {
      dropTab(activeTab('t1', 'g1'), 'unknown-target');
      expect(useAppStore.getState().tabs.t1.groupId).toBe('g1');
    });
  });
});
