/**
 * 第 1 段（v1.9.16）との互換を確かめる。
 *
 * 背景付きのテーマを足しても、配色だけの 6 種の値と、glass の無いテーマの CSS 変数は
 * 第 1 段から変わらない。増えるのは次の 2 つだけで、どちらも見た目を変えない。
 * - --rk-glass-filter: none（backdrop-filter を付けない）
 * - --context-menu-bg: variables.css の既定値と同じ式（背景付きのテーマから切り替えたときに
 *   すりガラスの色を残さないため、毎回当て直す）
 * 期待値は v1.9.16 の builtinThemes.ts / cssVars.ts から写したもの。
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES } from './builtinThemes';
import { buildCssVars } from './cssVars';
import type { ThemeDefinition } from './types';

/** v1.9.16 の組み込みテーマ（配色だけの 6 種）。 */
const STAGE1_PALETTE_THEMES: readonly ThemeDefinition[] = [
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    appearance: 'dark',
    source: 'builtin',
    ui: {
      bg: '#1a1b26', bgSidebar: '#16161e', bgElevated: '#232333', bgInset: '#0d0e14',
      bgHover: '#1f2335', bgActive: '#292e42', fg: '#c0caf5', fgMuted: '#9aa5ce', fgDim: '#737aa2',
      border: '#24283b', borderStrong: '#414868', accent: '#7aa2f7', accent2: '#bb9af7',
      onAccent: '#1a1b26', danger: '#f7768e', warning: '#e0af68', success: '#9ece6a',
      agentBlocked: '#5f87ff', agentWorking: '#ff9500',
    },
    terminal: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#000000',
      selectionBackground: '#ffffff', black: '#15161e', red: '#f7768e', green: '#9ece6a',
      yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    appearance: 'dark',
    source: 'builtin',
    ui: {
      bg: '#282a36', bgSidebar: '#21222c', bgElevated: '#343746', bgInset: '#191a21',
      bgHover: '#343746', bgActive: '#44475a', fg: '#f8f8f2', fgMuted: '#c6c8d1', fgDim: '#8b93bf',
      border: '#343746', borderStrong: '#6272a4', accent: '#bd93f9', accent2: '#ff79c6',
      onAccent: '#282a36', danger: '#ff5555', warning: '#f1fa8c', success: '#50fa7b',
      agentBlocked: '#8be9fd', agentWorking: '#ffb86c',
    },
    terminal: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: '#f8f8f2', black: '#21222c', red: '#ff5555', green: '#50fa7b',
      yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    appearance: 'dark',
    source: 'builtin',
    ui: {
      bg: '#2e3440', bgSidebar: '#292e39', bgElevated: '#3b4252', bgInset: '#242933',
      bgHover: '#3b4252', bgActive: '#434c5e', fg: '#d8dee9', fgMuted: '#b4bccb', fgDim: '#8590a6',
      border: '#3b4252', borderStrong: '#4c566a', accent: '#88c0d0', accent2: '#b48ead',
      onAccent: '#2e3440', danger: '#bf616a', warning: '#ebcb8b', success: '#a3be8c',
      agentBlocked: '#81a1c1', agentWorking: '#d08770',
    },
    terminal: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: '#d8dee9', black: '#3b4252', red: '#bf616a', green: '#a3be8c',
      yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    appearance: 'dark',
    source: 'builtin',
    ui: {
      bg: '#1e1e2e', bgSidebar: '#181825', bgElevated: '#313244', bgInset: '#11111b',
      bgHover: '#313244', bgActive: '#45475a', fg: '#cdd6f4', fgMuted: '#a6adc8', fgDim: '#7f849c',
      border: '#313244', borderStrong: '#585b70', accent: '#89b4fa', accent2: '#cba6f7',
      onAccent: '#11111b', danger: '#f38ba8', warning: '#f9e2af', success: '#a6e3a1',
      agentBlocked: '#74c7ec', agentWorking: '#fab387',
    },
    terminal: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
      selectionBackground: '#9399b2', black: '#45475a', red: '#f38ba8', green: '#a6e3a1',
      yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
  },
  {
    id: 'racker-ember',
    name: 'Racker Ember',
    appearance: 'dark',
    source: 'builtin',
    ui: {
      bg: '#1c1614', bgSidebar: '#171210', bgElevated: '#271e1b', bgInset: '#100c0b',
      bgHover: '#2a1f1b', bgActive: '#3a2924', fg: '#f0dcd2', fgMuted: '#c9ab9e', fgDim: '#977a6e',
      border: '#2e2320', borderStrong: '#5a3f36', accent: '#ff7a45', accent2: '#f2a65a',
      onAccent: '#1c1614', danger: '#ff5c5c', warning: '#f2c45a', success: '#9fcf6a',
      agentBlocked: '#78a6ff', agentWorking: '#ffa630',
    },
    terminal: {
      background: '#1c1614', foreground: '#f0dcd2', cursor: '#ff7a45', cursorAccent: '#1c1614',
      selectionBackground: '#ffb38a', black: '#2a1f1b', red: '#ef5a4f', green: '#9fcf6a',
      yellow: '#f2c45a', blue: '#6f9bd8', magenta: '#d97aa8', cyan: '#6fc2b8', white: '#d9c4b8',
      brightBlack: '#6b524a', brightRed: '#ff7a6b', brightGreen: '#b8e08a', brightYellow: '#ffd97a',
      brightBlue: '#8fb5ee', brightMagenta: '#ef9cc4', brightCyan: '#8fdcd2',
      brightWhite: '#fff0e8',
    },
  },
  {
    id: 'racker-paper',
    name: 'Racker Paper',
    appearance: 'light',
    source: 'builtin',
    ui: {
      bg: '#f7f5f0', bgSidebar: '#efece4', bgElevated: '#ffffff', bgInset: '#e9e5db',
      bgHover: '#e6e2d8', bgActive: '#dcd6c8', fg: '#2b2a28', fgMuted: '#55524b', fgDim: '#6e6a62',
      border: '#ddd8cc', borderStrong: '#b9b2a2', accent: '#2862c0', accent2: '#8247c4',
      onAccent: '#ffffff', danger: '#b83039', warning: '#8f5a00', success: '#2b7230',
      agentBlocked: '#3a5fd0', agentWorking: '#c45f00',
    },
    terminal: {
      background: '#f7f5f0', foreground: '#2b2a28', cursor: '#2b2a28', cursorAccent: '#f7f5f0',
      selectionBackground: '#2862c0', black: '#2b2a28', red: '#b83039', green: '#2b7230',
      yellow: '#8f5a00', blue: '#2862c0', magenta: '#8247c4', cyan: '#0f7480', white: '#6e6a62',
      brightBlack: '#5f5b53', brightRed: '#d4464f', brightGreen: '#38893c', brightYellow: '#a86d00',
      brightBlue: '#3d78d6', brightMagenta: '#9358d1', brightCyan: '#13808c',
      brightWhite: '#8a867c',
    },
  },
];

