import { describe, it, expect } from 'vitest';
import { resolveDropTarget, GROUP_DROPPABLE_PREFIX } from './dndResolve';
import type { AppState } from '../types';

/** テスト用の最小 state を生成するヘルパー */
function makeState(
  groups: { id: string; tabIds: string[] }[],
  tabs: Record<string, { groupId: string }>,
): Pick<AppState, 'groups' | 'tabs'> {
  return {
    groups: groups.map((g) => ({
      id: g.id,
      title: g.id,
      collapsed: false,
      tabIds: g.tabIds,
    })),
    tabs: Object.fromEntries(
      Object.entries(tabs).map(([id, t]) => [
        id,
        {
          id,
          groupId: t.groupId,
          title: id,
          status: 'live' as const,
        },
      ]),
    ),
  };
}

describe('resolveDropTarget', () => {
  it('グループ ID への drop → 末尾追加 (toIndex = tabIds.length)', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1', 't2'] }],
      { t1: { groupId: 'g1' }, t2: { groupId: 'g1' } },
    );
    const result = resolveDropTarget(`${GROUP_DROPPABLE_PREFIX}g1`, state);
    expect(result).toEqual({ toGroupId: 'g1', toIndex: 2 });
  });

  it('タブ ID への drop → そのタブの位置 (idx) に挿入', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1', 't2', 't3'] }],
      {
        t1: { groupId: 'g1' },
        t2: { groupId: 'g1' },
        t3: { groupId: 'g1' },
      },
    );
    const result = resolveDropTarget('t2', state);
    expect(result).toEqual({ toGroupId: 'g1', toIndex: 1 });
  });

  it('存在しないグループ ID → null', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: [] }],
      {},
    );
    const result = resolveDropTarget(`${GROUP_DROPPABLE_PREFIX}non-existent`, state);
    expect(result).toBeNull();
  });

  it('存在しないタブ ID → null', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1'] }],
      { t1: { groupId: 'g1' } },
    );
    const result = resolveDropTarget('non-existent-tab', state);
    expect(result).toBeNull();
  });

  it('タブの groupId が指すグループが存在しない (不整合) → null', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1'] }],
      // t2 は tabs に存在するが groupId が指す 'g-deleted' は groups にない
      { t1: { groupId: 'g1' }, t2: { groupId: 'g-deleted' } },
    );
    const result = resolveDropTarget('t2', state);
    expect(result).toBeNull();
  });
});
