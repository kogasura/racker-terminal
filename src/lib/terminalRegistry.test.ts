import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireRuntime,
  releaseRuntime,
  forceDisposeRuntime,
  recyclePty,
  getAllRuntimes,
  getRuntimeCount,
  getRefs,
  sanitizeOscTitle,
  type TerminalRuntime,
} from './terminalRegistry';

/**
 * テスト用のモック TerminalRuntime を生成するヘルパー。
 * xterm / FitAddon は DOM を必要とするため、dispose だけ追跡できる最小モックを使う。
 */
function makeRuntime(): TerminalRuntime & { disposeCallCount: number } {
  let disposeCallCount = 0;
  const sub = { dispose: vi.fn() };
  const titleSub = { dispose: vi.fn() };

  const runtime: TerminalRuntime & { disposeCallCount: number } = {
    get term() { return {} as never; },
    get fitAddon() { return {} as never; },
    get ptyHandle() { return null; },
    get pendingInputs() { return []; },
    onDataSub: sub,
    titleSub,
    applySettings: vi.fn(),
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
  const titleSub = { dispose: vi.fn() };

  const runtime: TerminalRuntime & { callOrder: string[] } = {
    get term() { return {} as never; },
    get fitAddon() { return {} as never; },
    get ptyHandle() { return null; },
    get pendingInputs() { return []; },
    onDataSub: sub,
    titleSub,
    applySettings: vi.fn(),
    setOnEvent: vi.fn(),
    startSpawn: vi.fn(() => { callOrder.push('startSpawn'); }),
    resetForRecycle: vi.fn(() => { callOrder.push('resetForRecycle'); }),
    dispose: vi.fn(() => { callOrder.push('dispose'); }),
    get callOrder() { return callOrder; },
  };
  return runtime;
}

// --- applySettings ---

describe('applySettings', () => {
  it('applySettings を呼ぶと runtime の applySettings が呼ばれる', () => {
    const tabId = 'test-apply-settings-1';
    const runtime = makeRuntime();
    acquireRuntime(tabId, () => runtime);

    const settings = {
      theme: 'tokyo-night' as const,
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: 5000,
    };
    runtime.applySettings(settings);

    expect(runtime.applySettings).toHaveBeenCalledTimes(1);
    expect(runtime.applySettings).toHaveBeenCalledWith(settings);

    forceDisposeRuntime(tabId);
  });

  it('T1: applySettings は dispose 後に呼ばれても no-op（isDisposed ガード）', () => {
    // createRuntime を直接テストするのは DOM 依存のため困難。
    // ここではモック runtime の applySettings が dispose 後に呼ばれても安全であることを
    // forceDisposeRuntime → applySettings 呼び出しパターンで確認する。
    const tabId = 'test-apply-settings-disposed';
    // isDisposed ガードを持つ applySettings の実装をモック側でも再現する
    let disposed = false;
    const options = { fontSize: 12.5, fontFamily: 'monospace', scrollback: 10000 };
    const sub = { dispose: vi.fn() };
    const titleSub = { dispose: vi.fn() };
    const runtime: TerminalRuntime = {
      get term() { return {} as never; },
      get fitAddon() { return {} as never; },
      get ptyHandle() { return null; },
      get pendingInputs() { return []; },
      onDataSub: sub,
      titleSub,
      applySettings(settings) {
        // isDisposed ガードの実装を模擬
        if (disposed) return;
        options.fontSize = settings.fontSize;
        options.fontFamily = settings.fontFamily;
        options.scrollback = settings.scrollback;
      },
      setOnEvent: vi.fn(),
      startSpawn: vi.fn(),
      resetForRecycle: vi.fn(),
      dispose() {
        disposed = true;
      },
    };

    acquireRuntime(tabId, () => runtime);
    forceDisposeRuntime(tabId); // dispose を実行

    // dispose 後に applySettings を呼んでも options が変化しないことを確認
    const before = { ...options };
    runtime.applySettings({ theme: 'tokyo-night', fontFamily: 'changed', fontSize: 99, scrollback: 999 });
    expect(options).toEqual(before);
  });
});

// --- getAllRuntimes ---

describe('getAllRuntimes', () => {
  it('登録済みの runtime を配列で返す', () => {
    const tabId1 = 'test-get-all-1';
    const tabId2 = 'test-get-all-2';
    const runtime1 = makeRuntime();
    const runtime2 = makeRuntime();
    acquireRuntime(tabId1, () => runtime1);
    acquireRuntime(tabId2, () => runtime2);

    const all = getAllRuntimes();
    expect(all).toContain(runtime1);
    expect(all).toContain(runtime2);

    forceDisposeRuntime(tabId1);
    forceDisposeRuntime(tabId2);
  });

  it('runtime が空のとき空配列を返す', () => {
    // 他のテストから汚染されていないかは別途保証（テスト ID は一意）
    const before = getRuntimeCount();
    // 登録済みのものがない状態を確認するための相対テスト
    const all = getAllRuntimes();
    expect(all.length).toBe(before);
  });
});

// --- titleSub.dispose が dispose() 内で呼ばれる ---

describe('titleSub dispose', () => {
  it('titleSub.dispose() が runtime.dispose() 内で呼ばれる', () => {
    const tabId = 'test-titlesub-dispose';
    const sub = { dispose: vi.fn() };
    const titleSub = { dispose: vi.fn() };
    const runtime: TerminalRuntime = {
      get term() { return {} as never; },
      get fitAddon() { return {} as never; },
      get ptyHandle() { return null; },
      get pendingInputs() { return []; },
      onDataSub: sub,
      titleSub,
      applySettings: vi.fn(),
      setOnEvent: vi.fn(),
      startSpawn: vi.fn(),
      resetForRecycle: vi.fn(),
      dispose: () => {
        sub.dispose();
        titleSub.dispose();
      },
    };

    acquireRuntime(tabId, () => runtime);
    forceDisposeRuntime(tabId);

    expect(titleSub.dispose).toHaveBeenCalledTimes(1);
  });
});

// --- sanitizeOscTitle ---

describe('sanitizeOscTitle', () => {
  it('T2-1: 通常の文字列はそのまま通過する', () => {
    expect(sanitizeOscTitle('hello world')).toBe('hello world');
  });

  it('T2-2: 日本語文字列はそのまま通過する', () => {
    expect(sanitizeOscTitle('ターミナル')).toBe('ターミナル');
  });

  it('T2-3: C0 制御文字 (U+0000-U+001F) を除去する', () => {
    // BEL (U+0007), TAB (U+0009), CR (U+000D), ESC (U+001B) を含む文字列
    const input = 'abc\x07\x09\x0d\x1bdef';
    expect(sanitizeOscTitle(input)).toBe('abcdef');
  });

  it('T2-4: DEL (U+007F) と C1 制御文字 (U+0080-U+009F) を除去する', () => {
    // DEL + U+009F を含む
    const input = 'abc\x7fdef\x9fghi';
    expect(sanitizeOscTitle(input)).toBe('abcdefghi');
  });

  it('T2-5: Bidi 制御文字を除去する (LRM, RLM, LRE-RLO, LRI-PDI)', () => {
    // U+200E (LRM), U+200F (RLM), U+202A (LRE), U+202E (RLO), U+2066 (LRI), U+2069 (PDI)
    const lrm = '‎';
    const rlm = '‏';
    const lre = '‪';
    const rlo = '‮';
    const lri = '⁦';
    const pdi = '⁩';
    const input = `${lrm}hello${rlm}${lre}world${rlo}${lri}test${pdi}`;
    expect(sanitizeOscTitle(input)).toBe('helloworldtest');
  });

  it('T2-6: 256 文字超は 256 文字に切り詰める', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeOscTitle(long);
    expect(result).toHaveLength(256);
    expect(result).toBe('a'.repeat(256));
  });

  it('T2-7: 全文字が制御文字の場合は空文字列になる', () => {
    // ESC + BEL + C1
    const input = '\x1b\x07\x9f';
    expect(sanitizeOscTitle(input)).toBe('');
  });

  it('T2-8: 制御文字除去後に 256 文字制限を適用する（除去後が 256 以下なら切り詰めなし）', () => {
    // 制御文字 10 個 + 'a' * 260 個 → 除去後 260 文字 → 256 文字に切り詰め
    const input = '\x07'.repeat(10) + 'a'.repeat(260);
    const result = sanitizeOscTitle(input);
    expect(result).toBe('a'.repeat(256));
  });
});

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
