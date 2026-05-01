import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { checkForUpdate, downloadAndInstall, relaunchApp } from './updater';

describe('updater', () => {
  beforeEach(() => {
    vi.mocked(check).mockReset();
    vi.mocked(relaunch).mockReset();
  });

  describe('checkForUpdate', () => {
    it('Update 返却時に UpdateAvailable を返す', async () => {
      const mockHandle = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        body: 'Bug fixes and improvements',
        date: '2026-05-01T00:00:00Z',
        downloadAndInstall: vi.fn(),
      };
      vi.mocked(check).mockResolvedValueOnce(mockHandle as any);

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.version).toBe('1.2.0');
      expect(result!.currentVersion).toBe('1.1.0');
      expect(result!.notes).toBe('Bug fixes and improvements');
      expect(result!.date).toBe('2026-05-01T00:00:00Z');
      expect(result!._handle).toBe(mockHandle);
    });

    it('check() が null 返却時に null を返す', async () => {
      vi.mocked(check).mockResolvedValueOnce(null);

      const result = await checkForUpdate();

      expect(result).toBeNull();
    });

    it('check() reject 時に null を返してエラーを catch する', async () => {
      vi.mocked(check).mockRejectedValueOnce(new Error('Network error'));

      const result = await checkForUpdate();

      expect(result).toBeNull();
    });

    it('update.body が undefined の場合 notes は空文字列', async () => {
      const mockHandle = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        body: undefined,
        date: undefined,
        downloadAndInstall: vi.fn(),
      };
      vi.mocked(check).mockResolvedValueOnce(mockHandle as any);

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.notes).toBe('');
    });
  });

  describe('downloadAndInstall', () => {
    it('Started → Progress (複数回) → Finished のイベントで onProgress が正しく呼ばれる', async () => {
      const onProgress = vi.fn();
      const mockHandle = {
        downloadAndInstall: vi.fn().mockImplementation(async (onEvent: (e: any) => void) => {
          onEvent({ event: 'Started', data: { contentLength: 1000 } });
          onEvent({ event: 'Progress', data: { chunkLength: 300 } });
          onEvent({ event: 'Progress', data: { chunkLength: 700 } });
          onEvent({ event: 'Finished' });
        }),
      };
      const update = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      };

      await downloadAndInstall(update, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(4);

      // Started
      expect(onProgress).toHaveBeenNthCalledWith(1, {
        ratio: 0,
        downloaded: 0,
        contentLength: 1000,
      });

      // Progress: 300 / 1000
      expect(onProgress).toHaveBeenNthCalledWith(2, {
        ratio: 0.3,
        downloaded: 300,
        contentLength: 1000,
      });

      // Progress: 1000 / 1000
      expect(onProgress).toHaveBeenNthCalledWith(3, {
        ratio: 1,
        downloaded: 1000,
        contentLength: 1000,
      });

      // Finished
      expect(onProgress).toHaveBeenNthCalledWith(4, {
        ratio: 1,
        downloaded: 1000,
        contentLength: 1000,
      });
    });

    it('contentLength=undefined の場合は ratio が undefined になる', async () => {
      const onProgress = vi.fn();
      const mockHandle = {
        downloadAndInstall: vi.fn().mockImplementation(async (onEvent: (e: any) => void) => {
          onEvent({ event: 'Started', data: { contentLength: undefined } });
          onEvent({ event: 'Progress', data: { chunkLength: 500 } });
          onEvent({ event: 'Finished' });
        }),
      };
      const update = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      };

      await downloadAndInstall(update, onProgress);

      // Started: contentLength が undefined なので ratio は undefined
      expect(onProgress).toHaveBeenNthCalledWith(1, {
        ratio: undefined,
        downloaded: 0,
        contentLength: undefined,
      });

      // Progress: contentLength が undefined なので ratio は undefined
      expect(onProgress).toHaveBeenNthCalledWith(2, {
        ratio: undefined,
        downloaded: 500,
        contentLength: undefined,
      });

      // Finished: ratio は常に 1
      expect(onProgress).toHaveBeenNthCalledWith(3, {
        ratio: 1,
        downloaded: 500,
        contentLength: undefined,
      });
    });
  });

  describe('relaunchApp', () => {
    it('relaunch() を呼ぶ', async () => {
      vi.mocked(relaunch).mockResolvedValueOnce(undefined);

      await relaunchApp();

      expect(relaunch).toHaveBeenCalledTimes(1);
    });
  });
});
