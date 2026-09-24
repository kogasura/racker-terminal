import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, cleanup } from '@testing-library/react';
import { Roots } from './Roots';
import App from './App';
import { useAppStore } from './store/appStore';

/**
 * アプリ全体の組み立てが成立することを確かめる。
 *
 * 個々のコンポーネントのスモークテスト (components/renderSmoke.test.tsx) は
 * **それぞれを単独で**描画しているため、Root どうしの入れ子や、離れた場所の View が
 * コンテキストを引けるか、といった「繋ぎ」の間違いを拾えない。
 *
 * 具体的に踏みたいのは次の類:
 * - `useEmit` / `use***View` を、対応する Root の外側で呼んでいる
 * - Root の入れ子の順序が逆で、依存する側が先に描画される
 * - 起動時の副作用 (最初のタブ作成、各種ポーリング) が mount 中に投げる
 *
 * これらはどれも「アプリを起動した瞬間に真っ白」という壊れ方をするので、
 * 単体テストが全部通っていても安心できない。
 */

// --- Tauri 側はすべて黙らせる (jsdom には無い) -------------------------------
vi.mock('@tauri-apps/api/core', () => ({
  // コマンドごとに Rust 側の戻り値の形へ寄せる。全部 null を返すと、実際には
  // 起きない形 (Vec<String> のはずが null) でコケてしまい、本物の不具合を隠す。
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'list_wsl_distros') return []; // Vec<String>
    return null; // get_launch_path など Option<T> を返すもの
  }),
  Channel: class {},
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn().mockResolvedValue('0.0.0-test') }));
vi.mock('@tauri-apps/api/window', () => ({
  Window: { getCurrent: () => ({ startDragging: vi.fn(), minimize: vi.fn(), close: vi.fn() }) },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onFocusChanged: vi.fn().mockResolvedValue(() => {}) }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }));

// --- xterm を抱えるランタイムは jsdom で動かせないので差し替える ---------------
vi.mock('./lib/terminalRegistry', () => ({
  acquireRuntime: vi.fn(() => ({
    term: {
      options: {},
      write: vi.fn(),
      focus: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: () => false,
      getSelection: () => '',
      clearSelection: vi.fn(),
    },
    fitAddon: { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) },
    ptyHandle: null,
    reclaimPty: vi.fn(),
    setOnEvent: vi.fn(),
    startSpawn: vi.fn().mockResolvedValue(undefined),
    wakeWebgl: vi.fn(),
    writeInput: vi.fn(),
    writeOutput: vi.fn(),
    applySettings: vi.fn(),
  })),
  releaseRuntime: vi.fn(),
  createRuntime: vi.fn(),
  recyclePty: vi.fn(),
  forceDisposeAll: vi.fn(),
  forceDisposeRuntime: vi.fn(),
  fitToConvergence: vi.fn(),
  getAllRuntimes: () => [],
  getRuntimeScreen: () => null,
  getRuntimeScreenIfDirty: () => null,
  recycleTextureAtlas: vi.fn(),
}));

// requestIdleCallback は jsdom に無い (グリフアトラスの手入れが使う)
beforeEach(() => {
  globalThis.requestIdleCallback ??= ((cb: IdleRequestCallback) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0)) as never;
  globalThis.cancelIdleCallback ??= ((id: number) => clearTimeout(id)) as never;

  useAppStore.setState({ groups: [], tabs: {}, favorites: [], activeTabId: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

describe('アプリ全体の組み立て', () => {
  it('Roots の下で App が描画できる', async () => {
    await act(async () => {
      render(
        <Roots>
          <App />
        </Roots>,
      );
    });

    // タイトルバー・サイドバーまで届いていること (Root から View モデルが降りている)
    expect(document.querySelector('.title-bar')).not.toBeNull();
    expect(document.querySelector('.sidebar')).not.toBeNull();
  });

  it('起動時の下ごしらえで、最初のグループとタブができる', async () => {
    await act(async () => {
      render(
        <Roots>
          <App />
        </Roots>,
      );
    });

    const state = useAppStore.getState();
    expect(state.groups.length).toBeGreaterThan(0);
    expect(Object.keys(state.tabs).length).toBeGreaterThan(0);
  });
});
