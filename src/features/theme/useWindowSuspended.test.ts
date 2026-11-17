import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, cleanup } from '@testing-library/react';
import { useWindowSuspended } from './useWindowSuspended';

/** 最小化の購読の代わり。知らせる口を外から叩ける。 */
function fakeSubscribe() {
  const state = { notify: (_minimized: boolean) => {}, unsubscribe: vi.fn() };
  const subscribe = vi.fn((onChange: (minimized: boolean) => void) => {
    state.notify = onChange;
    return state.unsubscribe;
  });
  return { subscribe, state };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  setVisibility('visible');
});

describe('useWindowSuspended', () => {
  it('最小化している間は true、元に戻すと false', () => {
    const { subscribe, state } = fakeSubscribe();
    const { result } = renderHook(() => useWindowSuspended(subscribe));
    expect(result.current).toBe(false);

    act(() => state.notify(true));
    expect(result.current).toBe(true);
    act(() => state.notify(false));
    expect(result.current).toBe(false);
  });

  it('文書が hidden の間も true', () => {
    const { subscribe } = fakeSubscribe();
    const { result } = renderHook(() => useWindowSuspended(subscribe));

    act(() => setVisibility('hidden'));
    expect(result.current).toBe(true);
    act(() => setVisibility('visible'));
    expect(result.current).toBe(false);
  });

  it('外すと購読もやめる', () => {
    const { subscribe, state } = fakeSubscribe();
    const { unmount } = renderHook(() => useWindowSuspended(subscribe));
    unmount();
    expect(state.unsubscribe).toHaveBeenCalled();
  });
});
