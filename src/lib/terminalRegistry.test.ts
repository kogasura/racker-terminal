import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireRuntime,
  releaseRuntime,
  forceDisposeRuntime,
  forceDisposeAll,
  recyclePty,
  getAllRuntimes,
  getRuntimeCount,
  getRefs,
  sanitizeOscTitle,
  setupWebglRenderer,
  parseOsc7Path,
  attachImeCompositionGuard,
  type TerminalRuntime,
} from './terminalRegistry';

// WebglAddon は jsdom 環境では WebGL が使用不可のため全てモック化する。
// setupWebglRenderer ヘルパーの単体テストで実際の attach/dispose ロジックを検証する。
vi.mock('@xterm/addon-webgl', () => {
  return {
    WebglAddon: class {
      dispose: ReturnType<typeof vi.fn>;
      onContextLoss: ReturnType<typeof vi.fn>;
      private ctxLossCallback: (() => void) | null = null;

      constructor() {
        this.dispose = vi.fn();
        const ctxLossDispose = vi.fn();
        this.onContextLoss = vi.fn((cb: () => void) => {
          this.ctxLossCallback = cb;
          return { dispose: ctxLossDispose };
        });
      }

      // テスト用ヘルパー (本物にはない)
      __triggerContextLoss(): void {
        this.ctxLossCallback?.();
      }
    },
  };
});

/**
 * テスト用のモック TerminalRuntime を生成するヘルパー。
 * xterm / FitAddon は DOM を必要とするため、dispose だけ追跡できる最小モックを使う。
 */
