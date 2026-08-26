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
    });
    expect(openUrl).not.toHaveBeenCalled();
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
