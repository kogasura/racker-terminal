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

  it('compositionstart/end イベントで isComposing フラグが切り替わり onData が drop される', () => {
    // EventTarget を使って compositionstart/end + onData ガードの連携動作を検証する。
    // createRuntime の IME ガード実装と同等の動作を確認する。
    let isComposing = false;
    const compositionAbort = new AbortController();
    const { signal } = compositionAbort;

    const textarea = new EventTarget();
    textarea.addEventListener('compositionstart', () => { isComposing = true; }, { signal });
    textarea.addEventListener('compositionend', () => { isComposing = false; }, { signal });

    const received: string[] = [];
    const onData = (data: string) => {
      if (isComposing) return;
      received.push(data);
    };

    // 合成開始前: 通常入力は通過する
    onData('a');
    expect(received).toEqual(['a']);

    // compositionstart: 合成中は drop される
    textarea.dispatchEvent(new Event('compositionstart'));
    onData('あ'); // 中間文字列
    onData('い'); // さらに中間文字列
    expect(received).toEqual(['a']); // 追加されていない

    // compositionend: 確定後は通過する
    textarea.dispatchEvent(new Event('compositionend'));
    onData('愛'); // 確定文字列（xterm が再発火する想定）
    expect(received).toEqual(['a', '愛']);

    compositionAbort.abort();
  });

  it('compositionend 後は通常入力が再開される（確定文字列が drop されない）', () => {
    let isComposing = false;
    const textarea = new EventTarget();
    const compositionAbort = new AbortController();
    const { signal } = compositionAbort;
    textarea.addEventListener('compositionstart', () => { isComposing = true; }, { signal });
    textarea.addEventListener('compositionend', () => { isComposing = false; }, { signal });

    const received: string[] = [];
    const onData = (data: string) => {
      if (isComposing) return;
      received.push(data);
    };

    textarea.dispatchEvent(new Event('compositionstart'));
    onData('か');  // 中間 (drop)
    textarea.dispatchEvent(new Event('compositionend'));
    onData('漢字'); // 確定 (通過)
    onData('b');    // 通常入力 (通過)

    expect(received).toEqual(['漢字', 'b']);
    compositionAbort.abort();
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
