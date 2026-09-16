import { describe, it, expect } from 'vitest';
import { initialState, transition, type ClaudeStatusState } from './machine';
import type { ClaudeStatusEvent } from './events';

// ステータスバーの値は数秒ごとに書き込まれる。値が変わっていないのに参照だけ
// 差し替えると、会話が止まっているあいだも再描画が走り続ける。
// 「同じ値なら状態を動かさない」= 遷移が null を返すことを担保する。

function next(state: ClaudeStatusState, event: ClaudeStatusEvent): ClaudeStatusState {
  return transition(state, event)?.state ?? state;
}

function meta(tabId: string, contextTokens: number): ClaudeStatusEvent {
  return {
    type: 'claude-status/meta-observed',
    tabId,
    meta: { model: 'claude-opus-5', contextTokens },
  };
}

describe('claudeStatus machine', () => {
  describe('会話ログ', () => {
    it('同じタブの同じ値なら状態を動かさない（再描画を起こさない）', () => {
      const first = next(initialState, meta('t1', 100));
      expect(transition(first, meta('t1', 100))).toBeNull();
    });

    it('コンテキスト量が動けば差し替える', () => {
      const first = next(initialState, meta('t1', 100));
      expect(next(first, meta('t1', 200)).meta?.meta.contextTokens).toBe(200);
    });

    it('タブが変われば差し替える（前のタブの値を残さない）', () => {
      const first = next(initialState, meta('t1', 100));
      expect(next(first, meta('t2', 100)).meta?.tabId).toBe('t2');
    });

    it('null は表示を消す', () => {
      const first = next(initialState, meta('t1', 100));
      const cleared = next(first, {
        type: 'claude-status/meta-observed',
        tabId: 't1',
        meta: null,
      });
      expect(cleared.meta).toBeNull();
    });

    it('もともと無いところへ null が来ても動かさない', () => {
      expect(
        transition(initialState, { type: 'claude-status/meta-observed', tabId: 't1', meta: null }),
      ).toBeNull();
    });
  });

  describe('プラン利用量', () => {
    const usage = { fiveHourPercent: 13, sevenDayPercent: 22 };

    it('同じ値なら状態を動かさない', () => {
      const first = next(initialState, { type: 'claude-status/usage-observed', usage });
      expect(
        transition(first, { type: 'claude-status/usage-observed', usage: { ...usage } }),
      ).toBeNull();
    });

    it('割合が動けば差し替える', () => {
      const first = next(initialState, { type: 'claude-status/usage-observed', usage });
      const moved = next(first, {
        type: 'claude-status/usage-observed',
        usage: { ...usage, fiveHourPercent: 16 },
      });
      expect(moved.usage?.fiveHourPercent).toBe(16);
    });

    it('リセット時刻だけ動いても差し替える（tooltip に出るため）', () => {
      const first = next(initialState, { type: 'claude-status/usage-observed', usage });
      const moved = next(first, {
        type: 'claude-status/usage-observed',
        usage: { ...usage, fiveHourResetsAt: '2026-09-16T00:00:00Z' },
      });
      expect(moved.usage?.fiveHourResetsAt).toBe('2026-09-16T00:00:00Z');
    });

    it('null は表示を消す', () => {
      const first = next(initialState, { type: 'claude-status/usage-observed', usage });
      expect(next(first, { type: 'claude-status/usage-observed', usage: null }).usage).toBeNull();
    });
  });

  describe('表示対象のタブ', () => {
    it('変われば記録する', () => {
      expect(
        next(initialState, { type: 'claude-status/active-tab-changed', tabId: 't1' }).activeTabId,
      ).toBe('t1');
    });

    it('同じなら動かさない', () => {
      const first = next(initialState, { type: 'claude-status/active-tab-changed', tabId: 't1' });
      expect(
        transition(first, { type: 'claude-status/active-tab-changed', tabId: 't1' }),
      ).toBeNull();
    });
  });
});
