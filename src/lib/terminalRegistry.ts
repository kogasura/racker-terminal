import type { Terminal as XTerm, IDisposable } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { PtyHandle } from './pty';

/**
 * TerminalPane コンポーネントのライフサイクルを React の外で管理する。
 * StrictMode の mount → cleanup → mount サイクルを参照カウントで吸収し、
 * 同じ tabId に対して xterm / PTY を二重に初期化しないようにする。
 */
export interface TerminalRuntime {
  term: XTerm;
  fitAddon: FitAddon;
  /** PTY spawn 完了までは null */
  ptyHandle: PtyHandle | null;
  onDataSub?: IDisposable;
  /** 全リソース解放 */
  dispose: () => void;
}

interface Entry {
  refs: number;
  runtime: TerminalRuntime;
}

const runtimes = new Map<string, Entry>();

/**
 * runtime を取得 or 初回 init。
 * - 初回呼び出し: init() を呼び、refs=1 で登録
 * - 2 回目以降: refs を増やして既存 runtime を返す（StrictMode の再 mount 対策）
 *
 * 注意: init() が throw した場合、Map に登録されず例外が呼び出し元に伝播する。
 * 呼び出し側（TerminalPane の useEffect 等）で try/catch しても良い。
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
 * StrictMode のサイクルではなく、ユーザーが「タブを閉じる」を押したときに使う。
 */
export function forceDisposeRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.runtime.dispose();
  runtimes.delete(tabId);
}

/**
 * テスト用: 登録済みの runtime 数を返す
 */
export function getRuntimeCount(): number {
  return runtimes.size;
}

/**
 * テスト用: 特定 tabId の参照カウントを返す
 */
export function getRefs(tabId: string): number {
  return runtimes.get(tabId)?.refs ?? 0;
}

/**
 * TODO (Unit H): HMR 時の xterm/PTY リーク対策として forceDisposeAll() を追加予定。
 * Vite の import.meta.hot.dispose フックから呼ぶことで、HMR 更新時に全 runtime を
 * 強制 dispose して、ゾンビ xterm が残るのを防ぐ。
 */
