import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import {
  checkForUpdate,
  downloadUpdate,
  installAndRelaunch,
  relaunchApp,
  recordUpdateAttempt,
  clearUpdateAttempt,
  takeFailedUpdateAttempt,
} from './updater';

describe('updater', () => {
  beforeEach(() => {
    vi.mocked(check).mockReset();
    vi.mocked(relaunch).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(true);
    vi.mocked(getVersion).mockReset();
    localStorage.clear();
  });

  describe('checkForUpdate', () => {
    it('Update 返却時に UpdateAvailable を返す', async () => {
      const mockHandle = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        body: 'Bug fixes and improvements',
        date: '2026-05-01T00:00:00Z',
        download: vi.fn(),
        install: vi.fn(),
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
        download: vi.fn(),
        install: vi.fn(),
      };
      vi.mocked(check).mockResolvedValueOnce(mockHandle as any);

      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.notes).toBe('');
    });
  });

  describe('downloadUpdate', () => {
    it('Started → Progress (複数回) → Finished のイベントで onProgress が正しく呼ばれる', async () => {
      const onProgress = vi.fn();
      const mockHandle = {
        download: vi.fn().mockImplementation(async (onEvent: (e: any) => void) => {
          onEvent({ event: 'Started', data: { contentLength: 1000 } });
          onEvent({ event: 'Progress', data: { chunkLength: 300 } });
          onEvent({ event: 'Progress', data: { chunkLength: 700 } });
          onEvent({ event: 'Finished' });
        }),
        install: vi.fn(),
      };
      const update = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      };

      await downloadUpdate(update, onProgress);

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
        download: vi.fn().mockImplementation(async (onEvent: (e: any) => void) => {
          onEvent({ event: 'Started', data: { contentLength: undefined } });
          onEvent({ event: 'Progress', data: { chunkLength: 500 } });
          onEvent({ event: 'Finished' });
        }),
        install: vi.fn(),
      };
      const update = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      };

      await downloadUpdate(update, onProgress);

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

  describe('installAndRelaunch', () => {
    it('update._handle.install() と relaunch() が呼ばれる', async () => {
      const mockHandle = {
        install: vi.fn().mockResolvedValueOnce(undefined),
      };
      vi.mocked(relaunch).mockResolvedValueOnce(undefined);

      const update = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      };

      await installAndRelaunch(update);

      expect(mockHandle.install).toHaveBeenCalledTimes(1);
      expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it('install() の前に Job から抜けられるようにする', async () => {
      // インストーラが racker の Job に入ったまま起動すると、直後の exit(0) で
      // 道連れに殺される。install() より先に緩めることが要件。
      const order: string[] = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        order.push(cmd);
        return true;
      });
      const mockHandle = {
        install: vi.fn().mockImplementation(async () => {
          order.push('install');
        }),
      };
      vi.mocked(relaunch).mockResolvedValueOnce(undefined);

      await installAndRelaunch({
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      });

      expect(order).toEqual(['allow_process_breakaway', 'install']);
    });

    it('適用を試みたバージョンを記録する', async () => {
      const mockHandle = { install: vi.fn().mockResolvedValueOnce(undefined) };
      vi.mocked(relaunch).mockResolvedValueOnce(undefined);

      await installAndRelaunch({
        version: '1.9.3',
        currentVersion: '1.9.2',
        notes: '',
        _handle: mockHandle as any,
      });

      expect(localStorage.getItem('racker.update.attempt')).toBe('1.9.3');
    });

    it('install() が reject した場合は relaunch() を呼ばず、Job を締め直して記録も消す', async () => {
      const mockHandle = {
        install: vi.fn().mockRejectedValueOnce(new Error('install failed')),
      };
      vi.mocked(relaunch).mockResolvedValueOnce(undefined);

      const update = {
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      };

      await expect(installAndRelaunch(update)).rejects.toThrow('install failed');
      expect(relaunch).not.toHaveBeenCalled();
      expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toEqual([
        'allow_process_breakaway',
        'restore_process_confinement',
      ]);
      expect(localStorage.getItem('racker.update.attempt')).toBeNull();
    });

    it('allow_process_breakaway が失敗しても更新自体は続行する', async () => {
      vi.mocked(invoke).mockRejectedValueOnce(new Error('no such command'));
      const mockHandle = { install: vi.fn().mockResolvedValueOnce(undefined) };
      vi.mocked(relaunch).mockResolvedValueOnce(undefined);

      await installAndRelaunch({
        version: '1.2.0',
        currentVersion: '1.1.0',
        notes: '',
        _handle: mockHandle as any,
      });

      expect(mockHandle.install).toHaveBeenCalledTimes(1);
    });
  });

  describe('takeFailedUpdateAttempt', () => {
    it('記録がなければ null', async () => {
      expect(await takeFailedUpdateAttempt()).toBeNull();
      expect(getVersion).not.toHaveBeenCalled();
    });

    it('記録どおりのバージョンで起動していれば null (適用できている)', async () => {
      recordUpdateAttempt('1.9.3');
      vi.mocked(getVersion).mockResolvedValueOnce('1.9.3');

      expect(await takeFailedUpdateAttempt()).toBeNull();
    });

    it('バージョンが変わっていなければ失敗として返す', async () => {
      recordUpdateAttempt('1.9.3');
      vi.mocked(getVersion).mockResolvedValueOnce('1.9.2');

      expect(await takeFailedUpdateAttempt()).toEqual({
        version: '1.9.3',
        currentVersion: '1.9.2',
      });
    });

    it('記録は 1 度読んだら消える (通知は 1 回きり)', async () => {
      recordUpdateAttempt('1.9.3');
      vi.mocked(getVersion).mockResolvedValue('1.9.2');

      expect(await takeFailedUpdateAttempt()).not.toBeNull();
      expect(await takeFailedUpdateAttempt()).toBeNull();
    });

    it('現在バージョンを取れないときは黙る (誤検知しない)', async () => {
      recordUpdateAttempt('1.9.3');
      vi.mocked(getVersion).mockRejectedValueOnce(new Error('not tauri'));

      expect(await takeFailedUpdateAttempt()).toBeNull();
    });

    it('clearUpdateAttempt で記録を消せる', async () => {
      recordUpdateAttempt('1.9.3');
      clearUpdateAttempt();

      expect(await takeFailedUpdateAttempt()).toBeNull();
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
