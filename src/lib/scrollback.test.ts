import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  saveScrollback,
  loadScrollback,
  deleteScrollback,
  pruneScrollback,
  SAVE_SCROLLBACK_LINES,
  RESTORE_BANNER,
} from './scrollback';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

/**
 * scrollback の保存・復元は「あると嬉しい」付加機能であり、
 * **失敗してもターミナルの動作に波及してはいけない**。
 * ここでのテストの主眼は、Rust 側へ渡す引数の形と、失敗を飲み込む挙動。
 */
describe('scrollback', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // 失敗経路のテストで console が汚れるので黙らせる
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveScrollback', () => {
    it('tabId と content を Rust の save_scrollback へ渡す', async () => {
      invokeMock.mockResolvedValue(true);

      await saveScrollback('tab-1', 'hello');

      expect(invokeMock).toHaveBeenCalledWith('save_scrollback', {
        tabId: 'tab-1',
        content: 'hello',
      });
    });

    it('空の内容は保存しない（空ファイルで上書きして中身を失わないため）', async () => {
      await saveScrollback('tab-1', '');

      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('保存に失敗しても例外を投げない', async () => {
      invokeMock.mockRejectedValue(new Error('disk full'));

      await expect(saveScrollback('tab-1', 'hello')).resolves.toBeUndefined();
    });
  });

  describe('loadScrollback', () => {
    it('保存されていた内容をそのまま返す', async () => {
      invokeMock.mockResolvedValue('restored text');

      await expect(loadScrollback('tab-1')).resolves.toBe('restored text');
      expect(invokeMock).toHaveBeenCalledWith('load_scrollback', { tabId: 'tab-1' });
    });

    it('保存が無ければ null を返す', async () => {
      invokeMock.mockResolvedValue(null);

      await expect(loadScrollback('tab-1')).resolves.toBeNull();
    });

    it('読み取りに失敗したら null を返す（復元できないだけで起動は続く）', async () => {
      invokeMock.mockRejectedValue(new Error('permission denied'));

      await expect(loadScrollback('tab-1')).resolves.toBeNull();
    });
  });

  describe('deleteScrollback', () => {
    it('tabId を Rust の delete_scrollback へ渡す', async () => {
      invokeMock.mockResolvedValue(true);

      await deleteScrollback('tab-9');

      expect(invokeMock).toHaveBeenCalledWith('delete_scrollback', { tabId: 'tab-9' });
    });

    it('削除に失敗しても例外を投げない', async () => {
      invokeMock.mockRejectedValue(new Error('locked'));

      await expect(deleteScrollback('tab-9')).resolves.toBeUndefined();
    });
  });

  describe('pruneScrollback', () => {
    it('残すタブ ID の一覧を渡す', async () => {
      invokeMock.mockResolvedValue(3);

      await pruneScrollback(['a', 'b']);

      expect(invokeMock).toHaveBeenCalledWith('prune_scrollback', { keepTabIds: ['a', 'b'] });
    });

    it('タブが 1 つも無くても呼ぶ（全削除は正当な要求）', async () => {
      invokeMock.mockResolvedValue(0);

      await pruneScrollback([]);

      expect(invokeMock).toHaveBeenCalledWith('prune_scrollback', { keepTabIds: [] });
    });

    it('掃除に失敗しても例外を投げない', async () => {
      invokeMock.mockRejectedValue(new Error('io'));

      await expect(pruneScrollback(['a'])).resolves.toBeUndefined();
    });
  });

  describe('定数', () => {
    it('保存行数は 1000 行', () => {
      // 値そのものより「勝手に変わっていないこと」を見る。
      // 増やすと保存サイズとシリアライズ時間が伸びる。
      expect(SAVE_SCROLLBACK_LINES).toBe(1000);
    });

    it('区切りは前後に改行を持ち、色をリセットして終わる', () => {
      // 色を戻し損ねると、以降のプロセス出力まで灰色に染まる
      expect(RESTORE_BANNER.startsWith('\r\n')).toBe(true);
      expect(RESTORE_BANNER.endsWith('\r\n')).toBe(true);
      expect(RESTORE_BANNER).toContain('\x1b[0m');
    });
  });
});
