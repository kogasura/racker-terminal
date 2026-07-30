import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFileDropToTerminal } from './useFileDropToTerminal';
import { useAppStore } from '../store/appStore';
import { getRuntime } from '../lib/terminalRegistry';

/**
 * ファイルをターミナルへドロップしたときの挙動。
 *
 * 見どころは 2 つ。
 *
 * 1. ドラッグ中の見た目 (isDragging) が enter/over/leave/drop で正しく切り替わること
 * 2. drop 時に「どこへ何を書き込むか」— アクティブタブが無い / runtime が無い等、
 *    書き込み先が定まらないケースで**何も書かない**こと。ここを踏み外すと
 *    別のタブへパスが流れ込む。
 */

/** Tauri のドラッグ&ドロップイベントの型（必要な部分だけ） */
type DragPayload =
  | { type: 'enter' | 'over'; paths: string[] }
  | { type: 'leave' }
  | { type: 'drop'; paths: string[] };

/** 直近に登録されたリスナー。テストから任意のイベントを流し込むために保持する。 */
let listener: ((e: { payload: DragPayload }) => void) | null = null;
let unlistenMock = vi.fn();
/** onDragDropEvent が失敗する状況を再現するためのフラグ */
let failToListen = false;

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(async (cb: (e: { payload: DragPayload }) => void) => {
      if (failToListen) throw new Error('listen failed');
      listener = cb;
      return unlistenMock;
    }),
  })),
}));

vi.mock('../lib/terminalRegistry', () => ({ getRuntime: vi.fn() }));

const getRuntimeMock = vi.mocked(getRuntime);

/** writeInput の呼び出しを記録する最小の runtime スタブ */
function makeRuntime() {
  const written: string[] = [];
  return {
    runtime: { writeInput: (s: string) => written.push(s) },
    written,
  };
}

/** ストアにタブを 1 つ用意してアクティブにする */
function setupTab(opts: { shell?: string } = {}) {
  useAppStore.setState({
    tabs: {
      't1': {
        id: 't1',
        title: 'tab',
        shell: opts.shell,
        status: 'running',
      },
    },
    activeTabId: 't1',
  } as never);
}

/** イベントを 1 つ流す */
function emit(payload: DragPayload) {
  act(() => {
    listener?.({ payload });
  });
}

describe('useFileDropToTerminal', () => {
  beforeEach(() => {
    listener = null;
    failToListen = false;
    unlistenMock = vi.fn();
    getRuntimeMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** リスナーが登録されるまで待ってから hook を返す */
  async function render() {
    const view = renderHook(() => useFileDropToTerminal());
    await waitFor(() => expect(listener).not.toBeNull());
    return view;
  }

  describe('ドラッグ中の表示', () => {
    it('enter で true、leave で false になる', async () => {
      const { result } = await render();
      expect(result.current.isDragging).toBe(false);

      emit({ type: 'enter', paths: ['C:\\a.txt'] });
      expect(result.current.isDragging).toBe(true);

      emit({ type: 'leave' });
      expect(result.current.isDragging).toBe(false);
    });

    it('over でも true を保つ', async () => {
      const { result } = await render();

      emit({ type: 'over', paths: ['C:\\a.txt'] });
      expect(result.current.isDragging).toBe(true);
    });

    it('drop したら false に戻る（オーバーレイを消す）', async () => {
      setupTab();
      getRuntimeMock.mockReturnValue(null);
      const { result } = await render();

      emit({ type: 'enter', paths: ['C:\\a.txt'] });
      emit({ type: 'drop', paths: ['C:\\a.txt'] });

      expect(result.current.isDragging).toBe(false);
    });
  });

  describe('drop 時の書き込み', () => {
    it('アクティブタブの端末へ整形したパスを書き込む', async () => {
      setupTab();
      const { runtime, written } = makeRuntime();
      getRuntimeMock.mockReturnValue(runtime as never);
      await render();

      emit({ type: 'drop', paths: ['C:\\dev\\a.txt'] });

      expect(getRuntimeMock).toHaveBeenCalledWith('t1');
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('a.txt');
    });

    it('WSL タブでは Linux 形式のパスへ変換して書き込む', async () => {
      // 変換規則そのものは dragDropPath のテストで見ているので、
      // ここでは「shell を見て WSL 扱いにしている」ことだけ確認する
      setupTab({ shell: 'wsl.exe' });
      const { runtime, written } = makeRuntime();
      getRuntimeMock.mockReturnValue(runtime as never);
      await render();

      emit({ type: 'drop', paths: ['C:\\dev\\a.txt'] });

      expect(written[0]).toContain('/mnt/c');
    });

    it('パスが空なら何も書かない', async () => {
      setupTab();
      const { runtime, written } = makeRuntime();
      getRuntimeMock.mockReturnValue(runtime as never);
      await render();

      emit({ type: 'drop', paths: [] });

      expect(written).toHaveLength(0);
    });

    it('アクティブタブが無ければ何も書かない', async () => {
      useAppStore.setState({ tabs: {}, activeTabId: null } as never);
      await render();

      emit({ type: 'drop', paths: ['C:\\a.txt'] });

      expect(getRuntimeMock).not.toHaveBeenCalled();
    });

    it('タブに対応する runtime がまだ無ければ何も書かない', async () => {
      // 起動直後など、タブはあるが端末が用意できていない状態
      setupTab();
      getRuntimeMock.mockReturnValue(null);
      await render();

      expect(() => emit({ type: 'drop', paths: ['C:\\a.txt'] })).not.toThrow();
    });
  });

  describe('後始末', () => {
    it('unmount でリスナーを解除する', async () => {
      const { unmount } = await render();

      unmount();

      expect(unlistenMock).toHaveBeenCalledTimes(1);
    });

    it('リスナー登録に失敗してもクラッシュしない（ドロップが効かないだけ）', async () => {
      failToListen = true;

      const { result } = renderHook(() => useFileDropToTerminal());
      await waitFor(() => expect(console.error).toHaveBeenCalled());

      expect(result.current.isDragging).toBe(false);
    });
  });
});
