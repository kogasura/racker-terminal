import { describe, it, expect } from 'vitest';
import {
  agentTooltip,
  selectFavorites,
  selectGroup,
  selectMoveTargets,
  selectSidebar,
  selectTabBar,
  selectTabItem,
  statusDotClassName,
} from './viewModel';
import type { Tab } from '../../types';

// 見た目の仕様をここで固定する。View はこの結果を並べるだけなので、
// レンダリングせずに「どの状態で何が出るか」を確かめられる。

function tab(patch: Partial<Tab> = {}): Tab {
  return { id: 't1', groupId: 'g1', status: 'live', ...patch } as Tab;
}

describe('statusDotClassName', () => {
  it('PTY の状態が基底の色になる', () => {
    expect(statusDotClassName('live')).toContain('--live');
    expect(statusDotClassName('spawning')).toContain('--spawning');
    expect(statusDotClassName('crashed')).toContain('--crashed');
  });

  it('エージェント状態を modifier で重ねる', () => {
    expect(statusDotClassName('live', 'working')).toContain('--agent-working');
  });

  it('idle と未検出は modifier を付けない（何も起きていないことを装飾で主張しない）', () => {
    expect(statusDotClassName('live', 'idle')).toBe(statusDotClassName('live'));
    expect(statusDotClassName('live', undefined)).toBe(statusDotClassName('live'));
  });
});

describe('agentTooltip', () => {
  it('検出していなければ出さない', () => {
    expect(agentTooltip({ agentState: undefined })).toBeUndefined();
  });

  it('応答待ちは理由を添える', () => {
    expect(agentTooltip({ agentState: 'blocked', waitingFor: 'input needed' })).toContain(
      'input needed',
    );
  });

  it('シェルコマンド実行中は working と区別を補う', () => {
    expect(agentTooltip({ agentState: 'working', claudeStatus: 'shell' })).toContain(
      'シェルコマンド',
    );
  });
});

describe('selectTabItem', () => {
  it('タブが無ければ exists: false', () => {
    expect(selectTabItem(undefined, false).exists).toBe(false);
  });

  it('タイトル・状態・編集中を渡す', () => {
    const vm = selectTabItem(tab({ userTitle: 'マイタブ', agentState: 'working' }), true);
    expect(vm).toMatchObject({ exists: true, title: 'マイタブ', isEditing: true, groupId: 'g1' });
    expect(vm.statusClass).toContain('--agent-working');
  });

  it('PR が無ければバッジを出さない', () => {
    expect(selectTabItem(tab(), false).pr).toBeNull();
  });

  it('PR があればラベルと tooltip を組み立てる', () => {
    const vm = selectTabItem(
      tab({ prBranch: 'feat/x', prNumber: 42, prState: 'OPEN', prUrl: 'https://example/42' }),
      false,
    );
    expect(vm.pr).toMatchObject({ label: '#42', url: 'https://example/42' });
  });

  it('Claude セッションの有無でメニューの出し分けを決める', () => {
    expect(selectTabItem(tab(), false).hasClaudeSession).toBe(false);
    expect(selectTabItem(tab({ claudeSessionId: 'abc' }), false).hasClaudeSession).toBe(true);
  });
});

describe('selectMoveTargets', () => {
  it('今いるグループは選ばせない（移動が no-op になるため）', () => {
    const targets = selectMoveTargets(['g1', 'g2'], ['A', 'B'], 'g1');
    expect(targets).toEqual([
      { groupId: 'g1', title: 'A', disabled: true },
      { groupId: 'g2', title: 'B', disabled: false },
    ]);
  });
});

describe('selectGroup', () => {
  const snapshot = { title: 'G', tabCount: 0, agentState: undefined, isActive: true };

  it('グループが無ければ exists: false', () => {
    expect(selectGroup(null, false, 2, false).exists).toBe(false);
  });

  it('空のグループは、2 個以上あるときだけ閉じられる', () => {
    expect(selectGroup(snapshot, false, 2, false).canDelete).toBe(true);
    // 最後の 1 個は残す (グループが 0 になるとタブの置き場が無くなる)
    expect(selectGroup(snapshot, false, 1, false).canDelete).toBe(false);
  });

  it('タブが残っていれば閉じられない', () => {
    expect(selectGroup({ ...snapshot, tabCount: 1 }, false, 3, false).canDelete).toBe(false);
  });

  it('代表エージェント状態と選択状態をそのまま渡す', () => {
    const vm = selectGroup({ ...snapshot, agentState: 'blocked' }, true, 2, true);
    expect(vm).toMatchObject({ agentState: 'blocked', isActive: true, isEditing: true, isDraggingTab: true });
  });
});

describe('selectFavorites', () => {
  const favs = [
    { id: 'f1', title: 'A', shell: 'nu' },
    { id: 'f2', title: 'B', shell: 'nu' },
  ] as never as Parameters<typeof selectFavorites>[0];

  it('空なら isEmpty', () => {
    expect(selectFavorites([], null)).toEqual({ items: [], isEmpty: true });
  });

  it('既定のお気に入りに印を付ける', () => {
    const vm = selectFavorites(favs, 'f2');
    expect(vm.items.map((i) => i.isDefault)).toEqual([false, true]);
    expect(vm.isEmpty).toBe(false);
  });

  it('既定が未設定ならどれにも印が付かない', () => {
    expect(selectFavorites(favs, undefined).items.every((i) => !i.isDefault)).toBe(true);
  });
});

describe('selectSidebar / selectTabBar', () => {
  it('サイドバーはグループ一覧とドラッグ中かを渡す', () => {
    expect(selectSidebar(['g1'], true)).toEqual({ groupIds: ['g1'], isDraggingTab: true });
  });

  it('タブバーはグループが無ければ出さない', () => {
    expect(selectTabBar(null, [], null).visible).toBe(false);
    expect(selectTabBar('g1', ['t1'], 't1')).toEqual({
      visible: true,
      tabIds: ['t1'],
      activeTabId: 't1',
    });
  });
});
