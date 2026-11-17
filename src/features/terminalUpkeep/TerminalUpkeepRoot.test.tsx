import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, cleanup } from '@testing-library/react';
import { BUILTIN_THEMES, TOKYO_NIGHT } from '../../lib/theme/builtinThemes';
import type { ThemeDefinition } from '../../lib/theme/types';
import { useAppStore } from '../../store/appStore';
import { TerminalUpkeepRoot } from './TerminalUpkeepRoot';

// テーマの配り先 (ターミナルのランタイム) と、試しに表示の ID の受け取り口を差し替える。
// 何をどのタブに当てるかの判断そのものは viewModel.test.ts (resolveRuntimeThemes) が見ている。
// ここでは「ThemeRoot から受け取った previewThemeId で配り直すか」を見る。
interface FakeRuntime {
  readonly applyTerminalTheme: ReturnType<typeof vi.fn>;
  readonly applySettings: ReturnType<typeof vi.fn>;
}
const runtimes = vi.hoisted(() => new Map<string, FakeRuntime>());
const preview = vi.hoisted(() => ({ id: null as string | null }));

vi.mock('../../lib/terminalRegistry', () => ({
  getAllRuntimeEntries: () => [...runtimes.entries()],
  getAllRuntimes: () => [...runtimes.values()],
  getRuntimeScreen: () => null,
  getRuntimeScreenIfDirty: () => null,
  recycleTextureAtlas: vi.fn(),
}));
vi.mock('../../lib/scrollback', () => ({
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  pruneScrollback: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../theme/ThemeRoot', async () => {
  const { BUILTIN_THEMES: catalog } = await import('../../lib/theme/builtinThemes');
  return {
    useThemeView: () => ({ options: [], errors: [], loading: false, catalog }),
    useThemePreviewId: () => preview.id,
  };
});

const theme = (id: string): ThemeDefinition => {
  const found = BUILTIN_THEMES.find((t) => t.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** そのランタイムに最後に当てたテーマの ID。 */
function lastThemeId(tabId: string): string | undefined {
  const calls = runtimes.get(tabId)?.applyTerminalTheme.mock.calls ?? [];
  return (calls[calls.length - 1]?.[0] as ThemeDefinition | undefined)?.id;
}

beforeEach(() => {
  runtimes.clear();
  for (const id of ['a', 'b', 'c']) {
    runtimes.set(id, { applyTerminalTheme: vi.fn(), applySettings: vi.fn() });
  }
  preview.id = null;
  useAppStore.setState({
    groups: [{ id: 'g1', title: 'Default', collapsed: false, tabIds: ['a', 'b', 'c'] }],
    tabs: {
      a: { id: 'a', groupId: 'g1', status: 'live', themeId: 'nord' },
      b: { id: 'b', groupId: 'g1', status: 'live' },
      c: { id: 'c', groupId: 'g1', status: 'live', themeId: 'scene:honu-lagoon' },
    },
    activeTabId: 'a',
    activeGroupId: 'g1',
    settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
  });
});

afterEach(() => {
  cleanup();
});

describe('TerminalUpkeepRoot: 試しに表示', () => {
  it('試しに表示の間はアクティブなタブのターミナルにだけ当て、終えたら各タブの本来のテーマに戻す', () => {
    const { rerender } = render(<TerminalUpkeepRoot>{null}</TerminalUpkeepRoot>);
    expect([lastThemeId('a'), lastThemeId('b'), lastThemeId('c')]).toEqual([
      'nord',
      TOKYO_NIGHT.id,
      'scene:honu-lagoon',
    ]);

    preview.id = 'dracula';
    rerender(<TerminalUpkeepRoot>{null}</TerminalUpkeepRoot>);
    // アクティブなタブ (上書き nord) にも試しのテーマを当てる。ほかのタブはそのまま
    expect(lastThemeId('a')).toBe('dracula');
    expect(lastThemeId('b')).toBe(TOKYO_NIGHT.id);
    expect(lastThemeId('c')).toBe('scene:honu-lagoon');

    // キャンセル・Esc・保存で試しに表示が終わる → タブの上書き → アプリ → 既定 に戻る
    preview.id = null;
    rerender(<TerminalUpkeepRoot>{null}</TerminalUpkeepRoot>);
    expect([lastThemeId('a'), lastThemeId('b'), lastThemeId('c')]).toEqual([
      'nord',
      TOKYO_NIGHT.id,
      'scene:honu-lagoon',
    ]);
  });

  it('試しに表示の間にアクティブなタブを替えると、試しのテーマも新しいタブに移る', () => {
    preview.id = theme('scene:honu-lagoon').id;
    render(<TerminalUpkeepRoot>{null}</TerminalUpkeepRoot>);
    expect(lastThemeId('a')).toBe('scene:honu-lagoon');
    expect(lastThemeId('b')).toBe(TOKYO_NIGHT.id);

    act(() => {
      useAppStore.setState({ activeTabId: 'b' });
    });
    expect(lastThemeId('a')).toBe('nord');
    expect(lastThemeId('b')).toBe('scene:honu-lagoon');
  });
});
