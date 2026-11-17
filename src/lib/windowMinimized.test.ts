import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribeWindowMinimized } from './windowMinimized';

type Handler = () => void;

const win = vi.hoisted(() => ({
  minimized: false,
  failToListen: false,
  handlers: { resized: [] as Handler[], focus: [] as Handler[] },
  unlisten: { resized: vi.fn(), focus: vi.fn() },
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    isMinimized: async () => win.minimized,
    onResized: async (handler: Handler) => {
      if (win.failToListen) throw new Error('listen failed');
      win.handlers.resized.push(handler);
      return win.unlisten.resized;
    },
    onFocusChanged: async (handler: Handler) => {
      win.handlers.focus.push(handler);
      return win.unlisten.focus;
    },
  }),
}));

/** 非同期の問い合わせを捌く。 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  win.minimized = false;
  win.failToListen = false;
  win.handlers.resized = [];
  win.handlers.focus = [];
  win.unlisten.resized.mockReset();
  win.unlisten.focus.mockReset();
});

describe('subscribeWindowMinimized', () => {
  it('購読を始めた直後に問い合わせ、窓のイベントのたびに問い合わせ直す', async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeWindowMinimized(onChange);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(false);

    // 最小化 (onResized が届く)
    win.minimized = true;
    win.handlers.resized[0]();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(true);

    // 元に戻す (フォーカスが戻る)
    win.minimized = false;
    win.handlers.focus[0]();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(false);
    unsubscribe();
  });

  it('フォーカスが外れただけなら、最小化ではないまま', async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeWindowMinimized(onChange);
    await flush();
    win.handlers.focus[0]();
    await flush();
    expect(onChange.mock.calls.every(([minimized]) => minimized === false)).toBe(true);
    unsubscribe();
  });

  it('購読をやめるとイベントの購読も外し、その後は呼ばない', async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeWindowMinimized(onChange);
    await flush();
    unsubscribe();
    expect(win.unlisten.resized).toHaveBeenCalled();
    expect(win.unlisten.focus).toHaveBeenCalled();

    onChange.mockClear();
    win.minimized = true;
    win.handlers.resized[0]();
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('購読が整う前にやめても、整ったあとで購読を外す', async () => {
    const unsubscribe = subscribeWindowMinimized(vi.fn());
    unsubscribe();
    await flush();
    expect(win.unlisten.resized).toHaveBeenCalled();
    expect(win.unlisten.focus).toHaveBeenCalled();
  });

  it('窓を追えない環境では例外にせず、何も知らせない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    win.failToListen = true;
    const onChange = vi.fn();
    const unsubscribe = subscribeWindowMinimized(onChange);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    unsubscribe();
    warn.mockRestore();
  });
});