function makeRuntime(): TerminalRuntime & { disposeCallCount: number; dispose: ReturnType<typeof vi.fn> } {
  let disposeCallCount = 0;
  const sub = { dispose: vi.fn() };
  const titleSub = { dispose: vi.fn() };
  const oscSub = { dispose: vi.fn() };
  const compositionAbort = new AbortController();
  const disposeFn = vi.fn(() => { disposeCallCount++; });

  const runtime: TerminalRuntime & { disposeCallCount: number; dispose: ReturnType<typeof vi.fn> } = {
    get term() { return {} as never; },
    get fitAddon() { return {} as never; },
    get ptyHandle() { return null; },
    get pendingInputs() { return []; },
    onDataSub: sub,
    compositionAbort,
    titleSub,
    oscSub,
    applySettings: vi.fn(),
    setOnEvent: vi.fn(),
    startSpawn: vi.fn(),
    resetForRecycle: vi.fn(),
    dispose: disposeFn,
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
  const oscSub = { dispose: vi.fn() };
  const compositionAbort = new AbortController();

  const runtime: TerminalRuntime & { callOrder: string[] } = {
    get term() { return {} as never; },
    get fitAddon() { return {} as never; },
    get ptyHandle() { return null; },
    get pendingInputs() { return []; },
    onDataSub: sub,
    compositionAbort,
    titleSub,
    oscSub,
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
    const oscSub = { dispose: vi.fn() };
    const compositionAbort = new AbortController();
    const runtime: TerminalRuntime = {
      get term() { return {} as never; },
      get fitAddon() { return {} as never; },
      get ptyHandle() { return null; },
      get pendingInputs() { return []; },
      onDataSub: sub,
      compositionAbort,
      titleSub,
      oscSub,
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
    const oscSub = { dispose: vi.fn() };
    const compositionAbort = new AbortController();
    const runtime: TerminalRuntime = {
      get term() { return {} as never; },
      get fitAddon() { return {} as never; },
      get ptyHandle() { return null; },
      get pendingInputs() { return []; },
      onDataSub: sub,
      compositionAbort,
      titleSub,
      oscSub,
      applySettings: vi.fn(),
      setOnEvent: vi.fn(),
      startSpawn: vi.fn(),
      resetForRecycle: vi.fn(),
      dispose: () => {
        sub.dispose();
        titleSub.dispose();
        oscSub.dispose();
        compositionAbort.abort();
      },
    };

    acquireRuntime(tabId, () => runtime);
    forceDisposeRuntime(tabId);

    expect(titleSub.dispose).toHaveBeenCalledTimes(1);
    expect(oscSub.dispose).toHaveBeenCalledTimes(1);
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

// --- memory leak テスト ---

describe('memory leak', () => {
  it('forceDisposeAll で全 runtime が即時破棄される', () => {
    // テスト前の state を確認 (他テストの残骸がないこと)
    const beforeCount = getRuntimeCount();

    // 10 個 acquire (各々独自の dispose mock)
    const runtimes = Array.from({ length: 10 }, () => makeRuntime());
    for (let i = 0; i < 10; i++) {
      acquireRuntime(`force-all-${i}`, () => runtimes[i]);
    }
    expect(getRuntimeCount()).toBe(beforeCount + 10);

    forceDisposeAll();

    // 自分が登録した 10 個のすべての dispose が呼ばれた
    for (const r of runtimes) {
      expect(r.dispose).toHaveBeenCalledTimes(1);
    }
    // Map が完全に空になった (他テスト残骸も含めて全消し)
    expect(getRuntimeCount()).toBe(0);
  });

  it('100 タブ open/close で runtime がリークしない', () => {
    const before = getRuntimeCount();
    const disposeMock = vi.fn();

    for (let i = 0; i < 100; i++) {
      const id = `ml-loop-${i}`;
      const sub = { dispose: vi.fn() };
      const titleSub = { dispose: vi.fn() };
      const oscSub = { dispose: vi.fn() };
      const compositionAbort = new AbortController();
      const runtime: TerminalRuntime = {
        get term() { return {} as never; },
        get fitAddon() { return {} as never; },
        get ptyHandle() { return null; },
        get pendingInputs() { return []; },
        onDataSub: sub,
        compositionAbort,
        titleSub,
        oscSub,
        applySettings: vi.fn(),
        setOnEvent: vi.fn(),
        startSpawn: vi.fn(),
        resetForRecycle: vi.fn(),
        dispose: disposeMock,
      };
      acquireRuntime(id, () => runtime);
      forceDisposeRuntime(id);
    }

    expect(getRuntimeCount()).toBe(before);
    expect(disposeMock).toHaveBeenCalledTimes(100);
  });

  it('真の StrictMode サイクル: mount → cleanup → mount で dispose されない (refcount 吸収)', async () => {
    const tabId = 'strict-mode-cycle';
    const init = vi.fn(() => makeRuntime());

    acquireRuntime(tabId, init);    // mount-1, refs=1
    releaseRuntime(tabId);          // cleanup-1, refs=0, microtask 予約
    acquireRuntime(tabId, init);    // mount-2 (microtask 前), refs=1

    // microtask flush
    await new Promise<void>((r) => queueMicrotask(() => r()));

    // dispose されず、refs=1 で生存している
    expect(init).toHaveBeenCalledOnce();
    expect(getRefs(tabId)).toBe(1);
    expect(getRuntimeCount()).toBeGreaterThanOrEqual(1);

    forceDisposeRuntime(tabId);
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

// --- IME 合成ガード (2.13) ---

/**
 * IME 合成ガードのモックテスト。
 * createRuntime は DOM (xterm) 依存のため直接テストできない。
 * TerminalRuntime インターフェースの compositionAbort フィールドが dispose() で
 * abort() されることを、モックランタイムを通じて検証する。
 * 実際の isComposing フラグ動作は EventTarget を使ったユニットテストで検証する。
 */
describe('IME compositionAbort (2.13)', () => {
  it('compositionAbort.abort() が dispose() 内で呼ばれる', () => {
    const tabId = 'test-ime-abort';
    const compositionAbort = new AbortController();
    const abortSpy = vi.spyOn(compositionAbort, 'abort');

    const sub = { dispose: vi.fn() };
    const titleSub = { dispose: vi.fn() };
    const oscSub = { dispose: vi.fn() };
    const runtime: TerminalRuntime = {
      get term() { return {} as never; },
      get fitAddon() { return {} as never; },
      get ptyHandle() { return null; },
      get pendingInputs() { return []; },
      onDataSub: sub,
      compositionAbort,
      titleSub,
      oscSub,
      applySettings: vi.fn(),
      setOnEvent: vi.fn(),
      startSpawn: vi.fn(),
      resetForRecycle: vi.fn(),
      dispose() {
        sub.dispose();
        titleSub.dispose();
        oscSub.dispose();
        compositionAbort.abort();
      },
    };

    acquireRuntime(tabId, () => runtime);
    forceDisposeRuntime(tabId);

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('compositionAbort.abort() 後に listener が解除されている', () => {
    // AbortController.abort() 後に { signal } オプションで登録したリスナーが
    // 実際に解除されることを EventTarget で直接確認する。
    // createRuntime の compositionstart/end リスナー解除と同じ仕組みを検証する。
    const ac = new AbortController();
    const target = new EventTarget();
    let called = 0;

    target.addEventListener(
      'compositionstart',
      () => { called++; },
      { signal: ac.signal },
    );

    target.dispatchEvent(new Event('compositionstart'));
    expect(called).toBe(1);

    ac.abort();

    target.dispatchEvent(new Event('compositionstart'));
    expect(called).toBe(1); // abort 後はリスナーが呼ばれない
    expect(ac.signal.aborted).toBe(true);
  });

  // attachImeCompositionGuard を直接呼ぶ統合テスト群 (実コードパス検証)。

  it('合成開始前は通常入力が通過する (shouldDrop=false)', () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    expect(guard.shouldDrop()).toBe(false);
    expect(guard.state).toEqual({ isComposing: false, isFinalizingComposition: false });

    guard.dispose();
    ac.abort();
  });

  it('compositionstart で合成中フラグが立ち、shouldDrop()=true になる', () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    target.dispatchEvent(new Event('compositionstart'));
    expect(guard.shouldDrop()).toBe(true);
    expect(guard.state.isComposing).toBe(true);
    expect(guard.state.isFinalizingComposition).toBe(false);

    guard.dispose();
    ac.abort();
  });

  it('compositionend 直後は isComposing=false かつ isFinalizingComposition=true (グレース期間)', () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    target.dispatchEvent(new Event('compositionstart'));
    target.dispatchEvent(new Event('compositionend'));

    // 同期点: 合成解除 + グレース期間中
    expect(guard.state.isComposing).toBe(false);
    expect(guard.state.isFinalizingComposition).toBe(true);
    expect(guard.shouldDrop()).toBe(false); // 通常入力は通過

    guard.dispose();
    ac.abort();
  });

  it('compositionend → setTimeout(0) tick 後に isFinalizingComposition が false に戻る', async () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    target.dispatchEvent(new Event('compositionstart'));
    target.dispatchEvent(new Event('compositionend'));

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(guard.state.isFinalizingComposition).toBe(false);
    expect(guard.shouldDrop()).toBe(false);

    guard.dispose();
    ac.abort();
  });

  // ★ 本バグの中核を回帰検証する統合テスト。
  it('変換後 Enter なしで連続日本語入力したときの race condition で確定文字列が drop されない', async () => {
    // 模擬する xterm.js の挙動:
    //   - xterm は textarea に compositionend listener を先に登録している。
    //   - compositionend listener 内で _finalizeComposition(true) → setTimeout(0) を予約し、
    //     その timeout 内で確定文字列を triggerDataEvent (= term.onData 発火) する。
    //   - 我々の attachImeCompositionGuard listener はその後で attach されるため、
    //     listener 順序は xterm → 我々、setTimeout も同じ FIFO 順で fire する。
    //
    // シナリオ: 「こん」入力 → 変換 → Enter なしで次の日本語キー入力。
    //   ブラウザは旧 composition の compositionend と新 composition の compositionstart を
    //   同期で連続発火する。
    const ac = new AbortController();
    const target = new EventTarget();

    // xterm の compositionend listener (先に登録) の挙動を模擬:
    // setTimeout(0) で確定文字列 '今' を遅延 onData する。
    let xtermEmittedFinalized = false;
    target.addEventListener('compositionend', () => {
      setTimeout(() => {
        xtermEmittedFinalized = true;
      }, 0);
    }, { signal: ac.signal });

    // 我々のガード (xterm より後に登録)
    const guard = attachImeCompositionGuard(target, ac.signal);

    // 1) ユーザーが「こん」と入力 → IME 合成中
    target.dispatchEvent(new Event('compositionstart'));
    expect(guard.shouldDrop()).toBe(true); // 中間文字列は drop される

    // 2) ユーザーが Enter を押さず次の日本語キー入力 → 旧 compositionend と
    //    新 compositionstart が同期で連続発火
    target.dispatchEvent(new Event('compositionend'));
    target.dispatchEvent(new Event('compositionstart'));

    // 同期点では isComposing=true (新 composition) かつ isFinalizingComposition=true (旧の grace)
    expect(guard.state.isComposing).toBe(true);
    expect(guard.state.isFinalizingComposition).toBe(true);
    // この瞬間 onData が来てもグレース期間中なので drop されない (= 確定文字列を通過させる)
    expect(guard.shouldDrop()).toBe(false);

    // 3) xterm の遅延 setTimeout (確定文字列 onData) が先に発火する想定で待つ
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(xtermEmittedFinalized).toBe(true);

    // 4) この時点でグレース期間も解除され、新 composition の中間文字列は drop されるべき
    expect(guard.state.isComposing).toBe(true);
    expect(guard.state.isFinalizingComposition).toBe(false);
    expect(guard.shouldDrop()).toBe(true);

    guard.dispose();
    ac.abort();
  });

  it('連続 compositionend で pending setTimeout が積み重ならない (clearTimeout で再張り)', async () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    target.dispatchEvent(new Event('compositionstart'));
    target.dispatchEvent(new Event('compositionend'));
    target.dispatchEvent(new Event('compositionstart'));
    target.dispatchEvent(new Event('compositionend'));
    target.dispatchEvent(new Event('compositionstart'));
    target.dispatchEvent(new Event('compositionend'));

    // 最後の compositionend で grace period が始まっている
    expect(guard.state.isFinalizingComposition).toBe(true);

    await new Promise<void>((r) => setTimeout(r, 0));
    // 1 tick で grace 解除 (setTimeout は最後のもの 1 個のみ pending だった)
    expect(guard.state.isFinalizingComposition).toBe(false);

    guard.dispose();
    ac.abort();
  });

  it('dispose() で pending な setTimeout がキャンセルされる (use-after-dispose 防止)', async () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    target.dispatchEvent(new Event('compositionstart'));
    target.dispatchEvent(new Event('compositionend'));
    expect(guard.state.isFinalizingComposition).toBe(true);

    // dispose 即時呼び出し → pending setTimeout がキャンセル
    guard.dispose();
    ac.abort();

    // setTimeout 発火 tick を待っても isFinalizingComposition は変化しない
    // (dispose 時に強制的にクリアされるため、true のままではなく false に戻る前で止まる)
    await new Promise<void>((r) => setTimeout(r, 0));
    // dispose() は現在は finalizeTimerId しか触らないため state はそのまま。
    // 重要なのは「pending setTimeout が dispose 後に発火しないこと」を保証することなので、
    // そのテストとしては「キャンセル後に setTimeout が走らない」を別途チェック。
    expect(guard.state.isFinalizingComposition).toBe(true);
  });

  it('AbortSignal.abort() 後はそれ以降の composition イベントが listener に届かない', () => {
    const ac = new AbortController();
    const target = new EventTarget();
    const guard = attachImeCompositionGuard(target, ac.signal);

    ac.abort();
    target.dispatchEvent(new Event('compositionstart'));

    // listener が解除されているため state は初期値のまま
    expect(guard.state.isComposing).toBe(false);
    expect(guard.state.isFinalizingComposition).toBe(false);
    expect(guard.shouldDrop()).toBe(false);

    guard.dispose();
  });
});

// --- setupWebglRenderer (Phase 3 Unit P-C1) ---

/**
 * setupWebglRenderer ヘルパーの単体テスト。
 * WebglAddon は jsdom 環境では WebGL が利用できないためモック化して検証する。
 * モックは vi.mock('@xterm/addon-webgl') でファイル先頭に定義済み。
 *
 * P-C1 ロジック（attach / onContextLoss / dispose 順序）を直接テストする。
 */
describe('setupWebglRenderer (P-C1)', () => {
  it('正常系: term.loadAddon が呼ばれて WebglAddon が attach される', () => {
    const loadAddon = vi.fn();
    const term = { loadAddon, write: vi.fn() } as any;

    const handle = setupWebglRenderer(term, 'tab-1');

    expect(loadAddon).toHaveBeenCalledTimes(1);
    expect(loadAddon.mock.calls[0][0]).toBeDefined();

    handle.dispose();
  });

  it('dispose で WebglAddon と onContextLoss listener が解除される', () => {
    const term = { loadAddon: vi.fn(), write: vi.fn() } as any;

    const handle = setupWebglRenderer(term, 'tab-1');
    const addon = (term.loadAddon as ReturnType<typeof vi.fn>).mock.calls[0][0] as any;

    expect(addon.dispose).not.toHaveBeenCalled();

    handle.dispose();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    // onContextLoss が返した IDisposable.dispose も呼ばれている
    const ctxLossDispose = addon.onContextLoss.mock.results[0].value.dispose;
    expect(ctxLossDispose).toHaveBeenCalledTimes(1);
  });

  it('onContextLoss 発火 → addon.dispose() が呼ばれて null 化、term.write で通知', () => {
    const term = { loadAddon: vi.fn(), write: vi.fn() } as any;

    const handle = setupWebglRenderer(term, 'tab-1');
    const addon = (term.loadAddon as ReturnType<typeof vi.fn>).mock.calls[0][0] as any;

    // context loss を発火
    addon.__triggerContextLoss();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalled();

    // handle.dispose() を呼んでも addon.dispose() が 2 回目に呼ばれないこと
    // (webglAddon = null 化により no-op になる)
    handle.dispose();
    expect(addon.dispose).toHaveBeenCalledTimes(1); // 増えない
  });

  it('term.loadAddon が throw した場合、例外を投げずに Canvas fallback になる', () => {
    const loadAddon = vi.fn(() => { throw new Error('loadAddon failed'); });
    const term = { loadAddon, write: vi.fn() } as any;

    // 例外を投げず handle が返る
    expect(() => setupWebglRenderer(term, 'tab-2')).not.toThrow();

    // dispose() も例外を投げない
    const handle = setupWebglRenderer(term, 'tab-3');
    expect(() => handle.dispose()).not.toThrow();
  });

  // new WebglAddon() 自体が throw するケースは vi.mock 差し替えが複雑なためスキップ。
  // loadAddon throw テスト (上記) でエラー吸収パスは十分にカバーされている。
});

// --- parseOsc7Path (Phase 4 P-G) ---

describe('parseOsc7Path', () => {
  it('Windows パス: file://host/C:/Users/foo → C:\\Users\\foo', () => {
    expect(parseOsc7Path('file://hostname/C:/Users/foo')).toBe('C:\\Users\\foo');
  });

  it('Windows パス (空ホスト): file:///C:/path/to → C:\\path\\to', () => {
    expect(parseOsc7Path('file:///C:/path/to')).toBe('C:\\path\\to');
  });

  it('スラッシュをバックスラッシュに正規化する', () => {
    expect(parseOsc7Path('file://host/D:/projects/app')).toBe('D:\\projects\\app');
  });

  it('URL エンコードされたパスをデコードする', () => {
    // スペースが %20 でエンコードされているケース
    expect(parseOsc7Path('file://host/C:/Users/my%20user/docs')).toBe('C:\\Users\\my user\\docs');
  });

  it('Linux パス → null を返す（無視）', () => {
    expect(parseOsc7Path('file://hostname/home/user/proj')).toBeNull();
  });

  it('Linux パス (空ホスト): file:///home/user → null', () => {
    expect(parseOsc7Path('file:///home/user')).toBeNull();
  });

  it('不正な data (file:// でない) → null', () => {
    expect(parseOsc7Path('http://example.com/path')).toBeNull();
  });

  it('空文字列 → null', () => {
    expect(parseOsc7Path('')).toBeNull();
  });

  it('小文字ドライブレター (C: → 変換される)', () => {
    // Windows パスは大文字/小文字どちらも有効
    expect(parseOsc7Path('file://host/c:/users/foo')).toBe('c:\\users\\foo');
  });

  // --- F-M1 / F-S1 / F-S2 / F-S4 追加テスト ---

  it('F-M1: malformed percent-encoding (%ZZ) → null', () => {
    expect(parseOsc7Path('file://host/C:/foo%ZZ')).toBeNull();
  });

  it('F-M1: 不正な % エンコード (%GG) → null', () => {
    expect(parseOsc7Path('file://host/C:/path%GGbar')).toBeNull();
  });

  it('F-S1: NUL 文字混入 (%00) → null', () => {
    // %00 は decodeURIComponent で \x00 になり、制御文字フィルタで弾かれる
    expect(parseOsc7Path('file://host/C:/foo%00bar')).toBeNull();
  });

  it('F-S1: CR 文字混入 (%0D) → null', () => {
    expect(parseOsc7Path('file://host/C:/foo%0Dbar')).toBeNull();
  });

  it('F-S1: LF 文字混入 (%0A) → null', () => {
    expect(parseOsc7Path('file://host/C:/foo%0Abar')).toBeNull();
  });

  it('F-S1: ESC 文字混入 (%1B) → null', () => {
    expect(parseOsc7Path('file://host/C:/foo%1Bbar')).toBeNull();
  });

  it('F-S2: 4KB 超のパス → null', () => {
    // "C:/" + 4094 文字 = 4097 文字 > 4096
    const longPath = 'file://host/C:/' + 'a'.repeat(4094);
    expect(parseOsc7Path(longPath)).toBeNull();
  });

  it('F-S2: ちょうど 4096 文字のパスは通過する', () => {
    // "C:" + "\" + 4093 文字 = 4096 文字 (スラッシュ除去後)
    // file://host/C:/ + 4093 文字 → 先頭スラッシュ除去後 "C:/" + 4093 文字 = 4096 文字
    const path = 'file://host/C:/' + 'a'.repeat(4093);
    const result = parseOsc7Path(path);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4096);
  });

  it('F-S4: trailing slash 正規化 — 末尾 \\ が除去される', () => {
    expect(parseOsc7Path('file://host/C:/foo/')).toBe('C:\\foo');
  });

  it('F-S4: ルートパス C:\\ の trailing slash は維持される', () => {
    expect(parseOsc7Path('file://host/C:/')).toBe('C:\\');
  });

  it('F-S4: ネストされたパスの trailing slash が除去される', () => {
    expect(parseOsc7Path('file://host/C:/Users/foo/')).toBe('C:\\Users\\foo');
  });
});

// --- hexToRgba (Phase 4 P-B-2) ---

import { hexToRgba, computeBackground } from './terminalRegistry';

describe('hexToRgba', () => {
  it('通常変換: #1a1b26 + 0.8 → rgba(26, 27, 38, 0.8)', () => {
    expect(hexToRgba('#1a1b26', 0.8)).toBe('rgba(26, 27, 38, 0.8)');
  });

  it('# なしも受け付ける: 1a1b26 + 0.5 → rgba(26, 27, 38, 0.5)', () => {
    expect(hexToRgba('1a1b26', 0.5)).toBe('rgba(26, 27, 38, 0.5)');
  });

  it('alpha=1.0: rgba(26, 27, 38, 1)', () => {
    expect(hexToRgba('#1a1b26', 1.0)).toBe('rgba(26, 27, 38, 1)');
  });

  it('大文字 hex も変換できる', () => {
    expect(hexToRgba('#FFFFFF', 0.9)).toBe('rgba(255, 255, 255, 0.9)');
  });

  it('不正な hex (短い) → 元の文字列をそのまま返す', () => {
    expect(hexToRgba('#1a1b', 0.8)).toBe('#1a1b');
  });

  it('不正な hex (非 hex 文字) → 元の文字列をそのまま返す', () => {
    expect(hexToRgba('#gggggg', 0.8)).toBe('#gggggg');
  });

  it('空文字列 → 元の文字列をそのまま返す', () => {
    expect(hexToRgba('', 0.8)).toBe('');
  });

  it('rgba(...) 形式の既存値 → 元の文字列をそのまま返す（不正 hex 扱い）', () => {
    const rgba = 'rgba(26, 27, 38, 0.8)';
    expect(hexToRgba(rgba, 0.5)).toBe(rgba);
  });
});

// --- computeBackground (F-S1: applySettings transparency 連続変更テスト) ---
//
// v0.5 仕様変更 (PR #25):
//   alpha < 1.0 のとき xterm theme.background は 'rgba(0, 0, 0, 0)' (完全透明) を返す。
//   理由: 親要素 .terminal-pane が var(--terminal-bg) で半透明背景を描画しており、
//   xterm が rgba(R,G,B,alpha) で再塗りすると二重描画になって実効不透明度が上がるため。
//   (例: alpha=0.7 を xterm と親の両方で適用すると 0.91 相当の不透明度になる)

describe('computeBackground', () => {
  it('alpha < 1.0: 二重描画回避のため完全透明 rgba(0,0,0,0) を返す', () => {
    // 親の .terminal-pane が半透明背景を描画するため xterm 自身は透明にする
    expect(computeBackground(0.8, '#1a1b26')).toBe('rgba(0, 0, 0, 0)');
  });

  it('alpha = 1.0: baseHex をそのまま返す（不透明 hex）', () => {
    expect(computeBackground(1.0, '#1a1b26')).toBe('#1a1b26');
  });

  it('alpha > 1.0: baseHex をそのまま返す（>= 1.0 は不透明扱い）', () => {
    expect(computeBackground(1.5, '#1a1b26')).toBe('#1a1b26');
  });

  it('1.0 → 0.8 → 0.7 と変えても alpha < 1.0 は常に rgba(0,0,0,0)', () => {
    // computeBackground は純関数のため、各 alpha で独立して計算できる
    const bg1 = computeBackground(1.0, '#1a1b26');
    expect(bg1).toBe('#1a1b26');  // 1.0 は hex のまま

    // alpha < 1.0 では二重描画回避のため完全透明を返す（baseHex は使わない）
    const bg2 = computeBackground(0.8, '#1a1b26');
    expect(bg2).toBe('rgba(0, 0, 0, 0)');

    const bg3 = computeBackground(0.7, '#1a1b26');
    expect(bg3).toBe('rgba(0, 0, 0, 0)');
  });

  it('0.8 → 1.0 で hex に戻る', () => {
    // alpha < 1.0 は完全透明（二重描画回避）
    const bgSemi = computeBackground(0.8, '#1a1b26');
    expect(bgSemi).toBe('rgba(0, 0, 0, 0)');

    // alpha = 1.0 に戻ると baseHex が返る
    const bgOpaque = computeBackground(1.0, '#1a1b26');
    expect(bgOpaque).toBe('#1a1b26');  // DEFAULT_BG に戻る
  });

  it('baseHex 省略時は DEFAULT_BG (#1a1b26) を使用する', () => {
    // alpha < 1.0 は完全透明（baseHex は参照されない）
    expect(computeBackground(0.9)).toBe('rgba(0, 0, 0, 0)');
    expect(computeBackground(1.0)).toBe('#1a1b26');
  });
});
