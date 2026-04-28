import { describe, it, expect } from 'vitest';
import {
  resolveDropTarget,
  nextNewGroupTitle,
  GROUP_DROPPABLE_PREFIX,
  GROUP_HEADER_DROPPABLE_PREFIX,
} from './dndResolve';
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

  // F-M7: group-header-{id} は auto-expand 専用 → drop ターゲット外 → null
  it('group-header-{id} への drop → null (auto-expand 専用)', () => {
    const state = makeState(
      [{ id: 'g1', tabIds: ['t1'] }],
      { t1: { groupId: 'g1' } },
    );
    const result = resolveDropTarget(`${GROUP_HEADER_DROPPABLE_PREFIX}g1`, state);
    expect(result).toBeNull();
  });

  // F-M7: 'group-header-' は 'group-' のサブストリング → header チェックが先に効くことを確認
  it('group-header-{id} が group- チェックより先に null を返す', () => {
    const state = makeState(
      [{ id: 'header-g1', tabIds: [] }],
      {},
    );
    // 'group-header-g1' は 'group-' 始まりでもあるが header チェックが優先されて null
    const result = resolveDropTarget(`${GROUP_HEADER_DROPPABLE_PREFIX}g1`, state);
    expect(result).toBeNull();
  });
});

describe('nextNewGroupTitle', () => {
  it('既存グループが空 → "New Group 1"', () => {
    expect(nextNewGroupTitle([])).toBe('New Group 1');
  });

  it('New Group 1, 2, 3 が存在 → "New Group 4"', () => {
    const groups = [
      { title: 'New Group 1' },
      { title: 'New Group 2' },
      { title: 'New Group 3' },
    ];
    expect(nextNewGroupTitle(groups)).toBe('New Group 4');
  });

  it('New Group 2 を削除後 (1, 3 が残存) → "New Group 4" (最大値+1)', () => {
    const groups = [
      { title: 'New Group 1' },
      { title: 'New Group 3' },
    ];
    expect(nextNewGroupTitle(groups)).toBe('New Group 4');
  });

  it('任意名のグループのみ存在 → "New Group 1"', () => {
    const groups = [
      { title: 'Work' },
      { title: 'Personal' },
    ];
    expect(nextNewGroupTitle(groups)).toBe('New Group 1');
  });

  it('New Group N と任意名が混在 → 最大 N+1 を返す', () => {
    const groups = [
      { title: 'New Group 5' },
      { title: 'Dev' },
      { title: 'New Group 2' },
    ];
    expect(nextNewGroupTitle(groups)).toBe('New Group 6');
  });
});
