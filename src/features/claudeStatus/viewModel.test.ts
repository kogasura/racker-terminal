import { describe, it, expect } from 'vitest';
import { initialState, type ClaudeStatusState } from './machine';
import { selectStatusBar } from './viewModel';

// 「バーを出すか」「何を出すか」の判断。View はこの結果を並べるだけなので、
// レンダリングせずに仕様を固定できる。

function state(patch: Partial<ClaudeStatusState>): ClaudeStatusState {
  return { ...initialState, ...patch };
}

const meta = { model: 'claude-opus-5', effort: 'high', contextTokens: 55_002 };
const usage = { fiveHourPercent: 13, sevenDayPercent: 22 };

describe('selectStatusBar', () => {
  it('出す情報が何も無ければ帯ごと消す', () => {
    expect(selectStatusBar(initialState, true).visible).toBe(false);
  });

  it('設定で無効なら、出す情報があっても描かない', () => {
    expect(selectStatusBar(state({ usage }), false).visible).toBe(false);
  });

  it('会話ログと利用量の両方を渡す', () => {
    const vm = selectStatusBar(state({ activeTabId: 't1', meta: { tabId: 't1', meta }, usage }), true);
    expect(vm).toEqual({ visible: true, meta, usage });
  });

  it('別タブの会話ログは出さない（切り替え直後に前のタブの値を残さない）', () => {
    const vm = selectStatusBar(
      state({ activeTabId: 't1', meta: { tabId: 'other', meta }, usage }),
      true,
    );
    expect(vm.meta).toBeNull();
    expect(vm.usage).toEqual(usage);
  });

  it('利用量だけでもバーは出す', () => {
    expect(selectStatusBar(state({ usage }), true)).toMatchObject({ visible: true, meta: null });
  });

  it('会話ログだけでもバーは出す', () => {
    const vm = selectStatusBar(state({ activeTabId: 't1', meta: { tabId: 't1', meta } }), true);
    expect(vm).toMatchObject({ visible: true, usage: null });
  });

  it('中身の無い会話ログでは帯を出さない', () => {
    const vm = selectStatusBar(
      state({ activeTabId: 't1', meta: { tabId: 't1', meta: {} } }),
      true,
    );
    expect(vm.visible).toBe(false);
  });
});
