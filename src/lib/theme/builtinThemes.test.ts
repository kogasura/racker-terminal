import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, TOKYO_NIGHT } from './builtinThemes';
import { parseThemeFile } from './parseTheme';

describe('BUILTIN_THEMES', () => {
  it('6 種あり、ID が重複しない', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(ids).toEqual([
      'tokyo-night',
      'dracula',
      'nord',
      'catppuccin-mocha',
      'racker-ember',
      'racker-paper',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('すべて source が builtin で、既定の ID は tokyo-night', () => {
    expect(BUILTIN_THEMES.every((t) => t.source === 'builtin')).toBe(true);
    expect(DEFAULT_THEME_ID).toBe('tokyo-night');
    expect(BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID)).toBe(TOKYO_NIGHT);
  });

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s はユーザーのテーマと同じ検証を通り、値が変わらない（色は小文字の #rrggbb）',
    (_id, theme) => {
      const content = JSON.stringify({
        name: theme.name,
        appearance: theme.appearance,
        ui: theme.ui,
        terminal: theme.terminal,
      });
      const result = parseThemeFile(`${theme.id}.json`, content);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.theme.ui).toEqual(theme.ui);
      expect(result.theme.terminal).toEqual(theme.terminal);
      for (const color of [...Object.values(theme.ui), ...Object.values(theme.terminal)]) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    },
  );

  it('ライトは racker-paper だけ', () => {
    expect(BUILTIN_THEMES.filter((t) => t.appearance === 'light').map((t) => t.id)).toEqual([
      'racker-paper',
    ]);
  });
});

describe('Tokyo Night（従来の配色）', () => {
  it('ui が従来の variables.css / スタイルの直書きの値と一致する', () => {
    expect(TOKYO_NIGHT.appearance).toBe('dark');
    expect(TOKYO_NIGHT.ui).toEqual({
      bg: '#1a1b26', // --group-header-bg / --title-bar-bg / --terminal-bg の rgba(26, 27, 38)
      bgSidebar: '#16161e', // --sidebar-bg の rgba(22, 22, 30)
      bgElevated: '#232333', // --sidebar-bg-elevated の rgba(35, 35, 51)
      bgInset: '#0d0e14',
      bgHover: '#1f2335', // --tab-item-bg-hover
      bgActive: '#292e42', // --tab-item-bg-active
      fg: '#c0caf5', // --sidebar-fg / --title-bar-fg
      fgMuted: '#9aa5ce', // --status-bar-fg
      fgDim: '#737aa2', // --status-bar-fg-dim
      border: '#24283b', // --sidebar-border
      borderStrong: '#414868', // --panel-divider
      accent: '#7aa2f7', // --focus-ring
      accent2: '#bb9af7',
      onAccent: '#1a1b26',
      danger: '#f7768e', // --status-crashed
      warning: '#e0af68', // --status-spawning
      success: '#9ece6a', // --status-live
      agentBlocked: '#5f87ff', // --agent-blocked
      agentWorking: '#ff9500', // --agent-working
    });
  });

  it('terminal が従来の terminalRegistry.ts のパレット（と xterm の既定）と一致する', () => {
    expect(TOKYO_NIGHT.terminal).toEqual({
      background: '#1a1b26', // DEFAULT_BG
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      // 従来は未指定。xterm の既定（カーソル上の文字は黒、不透明な選択色は 30% で重ねる）と同じ見た目
      cursorAccent: '#000000',
      selectionBackground: '#ffffff',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    });
  });
});
