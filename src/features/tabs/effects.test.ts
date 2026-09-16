import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMachine } from '../../architecture/machine';
import { useAppStore } from '../../store/appStore';
import { createEffectRunner } from './effects';
import { initialState, transition, type TabsEffect, type TabsState } from './machine';
import type { TabsEvent } from './events';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

// 裁定を通ったコマンドが store に届くところまで。
// 旧 TerminalPane.keys.test.ts が store の結果まで見ていた分を、ここが引き受ける。

function boot() {
  return createMachine<TabsState, TabsEvent, TabsEffect>({
    initial: initialState,
    transition,
    run: createEffectRunner(),
  });
}

/**
 * store の action を一時的に差し替えて呼び出しを記録する。
 *
 * vi.spyOn は使わない: zustand の set は state オブジェクトを作り直すため、
 * spy を張った関数がそのまま次の state に引き継がれ、restoreAllMocks でも
 * 現在の state からは剥がれず、呼び出し回数がテスト間で漏れる。
 */
function stubAction(name: string) {
  const calls: unknown[][] = [];
  const store = useAppStore as unknown as {
    getState: () => Record<string, unknown>;
    setState: (p: Record<string, unknown>) => void;
  };
  const original = store.getState()[name];
  store.setState({ [name]: (...args: unknown[]) => calls.push(args) });
  return { calls, restore: () => store.setState({ [name]: original }) };
}

beforeEach(() => {
  useAppStore.setState({
    groups: [{ id: 'g1', title: 'Default', collapsed: false, tabIds: ['t1', 't2'] }],
    tabs: {
      t1: { id: 't1', groupId: 'g1', status: 'live' },
      t2: { id: 't2', groupId: 'g1', status: 'live' },
    },
    activeTabId: 't1',
    activeGroupId: 'g1',
    favorites: [],
    closedTabs: [],
  });
});

describe('tabs effects', () => {
  it('close-active: アクティブタブを閉じる', () => {
    boot().send({ type: 'tabs/close-active-requested' });
    expect(useAppStore.getState().tabs.t1).toBeUndefined();
  });

  it('close-active: アクティブタブが無ければ何もしない', () => {
    useAppStore.setState({ activeTabId: null });
    expect(() => boot().send({ type: 'tabs/close-active-requested' })).not.toThrow();
    expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(2);
  });

  it('navigate: 次 / 前のタブへ移動する', () => {
    const m = boot();
    m.send({ type: 'tabs/navigate-requested', direction: 'next' });
    expect(useAppStore.getState().activeTabId).toBe('t2');
    m.send({ type: 'tabs/navigate-requested', direction: 'prev' });
    expect(useAppStore.getState().activeTabId).toBe('t1');
  });

  it('restore / spawn-default: それぞれ対応する action を 1 回だけ呼ぶ', () => {
    const spawn = stubAction('spawnDefaultOrNew');
    const restore = stubAction('restoreLastClosedTab');
    const m = boot();

    m.send({ type: 'tabs/spawn-default-requested' });
    expect(spawn.calls).toHaveLength(1);
    expect(restore.calls).toHaveLength(0);

    m.send({ type: 'tabs/restore-requested' });
    expect(restore.calls).toHaveLength(1);
    expect(spawn.calls).toHaveLength(1);

    spawn.restore();
    restore.restore();
  });

  it('spawn-favorite: index をそのまま渡す', () => {
    const fav = stubAction('spawnFavoriteByIndex');
    const m = boot();
    m.send({ type: 'tabs/spawn-favorite-requested', index: 0 });
    m.send({ type: 'tabs/spawn-favorite-requested', index: 8 });
    expect(fav.calls).toEqual([[0], [8]]);
    fav.restore();
  });

  it('create-tab: 選択中グループにタブを足す', () => {
    boot().send({ type: 'tabs/tab-create-requested' });
    const group = useAppStore.getState().groups.find((g) => g.id === 'g1');
    expect(group?.tabIds).toHaveLength(3);
  });

  it('create-tab: グループが無ければ何もしない', () => {
    useAppStore.setState({ activeGroupId: null });
    expect(() => boot().send({ type: 'tabs/tab-create-requested' })).not.toThrow();
  });

  it('create-group: 連番を振って作り、そのまま選択する', () => {
    const m = boot();
    m.send({ type: 'tabs/group-create-requested' });

    const state = useAppStore.getState();
    expect(state.groups).toHaveLength(2);
    expect(state.groups[1].title).toBe('New Group 1');
    // 作ったグループを選んでおかないと、直後の Ctrl+T が古いグループにタブを作る
    expect(state.activeGroupId).toBe(state.groups[1].id);

    // 連番は既存タイトルの最大値を見る（削除 → 追加で番号が崩れない）
    m.send({ type: 'tabs/group-create-requested' });
    expect(useAppStore.getState().groups[2].title).toBe('New Group 2');
  });

  it('コンテキストメニュー表示中はどのコマンドも store に届かない', () => {
    const spawn = stubAction('spawnDefaultOrNew');
    const m = boot();

    m.send({ type: 'tabs/context-menu-opened' });
    m.send({ type: 'tabs/spawn-default-requested' });
    m.send({ type: 'tabs/close-active-requested' });

    expect(spawn.calls).toHaveLength(0);
    expect(useAppStore.getState().tabs.t1).toBeDefined();

    // 閉じれば通るようになる
    m.send({ type: 'tabs/context-menu-closed' });
    m.send({ type: 'tabs/spawn-default-requested' });
    expect(spawn.calls).toHaveLength(1);

    spawn.restore();
  });
});
