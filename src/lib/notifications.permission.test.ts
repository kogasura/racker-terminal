import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureNotificationPermission,
  notifyAgentState,
  resetPermissionCacheForTest,
} from './notifications';
import {
  sendNotification,
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));

const grantedMock = vi.mocked(isPermissionGranted);
const requestMock = vi.mocked(requestPermission);
const sendMock = vi.mocked(sendNotification);

/**
 * 通知の「判断」は notifications.test.ts で見ている。
 * こちらは権限の取り回しと送信そのもの、つまり副作用の側を見る。
 *
 * 通知は付加機能なので、**どう転んでもアプリ本体を巻き込まない**ことが要件。
 */
describe('ensureNotificationPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPermissionCacheForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('既に許可済みなら要求ダイアログを出さない', async () => {
    grantedMock.mockResolvedValue(true);

    await expect(ensureNotificationPermission()).resolves.toBe(true);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('未許可なら 1 度だけ要求する', async () => {
    grantedMock.mockResolvedValue(false);
    requestMock.mockResolvedValue('granted');

    await expect(ensureNotificationPermission()).resolves.toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('拒否されたら false を返す', async () => {
    grantedMock.mockResolvedValue(false);
    requestMock.mockResolvedValue('denied');

    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });

  it('拒否された後は問い合わせ直さない（起動のたびにダイアログを出さないため）', async () => {
    grantedMock.mockResolvedValue(false);
    requestMock.mockResolvedValue('denied');

    await ensureNotificationPermission();
    await ensureNotificationPermission();
    await ensureNotificationPermission();

    // 2 回目以降はキャッシュを返すだけ
    expect(grantedMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('許可された後も問い合わせ直さない（通知のたびに IPC を往復させないため）', async () => {
    grantedMock.mockResolvedValue(true);

    await ensureNotificationPermission();
    await ensureNotificationPermission();

    expect(grantedMock).toHaveBeenCalledTimes(1);
  });

  it('権限の確認が失敗しても例外を投げず false を返す', async () => {
    // 通知が使えない環境（プラグイン未登録など）でもアプリは動き続ける
    grantedMock.mockRejectedValue(new Error('plugin not available'));

    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });
});

describe('notifyAgentState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPermissionCacheForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('応答待ちの通知はタイトルと本文を組み立てて送る', async () => {
    grantedMock.mockResolvedValue(true);

    await notifyAgentState('blocked', 'racker-terminal', 'input needed');

    expect(sendMock).toHaveBeenCalledWith({
      title: 'Claude が応答待ちです',
      body: 'racker-terminal が応答を待っています（input needed）',
    });
  });

  it('完了の通知を送る', async () => {
    grantedMock.mockResolvedValue(true);

    await notifyAgentState('done', 'my-project');

    expect(sendMock).toHaveBeenCalledWith({
      title: 'Claude の処理が完了しました',
      body: 'my-project の処理が完了しました',
    });
  });

  it('権限が無ければ送らない', async () => {
    grantedMock.mockResolvedValue(false);
    requestMock.mockResolvedValue('denied');

    await notifyAgentState('blocked', 'racker-terminal');

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('送信が失敗しても例外を投げない', async () => {
    grantedMock.mockResolvedValue(true);
    sendMock.mockImplementation(() => {
      throw new Error('toast failed');
    });

    await expect(notifyAgentState('done', 'x')).resolves.toBeUndefined();
  });
});
