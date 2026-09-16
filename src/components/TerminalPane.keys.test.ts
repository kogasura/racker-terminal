import { describe, it, expect, vi } from 'vitest';
import { handleCtrlKey } from './TerminalPane';
import type { TabsIntent } from '../features/tabs/events';
import type { TerminalRuntime } from '../lib/terminalRegistry';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

/**
 * Ctrl 系キーのディスパッチ検証。
 *
 * ここで見るのは「キーをどこへ渡すか」だけ:
 *   - ターミナル面に閉じた操作 (貼り付け・コピー・改行送出) は runtime を直接叩く
 *   - タブ操作はイベントとして上へ流す (実行するかは tabs の Mediator が決める)
 *
 * 流した先で何が起きるかは features/tabs 側のテストが持つ。
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

function written(runtime: TerminalRuntime): string[] {
  return (runtime as unknown as { __written: string[] }).__written;
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

/** ディスパッチを 1 回走らせ、戻り値と送出されたイベントを返す。 */
function dispatch(
  e: KeyboardEvent,
  opts?: { runtime?: TerminalRuntime; suspended?: boolean },
): { handled: boolean; emitted: TabsIntent[]; runtime: TerminalRuntime } {
  const emitted: TabsIntent[] = [];
  const runtime = opts?.runtime ?? makeRuntime();
  const handled = handleCtrlKey(
    e,
    runtime,
    (event) => emitted.push(event),
    opts?.suspended ?? false,
  );
  return { handled, emitted, runtime };
}

describe('handleCtrlKey', () => {
  describe('素通しする条件', () => {
    it('keydown 以外', () => {
      expect(dispatch(key({ type: 'keyup', code: 'KeyW' })).handled).toBe(true);
    });

    it('Ctrl なし', () => {
      expect(dispatch(key({ ctrlKey: false, code: 'KeyT' })).handled).toBe(true);
    });

    it('IME 合成中（タブ操作の暴発防止）', () => {
      expect(dispatch(key({ isComposing: true, code: 'Tab' })).emitted).toEqual([]);
      expect(dispatch(key({ isComposing: true, code: 'Tab' })).handled).toBe(true);
      expect(dispatch(key({ keyCode: 229, code: 'Tab' })).handled).toBe(true);
    });

    it('コマンドが止まっている間（ContextMenu 表示中）', () => {
      const r = dispatch(key({ code: 'Tab' }), { suspended: true });
      expect(r.handled).toBe(true);
      expect(r.emitted).toEqual([]);
    });

    it('未割り当ての Ctrl キー', () => {
      expect(dispatch(key({ code: 'KeyQ' })).handled).toBe(true);
    });

    it('Ctrl+Shift+ 数字以外', () => {
      expect(dispatch(key({ shiftKey: true, code: 'KeyZ' })).handled).toBe(true);
    });
  });

  describe('タブ操作はイベントとして上へ流す', () => {
    it('Ctrl+Shift+W', () => {
      const r = dispatch(key({ shiftKey: true, code: 'KeyW' }));
      expect(r.handled).toBe(false);
      expect(r.emitted).toEqual([{ type: 'tabs/close-active-requested' }]);
    });

    it('Ctrl+Tab / Ctrl+Shift+Tab', () => {
      expect(dispatch(key({ code: 'Tab' })).emitted).toEqual([
        { type: 'tabs/navigate-requested', direction: 'next' },
      ]);
      expect(dispatch(key({ shiftKey: true, code: 'Tab' })).emitted).toEqual([
        { type: 'tabs/navigate-requested', direction: 'prev' },
      ]);
    });

    it('Ctrl+T / Ctrl+Shift+T（Ctrl+T が暴発しない）', () => {
      expect(dispatch(key({ code: 'KeyT' })).emitted).toEqual([
        { type: 'tabs/spawn-default-requested' },
      ]);
      expect(dispatch(key({ shiftKey: true, code: 'KeyT' })).emitted).toEqual([
        { type: 'tabs/restore-requested' },
      ]);
    });

    it('Ctrl+Shift+1..9', () => {
      expect(dispatch(key({ shiftKey: true, code: 'Digit1' })).emitted).toEqual([
        { type: 'tabs/spawn-favorite-requested', index: 0 },
      ]);
      expect(dispatch(key({ shiftKey: true, code: 'Numpad9' })).emitted).toEqual([
        { type: 'tabs/spawn-favorite-requested', index: 8 },
      ]);
    });
  });

  describe('ターミナル面の操作はここで実行する', () => {
    it('Ctrl+Enter は ESC+CR を送る', () => {
      const r = dispatch(key({ code: 'Enter' }));
      expect(r.handled).toBe(false);
      expect(written(r.runtime)).toEqual(['\x1b\r']);
      expect(r.emitted).toEqual([]);
    });

    it('Ctrl+NumpadEnter も ESC+CR を送る', () => {
      expect(written(dispatch(key({ code: 'NumpadEnter' })).runtime)).toEqual(['\x1b\r']);
    });

    it('Ctrl+Shift+Enter は対象外（素通し）', () => {
      const r = dispatch(key({ shiftKey: true, code: 'Enter' }));
      expect(r.handled).toBe(true);
      expect(written(r.runtime)).toEqual([]);
    });

    it('Ctrl+C は選択が無ければ素通しする（SIGINT を通す）', () => {
      expect(dispatch(key({ code: 'KeyC' })).handled).toBe(true);
    });

    it('Ctrl+C は選択があればコピーして握りつぶす', () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      const r = dispatch(key({ code: 'KeyC' }), { runtime: makeRuntime({ selection: 'copied' }) });
      expect(r.handled).toBe(false);
    });

    it('合成キー（e.code が空）でも e.key でフォールバック判定する', () => {
      // Aqua Voice 等が送る合成 Ctrl+Enter
      expect(written(dispatch(key({ code: '', key: 'Enter' })).runtime)).toEqual(['\x1b\r']);
    });
  });
});
