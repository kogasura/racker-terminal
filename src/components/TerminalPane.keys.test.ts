import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCtrlKey } from './TerminalPane';
import { useAppStore } from '../store/appStore';
import type { TerminalRuntime } from '../lib/terminalRegistry';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

/**
 * Ctrl 系キーバインドのディスパッチ検証。
 *
 * バインドはテーブル駆動で「先頭から順に match し最初の 1 つだけを実行する」
 * ため、並び順に意味がある（Ctrl+Shift+T が Ctrl+T より先、など）。
 * 誤って順序が入れ替わると別のショートカットが暴発するので、ここで固定する。
 */

/** xterm の最小スタブ。選択状態と writeInput の呼び出しだけ見る。 */
function makeRuntime(opts?: { selection?: string }): TerminalRuntime {
  const written: string[] = [];
  return {
    term: {
      hasSelection: () => (opts?.selection ?? '') !== '',
      getSelection: () => opts?.selection ?? '',
      clearSelection: () => {},
    },
    writeInput: (s: string) => written.push(s),
    // テストで参照するために生えさせておく
    __written: written,
  } as unknown as TerminalRuntime;
}

function key(init: Partial<KeyboardEvent> & { code?: string; key?: string }): KeyboardEvent {
  return {
    type: 'keydown',
    ctrlKey: true,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    code: '',
    key: '',
    preventDefault: () => {},
    ...init,
  } as KeyboardEvent;
}


/**
 * store の action を一時的に差し替えて呼び出しを記録する。
 *
 * vi.spyOn は使わない: zustand の set は state オブジェクトを作り直すため、
 * spy を張った関数がそのまま次の state に引き継がれ、restoreAllMocks でも
 * 現在の state からは剥がれず、呼び出し回数がテスト間で漏れる。
 */
function stubAction(name: string) {
  const calls: unknown[][] = [];
  const store = useAppStore as unknown as {
    getState: () => Record<string, unknown>;
    setState: (p: Record<string, unknown>) => void;
  };
  const original = store.getState()[name];
  store.setState({ [name]: (...args: unknown[]) => calls.push(args) });
  return { calls, restore: () => store.setState({ [name]: original }) };
}

