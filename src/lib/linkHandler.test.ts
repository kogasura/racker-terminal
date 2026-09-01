import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { createLinkHandler } from './linkHandler';

/** Ctrl+左クリック相当の MouseEvent もどきを作る */
function click(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return { button: 0, ctrlKey: true, metaKey: false, ...overrides } as MouseEvent;
}

describe('createLinkHandler', () => {
  const handler = createLinkHandler();

  beforeEach(() => {
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue('opened');
  });

  it('file: スキームを受け取るため allowNonHttpProtocols が true', () => {
    // これが false だと file:// リンクが activate に届かず、機能全体が沈黙する
    expect(handler.allowNonHttpProtocols).toBe(true);
  });

  it('https リンクは Ctrl+クリックでブラウザへ (openUrl)', () => {
    handler.activate(click(), 'https://example.com/report', null as never);

    expect(openUrl).toHaveBeenCalledWith('https://example.com/report');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('file リンクは Ctrl+クリックで Rust の open_file_link へ', () => {
    handler.activate(click(), 'file:///C:/work/shot.png', null as never);

    expect(invoke).toHaveBeenCalledWith('open_file_link', {
      uri: 'file:///C:/work/shot.png',
      wslDistro: null, // 非 WSL タブ
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('WSL タブでは distro を添えて渡す (Linux 絶対パスの解決に必要)', () => {
    const wslHandler = createLinkHandler({ getWslDistro: () => 'Ubuntu-24.04' });
    wslHandler.activate(click(), 'file:///tmp/claude-1000/slide.001.png', null as never);

    expect(invoke).toHaveBeenCalledWith('open_file_link', {
      uri: 'file:///tmp/claude-1000/slide.001.png',
      wslDistro: 'Ubuntu-24.04',
    });
  });

  it('distro 未指定の WSL タブは空文字を渡す (Rust 側が既定 distro を引く)', () => {
    const wslHandler = createLinkHandler({ getWslDistro: () => '' });
    wslHandler.activate(click(), 'file:///tmp/a.png', null as never);

    expect(invoke).toHaveBeenCalledWith('open_file_link', {
      uri: 'file:///tmp/a.png',
      wslDistro: '',
    });
  });

  it('spawn 前など distro が未確定なら null を渡す', () => {
    const wslHandler = createLinkHandler({ getWslDistro: () => undefined });
    wslHandler.activate(click(), 'file:///C:/a.png', null as never);

    expect(invoke).toHaveBeenCalledWith('open_file_link', {
      uri: 'file:///C:/a.png',
      wslDistro: null,
    });
  });

  it('Cmd+クリック (Mac) でも開く', () => {
    handler.activate(click({ ctrlKey: false, metaKey: true }), 'file:///C:/a.png', null as never);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('修飾キーなしの単純クリックでは何もしない (誤発火防止)', () => {
    handler.activate(click({ ctrlKey: false }), 'file:///C:/a.png', null as never);
    handler.activate(click({ ctrlKey: false }), 'https://example.com', null as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('左クリック以外では何もしない', () => {
    handler.activate(click({ button: 1 }), 'file:///C:/a.png', null as never);
    handler.activate(click({ button: 2 }), 'https://example.com', null as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('危険スキーム (javascript: / data:) は無視する', () => {
    handler.activate(click(), 'javascript:alert(1)', null as never);
    handler.activate(click(), 'data:text/html,<script>x</script>', null as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('制御文字入りの file URI は Rust に渡さない', () => {
    handler.activate(click(), 'file:///C:/a\x07b.png', null as never);

    expect(invoke).not.toHaveBeenCalled();
  });

  it('openUrl / invoke の失敗は握って落ちない (console.warn のみ)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('no browser'));
    vi.mocked(invoke).mockRejectedValueOnce(new Error('not found'));

    handler.activate(click(), 'https://example.com', null as never);
    handler.activate(click(), 'file:///C:/missing.png', null as never);
    // reject の伝播を待つ
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));

    warn.mockRestore();
  });
});
