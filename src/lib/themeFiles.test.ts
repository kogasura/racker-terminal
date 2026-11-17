import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listUserThemes, ensureThemesDir, openThemesDir } from './themeFiles';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

/**
 * テーマは付加機能なので、Rust 側が失敗しても組み込みテーマだけで動き続ける必要がある。
 * ここでは command 名と、失敗を空 / null / false に倒す挙動を見る。
 */
describe('themeFiles', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listUserThemes', () => {
    it('list_user_themes の結果をそのまま返す', async () => {
      const files = [
        { fileName: 'a.json', content: '{}', error: null },
        { fileName: 'big.json', content: null, error: '大きすぎます' },
      ];
      invokeMock.mockResolvedValue(files);

      await expect(listUserThemes()).resolves.toEqual(files);
      expect(invokeMock).toHaveBeenCalledWith('list_user_themes');
    });

    it('invoke が失敗したら空配列を返す', async () => {
      invokeMock.mockRejectedValue(new Error('boom'));

      await expect(listUserThemes()).resolves.toEqual([]);
    });

    it('null が返ってきても空配列にする', async () => {
      invokeMock.mockResolvedValue(null);

      await expect(listUserThemes()).resolves.toEqual([]);
    });
  });

  describe('ensureThemesDir', () => {
    it('フォルダのパスを返す', async () => {
      invokeMock.mockResolvedValue('C:\\Users\\me\\AppData\\Roaming\\com.yokubo.racker\\themes');

      await expect(ensureThemesDir()).resolves.toBe(
        'C:\\Users\\me\\AppData\\Roaming\\com.yokubo.racker\\themes',
      );
      expect(invokeMock).toHaveBeenCalledWith('ensure_themes_dir');
    });

    it('invoke が失敗したら null を返す', async () => {
      invokeMock.mockRejectedValue(new Error('boom'));

      await expect(ensureThemesDir()).resolves.toBeNull();
    });
  });

  describe('openThemesDir', () => {
    it('開けたら true を返す', async () => {
      invokeMock.mockResolvedValue(true);

      await expect(openThemesDir()).resolves.toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('open_themes_dir');
    });

    it('invoke が失敗したら false を返す', async () => {
      invokeMock.mockRejectedValue(new Error('boom'));

      await expect(openThemesDir()).resolves.toBe(false);
    });

    it('Rust 側が false を返したら false', async () => {
      invokeMock.mockResolvedValue(false);

      await expect(openThemesDir()).resolves.toBe(false);
    });
  });
});
