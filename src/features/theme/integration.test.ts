import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMachine } from '../../architecture/machine';
import { useAppStore } from '../../store/appStore';
import { createEffectRunner, openClaudeTab, partitionThemeFiles } from './effects';
import type { ThemeEvent } from './events';
import { initialState, transition, type ThemeEffect, type ThemeState } from './machine';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/terminalRegistry', () => ({ forceDisposeRuntime: vi.fn() }));

// Mediator + 副作用実行係を繋いだ状態での検証。
// 遷移そのものは machine.test.ts が押さえているので、ここでは副作用に閉じた振る舞いを見る。

const listUserThemes = vi.fn();
const ensureThemesDir = vi.fn();
const openThemesDir = vi.fn();
const openClaude = vi.fn();

function boot() {
  const run = createEffectRunner({
    listUserThemes,
    ensureThemesDir,
    openThemesDir,
    openClaudeTab: openClaude,
  });
  return createMachine<ThemeState, ThemeEvent, ThemeEffect>({ initial: initialState, transition, run });
}

const VALID = JSON.stringify({ name: 'Sunset', ui: { accent: '#f80' } });

beforeEach(() => {
  listUserThemes.mockReset();
  ensureThemesDir.mockReset();
  openThemesDir.mockReset().mockResolvedValue(true);
  openClaude.mockReset();
});

describe('partitionThemeFiles', () => {
  it('検証を通ったものはテーマ、通らなかったものはエラーに分ける', () => {
    const { themes, errors } = partitionThemeFiles([
      { fileName: 'sunset.json', content: VALID, error: null },
      { fileName: 'broken.json', content: '{', error: null },
    ]);

    expect(themes.map((t) => t.id)).toEqual(['user:sunset']);
    expect(themes[0].ui.accent).toBe('#ff8800');
    expect(errors).toHaveLength(1);
    expect(errors[0].fileName).toBe('broken.json');
    expect(errors[0].error).toMatch(/JSON/);
  });

  it('Rust 側で読めなかったファイルは理由をそのままエラーにする', () => {
    const { themes, errors } = partitionThemeFiles([
      { fileName: 'huge.json', content: null, error: '64 KiB を超えています' },
    ]);

    expect(themes).toEqual([]);
    expect(errors).toEqual([{ fileName: 'huge.json', error: '64 KiB を超えています' }]);
  });

  it('空なら両方空', () => {
    expect(partitionThemeFiles([])).toEqual({ themes: [], errors: [] });
  });
});

describe('theme: Mediator と副作用の結合', () => {
  it('起動時の読み込みで loaded まで進み、テーマとエラーを持つ', async () => {
    listUserThemes.mockResolvedValueOnce([
      { fileName: 'sunset.json', content: VALID, error: null },
      { fileName: 'broken.json', content: '[]', error: null },
    ]);
    const m = boot();

    m.send({ type: 'theme/reload-requested' });

    await vi.waitFor(() => expect(m.getState().status).toBe('loaded'));
    const state = m.getState();
    if (state.status !== 'loaded') throw new Error('unreachable');
    expect(state.themes.map((t) => t.id)).toEqual(['user:sunset']);
    expect(state.errors.map((e) => e.fileName)).toEqual(['broken.json']);
  });

  it('読み込み中に再読み込みを頼むと、終わったあともう一度読む', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    listUserThemes
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce([{ fileName: 'sunset.json', content: VALID, error: null }]);
    const m = boot();

    m.send({ type: 'theme/reload-requested' });
    m.send({ type: 'theme/reload-requested' });
    expect(listUserThemes).toHaveBeenCalledTimes(1);

    resolveFirst([]);

    await vi.waitFor(() => expect(m.getState().status).toBe('loaded'));
    expect(listUserThemes).toHaveBeenCalledTimes(2);
    const state = m.getState();
    if (state.status !== 'loaded') throw new Error('unreachable');
    expect(state.themes.map((t) => t.id)).toEqual(['user:sunset']);
  });

  it('フォルダを開く', () => {
    boot().send({ type: 'theme/open-folder-requested' });
    expect(openThemesDir).toHaveBeenCalledTimes(1);
  });

  it('Claude で作る: フォルダを用意してから、そのパスで claude タブを開く', async () => {
    ensureThemesDir.mockResolvedValueOnce('C:\\racker\\themes');

    boot().send({ type: 'theme/create-with-claude-requested' });

    await vi.waitFor(() => expect(openClaude).toHaveBeenCalledWith('C:\\racker\\themes'));
  });

  it('Claude で作る: フォルダを用意できなければタブを開かない', async () => {
    ensureThemesDir.mockResolvedValueOnce(null);

    boot().send({ type: 'theme/create-with-claude-requested' });

    await vi.waitFor(() => expect(ensureThemesDir).toHaveBeenCalled());
    await Promise.resolve();
    expect(openClaude).not.toHaveBeenCalled();
  });
});

describe('openClaudeTab', () => {
  beforeEach(() => {
    useAppStore.setState({ groups: [], tabs: {}, activeTabId: null, activeGroupId: null });
  });

  it('themes フォルダを cwd にした claude タブを開く (クイックアクセスと同じ開き方)', () => {
    openClaudeTab('C:\\racker\\themes');

    const tabs = Object.values(useAppStore.getState().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      userTitle: 'themes',
      cwd: 'C:\\racker\\themes',
      launchClaude: true,
    });
    // 権限バイパスは付けない
    expect(tabs[0].bypassPermissions).toBeUndefined();
  });
});
