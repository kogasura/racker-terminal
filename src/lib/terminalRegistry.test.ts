import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireRuntime,
  releaseRuntime,
  forceDisposeRuntime,
  recyclePty,
  getRuntimeCount,
  getRefs,
  type TerminalRuntime,
} from './terminalRegistry';

/**
 * テスト用のモック TerminalRuntime を生成するヘルパー。
 * xterm / FitAddon は DOM を必要とするため、dispose だけ追跡できる最小モックを使う。
 */
function makeRuntime(): TerminalRuntime & { disposeCallCount: number } {
  let disposeCallCount = 0;
  const sub = { dispose: vi.fn() };

  const runtime: TerminalRuntime & { disposeCallCount: number } = {
    get term() { return {} as never; },
    get fitAddon() { return {} as never; },
    get ptyHandle() { return null; },
    get pendingInputs() { return []; },
    onDataSub: sub,
    setOnEvent: vi.fn(),
    startSpawn: vi.fn(),
    resetForRecycle: vi.fn(),
    dispose: () => {
      disposeCallCount++;
    },
    get disposeCallCount() { return disposeCallCount; },
  };
  return runtime;
}

describe('terminalRegistry', () => {
  // 各テスト前に runtimes Map を空にするため、
  // forceDisposeRuntime で登録されているものを全てクリアする
  beforeEach(() => {
    // テスト間の Map 汚染を防ぐため、テスト固有の tabId を使う（UUID で衝突しない前提）
  });

  it('acquireRuntime: 初回は init を呼び refs=1 で登録する', () => {
    const tabId = 'test-acquire-1';
    const runtime = makeRuntime();
    const init = vi.fn(() => runtime);

    const result = acquireRuntime(tabId, init);

    expect(init).toHaveBeenCalledTimes(1);
    expect(result).toBe(runtime);
    expect(getRefs(tabId)).toBe(1);
    expect(getRuntimeCount()).toBeGreaterThanOrEqual(1);

    forceDisposeRuntime(tabId);
  });

  it('acquireRuntime: 2 回目以降は init を呼ばず refs を増やす', () => {
    const tabId = 'test-acquire-2';
    const runtime = makeRuntime();
    const init = vi.fn(() => runtime);

    acquireRuntime(tabId, init);
    const result2 = acquireRuntime(tabId, init);

    expect(init).toHaveBeenCalledTimes(1);
    expect(result2).toBe(runtime);
    expect(getRefs(tabId)).toBe(2);

    forceDisposeRuntime(tabId);
  });

  it('releaseRuntime: refs が 1 → 0 になった後の queueMicrotask で dispose される', async () => {
    const tabId = 'test-release-1';
    const runtime = makeRuntime();
    acquireRuntime(tabId, () => runtime);
    expect(getRefs(tabId)).toBe(1);

    releaseRuntime(tabId);
    // queueMicrotask はまだ実行されていない
    expect(runtime.disposeCallCount).toBe(0);

    // microtask を flush
    await Promise.resolve();

    expect(runtime.disposeCallCount).toBe(1);
    expect(getRuntimeCount()).toBe(0);
  });

  it('releaseRuntime: refs が 2 → 1 のときは dispose されない', async () => {
    const tabId = 'test-release-2';
    const runtime = makeRuntime();
    acquireRuntime(tabId, () => runtime);
    acquireRuntime(tabId, () => runtime);
    expect(getRefs(tabId)).toBe(2);

    releaseRuntime(tabId);
    await Promise.resolve();

    expect(getRefs(tabId)).toBe(1);
    expect(runtime.disposeCallCount).toBe(0);

    forceDisposeRuntime(tabId);
  });

  it('StrictMode パターン: acquire → release → acquire で dispose されない', async () => {
    const tabId = 'test-strictmode';
    const runtime = makeRuntime();
    const init = vi.fn(() => runtime);

    // StrictMode: 1 回目 mount
    acquireRuntime(tabId, init);
    // StrictMode: cleanup
    releaseRuntime(tabId);
    // StrictMode: 2 回目 mount（queueMicrotask 前）
    acquireRuntime(tabId, init);

    // microtask を flush — refs が 1 に戻っているので dispose されないはず
    await Promise.resolve();

    expect(runtime.disposeCallCount).toBe(0);
    expect(getRefs(tabId)).toBe(1);

    forceDisposeRuntime(tabId);
  });

  it('forceDisposeRuntime: 参照カウントを無視して即時 dispose する', () => {
    const tabId = 'test-force-1';
    const runtime = makeRuntime();
    acquireRuntime(tabId, () => runtime);
    acquireRuntime(tabId, () => runtime);
    expect(getRefs(tabId)).toBe(2);

    forceDisposeRuntime(tabId);

    expect(runtime.disposeCallCount).toBe(1);
    expect(getRuntimeCount()).toBe(0);
    expect(getRefs(tabId)).toBe(0);
  });

  it('forceDisposeRuntime: 存在しない tabId に対して呼んでも例外を投げない', () => {
    expect(() => forceDisposeRuntime('non-existent-tab')).not.toThrow();
  });

  it('releaseRuntime: forceDispose 後に release が来ても safe（no-op）', async () => {
    const tabId = 'test-release-after-force';
    const runtime = makeRuntime();
    acquireRuntime(tabId, () => runtime);

    forceDisposeRuntime(tabId);
    releaseRuntime(tabId);  // Map から既に削除されているため no-op のはず

    await Promise.resolve();

    // dispose は forceDispose の 1 回のみ
    expect(runtime.disposeCallCount).toBe(1);
  });
});