/** v1.9.16 の buildCssVars（glass の無いテーマの出力の基準）。 */
function stage1CssVars(theme: ThemeDefinition, alpha: number): Record<string, string> {
  const rgba = (hex: string, a: number) =>
    `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
  const ui = theme.ui;
  const appearanceVars =
    theme.appearance === 'dark'
      ? {
          '--rk-hover-tint': 'rgba(255, 255, 255, 0.1)',
          '--rk-scrim': 'rgba(0, 0, 0, 0.5)',
          '--rk-shadow': 'rgba(0, 0, 0, 0.5)',
        }
      : {
          '--rk-hover-tint': 'rgba(0, 0, 0, 0.06)',
          '--rk-scrim': 'rgba(0, 0, 0, 0.3)',
          '--rk-shadow': 'rgba(0, 0, 0, 0.15)',
        };
  return {
    '--rk-bg': ui.bg,
    '--rk-bg-sidebar': ui.bgSidebar,
    '--rk-bg-elevated': ui.bgElevated,
    '--rk-bg-inset': ui.bgInset,
    '--rk-bg-hover': ui.bgHover,
    '--rk-bg-active': ui.bgActive,
    '--rk-fg': ui.fg,
    '--rk-fg-muted': ui.fgMuted,
    '--rk-fg-dim': ui.fgDim,
    '--rk-border': ui.border,
    '--rk-border-strong': ui.borderStrong,
    '--rk-accent': ui.accent,
    '--rk-accent-2': ui.accent2,
    '--rk-on-accent': ui.onAccent,
    '--rk-danger': ui.danger,
    '--rk-warning': ui.warning,
    '--rk-success': ui.success,
    '--rk-agent-blocked': ui.agentBlocked,
    '--rk-agent-working': ui.agentWorking,
    ...appearanceVars,
    '--bg-alpha': String(alpha),
    '--sidebar-bg': rgba(ui.bgSidebar, alpha),
    '--sidebar-bg-elevated': rgba(ui.bgElevated, alpha),
    '--group-header-bg': rgba(ui.bg, alpha),
    '--title-bar-bg': rgba(ui.bg, alpha),
    '--terminal-bg': rgba(theme.terminal.background, alpha),
    '--crashed-overlay-bg': rgba(ui.danger, 0.08),
  };
}

/** 第 1 段から増えた変数。glass の無いテーマでは見た目を変えない値になる。 */
const STAGE2_PALETTE_VARS = {
  '--rk-glass-filter': 'none',
  '--context-menu-bg': 'color-mix(in srgb, var(--rk-bg-hover) 80%, var(--rk-bg-sidebar))',
};

describe('第 1 段との互換', () => {
  it.each(STAGE1_PALETTE_THEMES.map((t, i) => [t.id, t, i] as const))(
    '%s: 配色だけの組み込みテーマの値が第 1 段から変わらない',
    (_id, expected, index) => {
      expect(BUILTIN_THEMES[index]).toEqual(expected);
    },
  );

  it.each(
    STAGE1_PALETTE_THEMES.flatMap((t) => [1, 0.85, 0.7].map((alpha) => [t.id, alpha, t] as const)),
  )('%s (透明度 %s): glass の無いテーマの CSS 変数は第 1 段と同じで、増えるのは none の filter と既定のメニューの面だけ', (id, alpha, stage1) => {
    const current = BUILTIN_THEMES.find((t) => t.id === id);
    expect(current).toBeDefined();
    if (!current) return;
    expect(buildCssVars(current, alpha)).toEqual({
      ...stage1CssVars(stage1, alpha),
      ...STAGE2_PALETTE_VARS,
    });
  });

  it('glass の無い自作テーマも第 1 段と同じ出力になる', () => {
    const user: ThemeDefinition = {
      ...STAGE1_PALETTE_THEMES[5],
      id: 'user:mine',
      name: 'Mine',
      source: 'user',
      ui: { ...STAGE1_PALETTE_THEMES[5].ui, accent: '#ff4fa3' },
    };
    expect(buildCssVars(user, 0.9)).toEqual({
      ...stage1CssVars(user, 0.9),
      ...STAGE2_PALETTE_VARS,
    });
  });
});
