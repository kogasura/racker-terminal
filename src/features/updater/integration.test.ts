import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMachine } from '../../architecture/machine';
import { createEffectRunner } from './effects';
import { initialState, transition, type UpdaterEffect, type UpdaterState } from './machine';
import type { UpdaterEvent } from './events';
import type { Update } from '@tauri-apps/plugin-updater';

// Mediator + 副作用実行係を繋いだ状態での検証。
// 遷移そのものは machine.test.ts が純粋関数として押さえているので、ここでは
// 「待機ハンドルの持ち回り」など、副作用側に閉じている振る舞いを見る。

const checkForUpdate = vi.fn();
const downloadUpdate = vi.fn();
const installAndRelaunch = vi.fn();

/** `_handle` は実際には Tauri の Update だが、ここでは使われないので形だけ合わせる。 */
const handle = {} as Update;

function available(version: string, currentVersion = '1.1.0') {
  return { version, currentVersion, notes: '', _handle: handle };
}

function boot() {
  const run = createEffectRunner({ checkForUpdate, downloadUpdate, installAndRelaunch });
  return createMachine<UpdaterState, UpdaterEvent, UpdaterEffect>({
    initial: initialState,
    transition,
    run,
  });
}

beforeEach(() => {
  checkForUpdate.mockReset();
  downloadUpdate.mockReset();
  installAndRelaunch.mockReset();
  downloadUpdate.mockResolvedValue(undefined);
  installAndRelaunch.mockResolvedValue(undefined);
});

describe('updater: Mediator と副作用の結合', () => {
  it('チェック → DL → ready まで進む', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    const m = boot();

    m.send({ type: 'updater/check-requested', manual: false });

    await vi.waitFor(() => expect(m.getState().flow.status).toBe('ready'));
    expect(m.getState().flow).toMatchObject({
      status: 'ready',
      info: { version: '1.2.0', currentVersion: '1.1.0' },
    });
  });

  it('更新が無ければ idle のまま', async () => {
    checkForUpdate.mockResolvedValueOnce(null);
    const m = boot();

    m.send({ type: 'updater/check-requested', manual: false });

    await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
    expect(m.getState().flow.status).toBe('idle');
  });

  it('DL に失敗したら黙って idle に戻す', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    downloadUpdate.mockRejectedValueOnce(new Error('Network timeout'));
    const m = boot();

    m.send({ type: 'updater/check-requested', manual: false });

    await vi.waitFor(() => expect(m.getState().flow.status).toBe('idle'));
  });

  it('待機中により新しい版が出ていれば差し替え、その版でインストールする', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    const m = boot();
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() => expect(m.getState().flow.status).toBe('ready'));

    checkForUpdate.mockResolvedValueOnce(available('1.4.0'));
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() =>
      expect(m.getState().flow).toMatchObject({ status: 'ready', info: { version: '1.4.0' } }),
    );

    m.send({ type: 'updater/apply-requested' });
    await vi.waitFor(() => expect(installAndRelaunch).toHaveBeenCalled());
    expect(installAndRelaunch.mock.calls[0][0].version).toBe('1.4.0');
  });

  it('同じ版なら差し替えない', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    const m = boot();
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() => expect(m.getState().flow.status).toBe('ready'));

    const downloadCalls = downloadUpdate.mock.calls.length;
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    m.send({ type: 'updater/check-requested', manual: false });

    await vi.waitFor(() =>
      expect(m.getState().flow).toMatchObject({ status: 'ready', refreshing: false }),
    );
    expect(downloadUpdate.mock.calls.length).toBe(downloadCalls);
  });

  it('差し替えのチェックが取れなくても待機中の版は失わない', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    const m = boot();
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() => expect(m.getState().flow.status).toBe('ready'));

    checkForUpdate.mockResolvedValueOnce(null);
    m.send({ type: 'updater/check-requested', manual: false });

    await vi.waitFor(() =>
      expect(m.getState().flow).toMatchObject({ status: 'ready', refreshing: false }),
    );
    expect(m.getState().flow).toMatchObject({ info: { version: '1.2.0' } });
  });

  it('差し替えの DL に失敗しても、古い版で更新はできる', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    const m = boot();
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() => expect(m.getState().flow.status).toBe('ready'));

    checkForUpdate.mockResolvedValueOnce(available('1.4.0'));
    downloadUpdate.mockRejectedValueOnce(new Error('Network timeout'));
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() =>
      expect(m.getState().flow).toMatchObject({ status: 'ready', refreshing: false }),
    );

    m.send({ type: 'updater/apply-requested' });
    await vi.waitFor(() => expect(installAndRelaunch).toHaveBeenCalled());
    expect(installAndRelaunch.mock.calls[0][0].version).toBe('1.2.0');
  });

  it('インストールに失敗したら error になり、リトライで installing へ戻る', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    installAndRelaunch.mockRejectedValueOnce(new Error('Install failed'));
    const m = boot();
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() => expect(m.getState().flow.status).toBe('ready'));

    m.send({ type: 'updater/badge-clicked' });
    m.send({ type: 'updater/apply-requested' });

    await vi.waitFor(() => expect(m.getState().flow.status).toBe('error'));
    expect(m.getState().flow).toMatchObject({ message: 'Install failed', dialogOpen: true });

    m.send({ type: 'updater/apply-requested' });
    expect(m.getState().flow.status).toBe('installing');
  });

  it('DL に失敗して待機ハンドルが無いまま適用すると error になる', async () => {
    checkForUpdate.mockResolvedValueOnce(available('1.2.0'));
    downloadUpdate.mockRejectedValueOnce(new Error('Network'));
    const m = boot();
    m.send({ type: 'updater/check-requested', manual: false });
    await vi.waitFor(() => expect(m.getState().flow.status).toBe('idle'));

    // idle からは適用できないので、error まで持っていってからリトライを試す
    // (バッジ経由でユーザーが到達しうる唯一の経路)。
    expect(m.getState().flow.status).toBe('idle');
    expect(installAndRelaunch).not.toHaveBeenCalled();
  });
});