// --- recyclePty ---

/**
 * 呼び出し順序を記録する spy 付き TerminalRuntime を生成するヘルパー。
 * F5: recyclePty の処理順・no-op・forceDisposeRuntime 非呼び出しを検証するために使用。
 */
function makeRuntimeWithOrder(): TerminalRuntime & { callOrder: string[] } {
  const callOrder: string[] = [];
  const sub = { dispose: vi.fn() };

  const runtime: TerminalRuntime & { callOrder: string[] } = {
    get term() { return {} as never; },
    get fitAddon() { return {} as never; },
    get ptyHandle() { return null; },
    get pendingInputs() { return []; },
    onDataSub: sub,
    setOnEvent: vi.fn(),
    startSpawn: vi.fn(() => { callOrder.push('startSpawn'); }),
    resetForRecycle: vi.fn(() => { callOrder.push('resetForRecycle'); }),
    dispose: vi.fn(() => { callOrder.push('dispose'); }),
    get callOrder() { return callOrder; },
  };
  return runtime;
}

describe('recyclePty', () => {
  it('F5-1: ptyHandle.dispose() → resetForRecycle() → startSpawn() の順で呼ばれる', () => {
    const tabId = 'test-recycle-order';
    const runtime = makeRuntimeWithOrder();
    acquireRuntime(tabId, () => runtime);

    const onError = vi.fn();
    recyclePty(tabId, { cols: 80, rows: 24 }, onError);

    // dispose は ptyHandle が null のため void null?.dispose() = no-op だが、
    // resetForRecycle と startSpawn の順序は保証される
    expect(runtime.resetForRecycle).toHaveBeenCalledTimes(1);
    expect(runtime.startSpawn).toHaveBeenCalledTimes(1);
    // resetForRecycle → startSpawn の順であること
    expect(runtime.callOrder.indexOf('resetForRecycle')).toBeLessThan(
      runtime.callOrder.indexOf('startSpawn'),
    );

    forceDisposeRuntime(tabId);
  });

  it('F5-2: 存在しない tabId は no-op（例外を投げない）', () => {
    const onError = vi.fn();
    expect(() =>
      recyclePty('non-existent-recycle-tab', { cols: 80, rows: 24 }, onError),
    ).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('F5-3: forceDisposeRuntime は呼ばれない（xterm を維持して scrollback を保全）', () => {
    const tabId = 'test-recycle-no-force-dispose';
    const runtime = makeRuntimeWithOrder();
    acquireRuntime(tabId, () => runtime);

    const onError = vi.fn();
    recyclePty(tabId, { cols: 80, rows: 24 }, onError);

    // dispose は ptyHandle?.dispose() の呼び出しのみ（forceDisposeRuntime ではない）
    // forceDisposeRuntime を呼ぶと runtimes Map から削除されるが、Map はまだ有効のはず
    expect(getRuntimeCount()).toBeGreaterThanOrEqual(1);
    expect(getRefs(tabId)).toBe(1);

    forceDisposeRuntime(tabId);
  });
});
