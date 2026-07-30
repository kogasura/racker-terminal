import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyChangedTabs, pruneClosedTabs } from './App';
import { notifyAgentState } from './lib/notifications';
import type { AgentState, Tab, Settings } from './types';

// 通知の送信そのものは notifications 側のテストで見ているので、ここでは
// 「呼ばれたか / 呼ばれなかったか」だけを見る。
vi.mock('./lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/notifications')>();
  return { ...actual, notifyAgentState: vi.fn() };
});

// App.tsx は import しただけで大量の子コンポーネントを引き込むため、
// 描画を伴うものはスタブしておく（ここで見たいのは純粋なロジック）。
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const notifyMock = vi.mocked(notifyAgentState);

function makeTab(id: string, agentState?: AgentState, waitingFor?: string): Tab {
  // 通知判定が見るのは id / userTitle / agentState / waitingFor だけだが、
  // キャストで誤魔化すと Tab の必須項目が増えたときに気付けないので実型で作る。
  return {
    id,
    groupId: 'g1',
    userTitle: id,
    status: 'spawning',
    agentState,
    waitingFor,
  };
}

function makeState(
  tabs: Record<string, Tab>,
  opts: { activeTabId?: string | null; notificationsEnabled?: boolean } = {},
) {
  const settings: Settings = {
    theme: 'tokyo-night',
    fontFamily: 'monospace',
    fontSize: 14,
    scrollback: 1000,
    notificationsEnabled: opts.notificationsEnabled ?? true,
  };
  return { tabs, activeTabId: opts.activeTabId ?? null, settings };
}

/**
 * 通知は「状態が変わった瞬間だけ」鳴らす。ここで見るのは、その判定に渡す
 * **控え (prevStates) の更新タイミング**。判定そのものは shouldNotify のテストにある。
 */
describe('notifyChangedTabs', () => {
  beforeEach(() => {
    notifyMock.mockReset();
  });

  it('状態が変わった非アクティブタブを通知する', () => {
    const prev = new Map<string, AgentState | undefined>([['t1', 'working']]);

    notifyChangedTabs(makeState({ t1: makeTab('t1', 'blocked') }), prev);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toBe('blocked');
  });

  it('状態が変わっていなければ通知しない', () => {
    const prev = new Map<string, AgentState | undefined>([['t1', 'blocked']]);

    notifyChangedTabs(makeState({ t1: makeTab('t1', 'blocked') }), prev);

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('アクティブタブは通知しない', () => {
    const prev = new Map<string, AgentState | undefined>([['t1', 'working']]);

    notifyChangedTabs(
      makeState({ t1: makeTab('t1', 'blocked') }, { activeTabId: 't1' }),
      prev,
    );

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('応答待ちの理由も渡す', () => {
    const prev = new Map<string, AgentState | undefined>([['t1', 'working']]);

    notifyChangedTabs(
      makeState({ t1: makeTab('t1', 'blocked', 'input needed') }),
      prev,
    );

    expect(notifyMock.mock.calls[0][2]).toBe('input needed');
  });

  describe('通知が OFF のとき', () => {
    it('通知は出さない', () => {
      const prev = new Map<string, AgentState | undefined>([['t1', 'working']]);

      notifyChangedTabs(
        makeState({ t1: makeTab('t1', 'blocked') }, { notificationsEnabled: false }),
        prev,
      );

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it('**控えは更新する**（ON に戻した瞬間に溜まっていた分が一斉に鳴らないように）', () => {
      // ここが肝。控えを更新せずに読み飛ばすと、OFF の間に起きた変化が
      // 「未通知の変化」として残り、ON に戻した瞬間にまとめて通知が飛ぶ。
      const prev = new Map<string, AgentState | undefined>([['t1', 'working']]);

      notifyChangedTabs(
        makeState({ t1: makeTab('t1', 'blocked') }, { notificationsEnabled: false }),
        prev,
      );

      expect(prev.get('t1')).toBe('blocked');
    });
  });

  it('通知した後は控えを最新にして、同じ変化で二度鳴らさない', () => {
    const prev = new Map<string, AgentState | undefined>([['t1', 'working']]);
    const state = makeState({ t1: makeTab('t1', 'blocked') });

    notifyChangedTabs(state, prev);
    notifyChangedTabs(state, prev);

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('複数タブはそれぞれ独立に判定する', () => {
    const prev = new Map<string, AgentState | undefined>([
      ['t1', 'working'],
      ['t2', 'blocked'],
    ]);

    notifyChangedTabs(
      makeState({
        t1: makeTab('t1', 'done'), // 変化あり → 通知
        t2: makeTab('t2', 'blocked'), // 変化なし → 通知しない
      }),
      prev,
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toBe('done');
  });
});

describe('pruneClosedTabs', () => {
  it('閉じられたタブの控えを捨てる', () => {
    const prev = new Map<string, AgentState | undefined>([
      ['t1', 'working'],
      ['t2', 'blocked'],
      ['t3', 'done'],
    ]);

    pruneClosedTabs(prev, { t1: makeTab('t1') });

    expect([...prev.keys()]).toEqual(['t1']);
  });

  it('控えがタブ数以下なら何もしない（走査を省く早期リターン）', () => {
    // 現状の実装は「控えがタブ数より多いとき」だけ掃除する。
    // そのため下の例では、既に閉じた t9 の控えが残る。実害は Map の
    // 1 エントリぶんで、タブが増えれば次の掃除で回収される。
    const prev = new Map<string, AgentState | undefined>([['t9', 'working']]);

    pruneClosedTabs(prev, { t1: makeTab('t1') });

    expect(prev.has('t9')).toBe(true);
  });

  it('タブが全部閉じられたら控えも空になる', () => {
    const prev = new Map<string, AgentState | undefined>([
      ['t1', 'working'],
      ['t2', 'done'],
    ]);

    pruneClosedTabs(prev, {});

    expect(prev.size).toBe(0);
  });
});
