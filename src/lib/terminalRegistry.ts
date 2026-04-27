import { Terminal as XTerm, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { PtyHandle, PtyEvent, SpawnOptions } from './pty';
import type { Settings } from '../types';
import { spawnPty, writePty, resizePty } from './pty';

/**
 * TerminalPane のライフサイクル全体を React 外で管理する runtime。
 * xterm / PTY / onData 購読 / pendingInputs バッファ / 状態フラグのすべての所有者。
 *
 * コア原則: runtime はコンポーネントスコープに依存しない。
 * TerminalPane は acquireRuntime 経由で runtime を取得し、メソッド呼び出しのみ行う。
 */
export interface TerminalRuntime {
  term: XTerm;
  fitAddon: FitAddon;
  /** PTY spawn 完了までは null */
  ptyHandle: PtyHandle | null;
  /** spawn 完了前に xterm が送出した入力（DSR-CPR 等）を貯めるバッファ */
  pendingInputs: string[];
  /** init() 内で 1 度だけ登録する onData 購読。dispose() で解放 */
  onDataSub: IDisposable;

  /**
   * PTY イベント受信時のコールバック。
   * TerminalPane の useEffect 内で登録し、cleanup で null を渡す。
   * null の場合 runtime は何もしない（unmount 後の書き込みを防ぐ）。
   */
  setOnEvent(handler: ((e: PtyEvent) => void) | null): void;

  /**
   * PTY spawn を開始する。内部で spawning フラグを管理し、
   * 二重呼び出し（ptyHandle セット済み or spawn 中）は no-op。
   */
  startSpawn(opts: SpawnOptions, onError: (e: Error) => void): void;

  /**
   * 全リソース解放。§3.2 の順序を厳守。
   * ResizeObserver の disconnect は TerminalPane の useEffect cleanup 側の責務。
   */
  dispose(): void;
}

// TODO (Unit D+E): OSC タイトル変更対応のため titleSub?: IDisposable を追加予定

interface Entry {
  refs: number;
  runtime: TerminalRuntime;
}

const runtimes = new Map<string, Entry>();

/**
 * TerminalRuntime を生成する内部ファクトリ。
 * TerminalPane からは createRuntime() 経由で呼ぶ。
 * テスト容易性のためモジュール外から import できる形で公開する。
 */
export function createRuntime(
  divEl: HTMLDivElement,
  settings: Settings,
  tabId: string,
  callbacks: {
    onLive: (ptyId: string) => void;
    onError: (msg: string) => void;
  },
): TerminalRuntime {
  let onEventHandler: ((e: PtyEvent) => void) | null = null;
  let isDisposed = false;
  let spawning = false;

  const term = new XTerm({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
  });

  term.open(divEl);

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  try {
    fitAddon.fit();
  } catch (e) {
    console.warn('[terminalRegistry] initial fit failed', e);
  }

  const pendingInputs: string[] = [];
  let ptyHandle: PtyHandle | null = null;

  // onData を spawn より先に登録して DSR-CPR 等を pendingInputs に貯める
  const onDataSub = term.onData((data) => {
    if (isDisposed) return;
    if (ptyHandle) {
      void writePty(ptyHandle.id, data).catch(() => {});
    } else {
      pendingInputs.push(data);
    }
  });

  const runtime: TerminalRuntime = {
    get term() { return term; },
    get fitAddon() { return fitAddon; },
    get ptyHandle() { return ptyHandle; },
    get pendingInputs() { return pendingInputs; },
    onDataSub,

    setOnEvent(handler) {
      if (isDisposed) return;
      onEventHandler = handler;
    },

    startSpawn(opts, onError) {
      if (spawning || ptyHandle !== null) return;
      spawning = true;

      spawnPty(opts, (e) => onEventHandler?.(e))
        .then((handle) => {
          if (isDisposed || !runtimes.has(tabId)) {
            // unmount 後 or forceDispose 後: PTY だけ確実に解放してリターン
            void handle.dispose();
            return;
          }
          ptyHandle = handle;
          for (const data of pendingInputs) {
            void writePty(handle.id, data).catch(() => {});
          }
          pendingInputs.length = 0;
          void resizePty(handle.id, term.cols, term.rows).catch(() => {});
          callbacks.onLive(handle.id);
        })
        .catch((e) => {
          spawning = false;
          if (isDisposed) return;
          onError(e instanceof Error ? e : new Error(String(e)));
        });
    },

    dispose() {
      // §3.2 の順序を厳守。この順序を変えない。
      isDisposed = true;
      onEventHandler = null;
      onDataSub.dispose();
      fitAddon.dispose();
      void ptyHandle?.dispose();  // fire-and-forget
      term.dispose();
    },
  };

  return runtime;
}

/**
 * runtime を取得 or 初回 init。
 * - 初回呼び出し: init() を呼び、refs=1 で登録
 * - 2 回目以降: refs を増やして既存 runtime を返す（StrictMode の再 mount 対策）
 */
export function acquireRuntime(
  tabId: string,
  init: () => TerminalRuntime,
): TerminalRuntime {
  const entry = runtimes.get(tabId);
  if (entry) {
    entry.refs++;
    return entry.runtime;
  }
  const runtime = init();
  runtimes.set(tabId, { refs: 1, runtime });
  return runtime;
}

/**
 * runtime を解放。refs が 0 になったら queueMicrotask で dispose。
 * queueMicrotask の間に StrictMode の再 mount が来れば refs が戻り dispose されない。
 */
export function releaseRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    if (entry.refs < 0) {
      console.warn(
        `[terminalRegistry] refs went negative for ${tabId}. acquire/release asymmetry bug?`,
      );
      entry.refs = 0;
    }
    queueMicrotask(() => {
      const e = runtimes.get(tabId);
      if (e && e.refs === 0) {
        e.runtime.dispose();
        runtimes.delete(tabId);
      }
    });
  }
}

/**
 * タブ削除時の即時破棄（参照カウントを無視）。
 * store の removeTab から呼ぶ。set() より前に呼ぶことで
 * React が TerminalPane を unmount して releaseRuntime が来ても無害化される。
 */
export function forceDisposeRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.runtime.dispose();
  runtimes.delete(tabId);
}

/** テスト用: 登録済みの runtime 数を返す */
export function getRuntimeCount(): number {
  return runtimes.size;
}

/** テスト用: 特定 tabId の参照カウントを返す */
export function getRefs(tabId: string): number {
  return runtimes.get(tabId)?.refs ?? 0;
}

/**
 * TODO (Unit H): HMR 時の xterm/PTY リーク対策として forceDisposeAll() を追加予定。
 * Vite の import.meta.hot.dispose フックから呼ぶことで、HMR 更新時に全 runtime を
 * 強制 dispose して、ゾンビ xterm が残るのを防ぐ。
 */