describe('handleCtrlKey', () => {
  beforeEach(() => {
    // spyOn は store の action を差し替えるため、テスト間で呼び出し回数が漏れる
    vi.restoreAllMocks();
    useAppStore.setState({
      groups: [{ id: 'g1', title: 'Default', collapsed: false, tabIds: ['t1', 't2'] }],
      tabs: {
        t1: { id: 't1', groupId: 'g1', status: 'live' },
        t2: { id: 't2', groupId: 'g1', status: 'live' },
      },
      activeTabId: 't1',
      activeGroupId: 'g1',
      favorites: [],
      contextMenuOpen: false,
      closedTabs: [],
    });
  });

  it('keydown 以外は素通しする', () => {
    expect(handleCtrlKey(key({ type: 'keyup', code: 'KeyW' }), makeRuntime())).toBe(true);
  });

  it('Ctrl なしは素通しする', () => {
    expect(handleCtrlKey(key({ ctrlKey: false, code: 'KeyT' }), makeRuntime())).toBe(true);
  });

  it('IME 合成中は素通しする（タブ操作の暴発防止）', () => {
    expect(handleCtrlKey(key({ isComposing: true, code: 'Tab' }), makeRuntime())).toBe(true);
    expect(handleCtrlKey(key({ keyCode: 229, code: 'Tab' }), makeRuntime())).toBe(true);
  });

  it('ContextMenu が開いている間は素通しする', () => {
    useAppStore.setState({ contextMenuOpen: true });
    expect(handleCtrlKey(key({ code: 'Tab' }), makeRuntime())).toBe(true);
  });

  it('Ctrl+Shift+W でアクティブタブを閉じる', () => {
    const r = handleCtrlKey(key({ shiftKey: true, code: 'KeyW' }), makeRuntime());
    expect(r).toBe(false);
    expect(useAppStore.getState().tabs.t1).toBeUndefined();
  });

  it('Ctrl+Tab で次のタブへ移動する', () => {
    const r = handleCtrlKey(key({ code: 'Tab' }), makeRuntime());
    expect(r).toBe(false);
    expect(useAppStore.getState().activeTabId).toBe('t2');
  });

  it('Ctrl+Shift+Tab で前のタブへ移動する', () => {
    useAppStore.setState({ activeTabId: 't2' });
    const r = handleCtrlKey(key({ shiftKey: true, code: 'Tab' }), makeRuntime());
    expect(r).toBe(false);
    expect(useAppStore.getState().activeTabId).toBe('t1');
  });

  it('Ctrl+Enter は ESC+CR を送る', () => {
    const runtime = makeRuntime();
    const r = handleCtrlKey(key({ code: 'Enter' }), runtime);
    expect(r).toBe(false);
    expect((runtime as unknown as { __written: string[] }).__written).toEqual(['\x1b\r']);
  });

  it('Ctrl+NumpadEnter も ESC+CR を送る', () => {
    const runtime = makeRuntime();
    handleCtrlKey(key({ code: 'NumpadEnter' }), runtime);
    expect((runtime as unknown as { __written: string[] }).__written).toEqual(['\x1b\r']);
  });

  it('Ctrl+Shift+Enter は対象外（素通し）', () => {
    const runtime = makeRuntime();
    expect(handleCtrlKey(key({ shiftKey: true, code: 'Enter' }), runtime)).toBe(true);
    expect((runtime as unknown as { __written: string[] }).__written).toEqual([]);
  });

  it('Ctrl+C は選択が無ければ素通しする（SIGINT を通す）', () => {
    // 選択が無ければ preventDefault せず true を返し、SIGINT を PTY に通す
    expect(handleCtrlKey(key({ code: 'KeyC' }), makeRuntime())).toBe(true);
  });

  it('Ctrl+C は選択があればコピーして握りつぶす', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const r = handleCtrlKey(key({ code: 'KeyC' }), makeRuntime({ selection: 'copied' }));
    expect(r).toBe(false);
  });

  it('Ctrl+T は既定タブを開く', () => {
    const spawn = stubAction('spawnDefaultOrNew');
    const restore = stubAction('restoreLastClosedTab');
    handleCtrlKey(key({ code: 'KeyT' }), makeRuntime());
    expect(spawn.calls).toHaveLength(1);
    expect(restore.calls).toHaveLength(0);
    spawn.restore();
    restore.restore();
  });

  it('Ctrl+Shift+T は閉じたタブを復元する（Ctrl+T が暴発しない）', () => {
    const spawn = stubAction('spawnDefaultOrNew');
    const restore = stubAction('restoreLastClosedTab');
    handleCtrlKey(key({ shiftKey: true, code: 'KeyT' }), makeRuntime());
    expect(restore.calls).toHaveLength(1);
    expect(spawn.calls).toHaveLength(0);
    spawn.restore();
    restore.restore();
  });

  it('Ctrl+Shift+1 はお気に入り index 0 を開く', () => {
    const fav = stubAction('spawnFavoriteByIndex');
    handleCtrlKey(key({ shiftKey: true, code: 'Digit1' }), makeRuntime());
    expect(fav.calls).toEqual([[0]]);
    fav.restore();
  });

  it('Ctrl+Shift+9 はお気に入り index 8 を開く', () => {
    const fav = stubAction('spawnFavoriteByIndex');
    handleCtrlKey(key({ shiftKey: true, code: 'Numpad9' }), makeRuntime());
    expect(fav.calls).toEqual([[8]]);
    fav.restore();
  });

  it('合成キー（e.code が空）でも e.key でフォールバック判定する', () => {
    const runtime = makeRuntime();
    // Aqua Voice 等が送る合成 Ctrl+Enter
    handleCtrlKey(key({ code: '', key: 'Enter' }), runtime);
    expect((runtime as unknown as { __written: string[] }).__written).toEqual(['\x1b\r']);
  });

  it('未割り当ての Ctrl キーは素通しする', () => {
    expect(handleCtrlKey(key({ code: 'KeyQ' }), makeRuntime())).toBe(true);
  });

  it('Ctrl+Shift+ 数字以外は素通しする', () => {
    expect(handleCtrlKey(key({ shiftKey: true, code: 'KeyZ' }), makeRuntime())).toBe(true);
  });
});
