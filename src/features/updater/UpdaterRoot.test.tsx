import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { UpdaterRoot } from './UpdaterRoot';
import type { EffectDeps } from './effects';

// `racker-terminal.exe --check-update` → Rust の single-instance が
// `check-update-requested` を emit → Root が定期チェックを待たずに確認する、の後半を見る。

const listeners = new Map<string, () => void>();
const unlisten = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: () => void) => {
    listeners.set(name, handler);
    return Promise.resolve(unlisten);
  }),
}));

function makeDeps(): EffectDeps & { checkForUpdate: ReturnType<typeof vi.fn> } {
  return {
    checkForUpdate: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    installAndRelaunch: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  cleanup();
  listeners.clear();
  unlisten.mockReset();
});

describe('UpdaterRoot: 外からの即時チェック', () => {
  it('check-update-requested を受けると、その場で更新を確認する', async () => {
    const deps = makeDeps();
    render(<UpdaterRoot ready deps={deps}>{null}</UpdaterRoot>);

    // 起動時の 1 回
    await vi.waitFor(() => expect(deps.checkForUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(listeners.has('check-update-requested')).toBe(true));

    listeners.get('check-update-requested')?.();

    await vi.waitFor(() => expect(deps.checkForUpdate).toHaveBeenCalledTimes(2));
  });

  it('準備ができるまでは購読しない（hydration 前に確認を走らせない）', () => {
    render(<UpdaterRoot ready={false} deps={makeDeps()}>{null}</UpdaterRoot>);
    expect(listeners.has('check-update-requested')).toBe(false);
  });

  it('アンマウントで購読を外す', async () => {
    const { unmount } = render(<UpdaterRoot ready deps={makeDeps()}>{null}</UpdaterRoot>);
    await vi.waitFor(() => expect(listeners.has('check-update-requested')).toBe(true));

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
