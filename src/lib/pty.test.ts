import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnPty, writePty, resizePty, killPty, setReadPaused, type PtyEvent } from './pty';
import { invoke, Channel } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => {
  // Channel は Rust からのイベントを受ける口。実物は IPC に繋がるので、
  // onmessage を手元で発火できる最小の代役を置く。
  class FakeChannel<T> {
    onmessage: ((e: T) => void) | null = null;
  }
  return { invoke: vi.fn(), Channel: FakeChannel };
});

const invokeMock = vi.mocked(invoke);

describe('spawnPty', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('session-1');
  });

  /** 直近の pty_spawn 呼び出しに渡された引数 */
  function spawnArgs(): Record<string, unknown> {
    const call = invokeMock.mock.calls.find((c) => c[0] === 'pty_spawn');
    return (call?.[1] ?? {}) as Record<string, unknown>;
  }

  it('cols / rows と Channel を必ず渡す', async () => {
    await spawnPty({ cols: 80, rows: 24 }, () => {});

    const args = spawnArgs();
    expect(args.cols).toBe(80);
    expect(args.rows).toBe(24);
    expect(args.onEvent).toBeInstanceOf(Channel);
  });

  it('未指定の項目はキーごと渡さない（Rust 側で None として扱わせるため）', async () => {
    // undefined を渡すと Rust 側の Option デシリアライズが期待どおりに
    // ならないことがあるので、キー自体を落とすのが約束になっている。
    await spawnPty({ cols: 80, rows: 24 }, () => {});

    const args = spawnArgs();
    expect('shell' in args).toBe(false);
    expect('cwd' in args).toBe(false);
    expect('args' in args).toBe(false);
    expect('env' in args).toBe(false);
  });

  it('指定した項目はそのまま渡す', async () => {
    await spawnPty(
      {
        cols: 100,
        rows: 30,
        shell: 'pwsh.exe',
        cwd: 'C:\\dev',
        args: ['-NoLogo'],
        env: { FOO: 'bar' },
      },
      () => {},
    );

    const args = spawnArgs();
    expect(args.shell).toBe('pwsh.exe');
    expect(args.cwd).toBe('C:\\dev');
    expect(args.args).toEqual(['-NoLogo']);
    expect(args.env).toEqual({ FOO: 'bar' });
  });

  it('空配列の args / 空オブジェクトの env は「指定あり」として渡す', async () => {
    // 空配列は「引数なし」の明示であって未指定ではない
    await spawnPty({ cols: 80, rows: 24, args: [], env: {} }, () => {});

    const args = spawnArgs();
    expect(args.args).toEqual([]);
    expect(args.env).toEqual({});
  });

  it('Rust が返したセッション ID を handle に載せる', async () => {
    invokeMock.mockResolvedValue('abc-123');

    const handle = await spawnPty({ cols: 80, rows: 24 }, () => {});

    expect(handle.id).toBe('abc-123');
  });

  it('Channel に届いたイベントを onEvent へ素通しする', async () => {
    const received: PtyEvent[] = [];
    await spawnPty({ cols: 80, rows: 24 }, (e) => received.push(e));

    const channel = spawnArgs().onEvent as Channel<PtyEvent>;
    channel.onmessage?.({ type: 'data', text: 'hello' });
    channel.onmessage?.({ type: 'exit', code: 0 });

    expect(received).toEqual([
      { type: 'data', text: 'hello' },
      { type: 'exit', code: 0 },
    ]);
  });

  it('handle.dispose() は自分のセッションを kill する', async () => {
    invokeMock.mockResolvedValue('session-7');
    const handle = await spawnPty({ cols: 80, rows: 24 }, () => {});
    invokeMock.mockResolvedValue(undefined);

    await handle.dispose();

    expect(invokeMock).toHaveBeenCalledWith('pty_kill', { id: 'session-7' });
  });

  it('spawn が失敗したら呼び出し元へ伝える（タブを crashed にするため）', async () => {
    invokeMock.mockRejectedValue(new Error('shell not found'));

    await expect(spawnPty({ cols: 80, rows: 24 }, () => {})).rejects.toThrow('shell not found');
  });
});

describe('その他の PTY 操作', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('writePty は id と data を渡す', async () => {
    await writePty('s1', 'ls\r\n');

    expect(invokeMock).toHaveBeenCalledWith('pty_write', { id: 's1', data: 'ls\r\n' });
  });

  it('resizePty は cols / rows を渡す', async () => {
    await resizePty('s1', 120, 40);

    expect(invokeMock).toHaveBeenCalledWith('pty_resize', { id: 's1', cols: 120, rows: 40 });
  });

  it('killPty は id を渡す', async () => {
    await killPty('s1');

    expect(invokeMock).toHaveBeenCalledWith('pty_kill', { id: 's1' });
  });

  it('setReadPaused は pause / resume の両方を送れる', async () => {
    await setReadPaused('s1', true);
    expect(invokeMock).toHaveBeenCalledWith('pty_set_read_paused', { id: 's1', paused: true });

    await setReadPaused('s1', false);
    expect(invokeMock).toHaveBeenCalledWith('pty_set_read_paused', { id: 's1', paused: false });
  });
});
