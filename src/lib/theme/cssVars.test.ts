import { describe, it, expect } from 'vitest';
import { TERMINAL_VEIL_MIN, buildCssVars } from './cssVars';
import { BUILTIN_THEMES, RACKER_PAPER, TOKYO_NIGHT, glassSurfaces } from './builtinThemes';
import type { ThemeDefinition } from './types';

const RK_NAMES = [
  '--rk-bg',
  '--rk-bg-sidebar',
  '--rk-bg-elevated',
  '--rk-bg-inset',
  '--rk-bg-hover',
  '--rk-bg-active',
  '--rk-fg',
  '--rk-fg-muted',
  '--rk-fg-dim',
  '--rk-border',
  '--rk-border-strong',
  '--rk-accent',
  '--rk-accent-2',
  '--rk-on-accent',
  '--rk-danger',
  '--rk-warning',
  '--rk-success',
  '--rk-agent-blocked',
  '--rk-agent-working',
  '--rk-hover-tint',
  '--rk-scrim',
  '--rk-shadow',
];

const ALPHA_NAMES = [
  '--sidebar-bg',
  '--sidebar-bg-elevated',
  '--group-header-bg',
  '--title-bar-bg',
  '--terminal-bg',
  '--crashed-overlay-bg',
  '--bg-alpha',
  '--rk-glass-blur',
];

/** 配色だけのテーマ（第 1 段の 6 種）。 */
const PALETTE_THEMES = BUILTIN_THEMES.filter((t) => t.glass === undefined);

describe('buildCssVars', () => {
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s: --rk-* 22 個と透明度つきの背景 7 個と --rk-glass-blur をちょうど返す',
    (_id, theme) => {
      const vars = buildCssVars(theme, 1);
      expect(Object.keys(vars).sort()).toEqual([...RK_NAMES, ...ALPHA_NAMES].sort());
    },
  );

  it('Tokyo Night・不透明なら、従来の variables.css と同じ値になる', () => {
    const vars = buildCssVars(TOKYO_NIGHT, 1);
    expect(vars['--rk-bg']).toBe('#1a1b26');
    expect(vars['--rk-accent-2']).toBe('#bb9af7');
    expect(vars['--rk-agent-working']).toBe('#ff9500');
    expect(vars['--bg-alpha']).toBe('1');
    expect(vars['--sidebar-bg']).toBe('rgba(22, 22, 30, 1)');
    expect(vars['--sidebar-bg-elevated']).toBe('rgba(35, 35, 51, 1)');
    expect(vars['--group-header-bg']).toBe('rgba(26, 27, 38, 1)');
    expect(vars['--title-bar-bg']).toBe('rgba(26, 27, 38, 1)');
    expect(vars['--terminal-bg']).toBe('rgba(26, 27, 38, 1)');
    expect(vars['--crashed-overlay-bg']).toBe('rgba(247, 118, 142, 0.08)');
  });

  it('透明度を rgba の alpha に反映する（crashed の薄赤は透明度に依らない）', () => {
    const vars = buildCssVars(TOKYO_NIGHT, 0.8);
    expect(vars['--bg-alpha']).toBe('0.8');
    expect(vars['--sidebar-bg']).toBe('rgba(22, 22, 30, 0.8)');
    expect(vars['--sidebar-bg-elevated']).toBe('rgba(35, 35, 51, 0.8)');
    expect(vars['--group-header-bg']).toBe('rgba(26, 27, 38, 0.8)');
    expect(vars['--title-bar-bg']).toBe('rgba(26, 27, 38, 0.8)');
    expect(vars['--terminal-bg']).toBe('rgba(26, 27, 38, 0.8)');
    expect(vars['--crashed-overlay-bg']).toBe('rgba(247, 118, 142, 0.08)');
    // 色トークンそのものは透明度の影響を受けない
    expect(vars['--rk-bg']).toBe('#1a1b26');
  });

  it('--terminal-bg は ui.bg ではなく terminal.background から作る', () => {
    const theme = {
      ...TOKYO_NIGHT,
      terminal: { ...TOKYO_NIGHT.terminal, background: '#000000' },
    };
    expect(buildCssVars(theme, 0.5)['--terminal-bg']).toBe('rgba(0, 0, 0, 0.5)');
    expect(buildCssVars(theme, 0.5)['--group-header-bg']).toBe('rgba(26, 27, 38, 0.5)');
  });

  it('appearance が dark なら白を、light なら黒を薄く重ねる', () => {
    const dark = buildCssVars(TOKYO_NIGHT, 1);
    expect(dark['--rk-hover-tint']).toBe('rgba(255, 255, 255, 0.1)');
    expect(dark['--rk-scrim']).toBe('rgba(0, 0, 0, 0.5)');
    expect(dark['--rk-shadow']).toBe('rgba(0, 0, 0, 0.5)');

    const light = buildCssVars(RACKER_PAPER, 1);
    expect(light['--rk-hover-tint']).toBe('rgba(0, 0, 0, 0.06)');
    expect(light['--rk-scrim']).toBe('rgba(0, 0, 0, 0.3)');
    expect(light['--rk-shadow']).toBe('rgba(0, 0, 0, 0.15)');
  });

  it('ui の各キーを対応する --rk-* に入れる', () => {
    const vars = buildCssVars(RACKER_PAPER, 1);
    expect(vars['--rk-bg-sidebar']).toBe(RACKER_PAPER.ui.bgSidebar);
    expect(vars['--rk-on-accent']).toBe(RACKER_PAPER.ui.onAccent);
    expect(vars['--rk-agent-blocked']).toBe(RACKER_PAPER.ui.agentBlocked);
    expect(vars['--rk-border-strong']).toBe(RACKER_PAPER.ui.borderStrong);
  });
});

describe('buildCssVars: glass の無いテーマ', () => {
  it.each(PALETTE_THEMES.map((t) => [t.id, t] as const))(
    '%s: --rk-glass-blur は 0px で、透明度は第 1 段と同じく効く',
    (_id, theme) => {
      const vars = buildCssVars(theme, 0.6);
      expect(vars['--rk-glass-blur']).toBe('0px');
      expect(vars['--bg-alpha']).toBe('0.6');
      expect(vars['--sidebar-bg']).toMatch(/, 0\.6\)$/);
      expect(vars['--terminal-bg']).toMatch(/, 0\.6\)$/);
    },
  );
});

describe('buildCssVars: glass のあるテーマ（背景付き）', () => {
  const GLASS_THEME: ThemeDefinition = {
    ...TOKYO_NIGHT,
    id: 'scene:test',
    ui: { ...TOKYO_NIGHT.ui, bg: '#14143a' },
    terminal: { ...TOKYO_NIGHT.terminal, background: '#14143a' },
    backdrop: { kind: 'builtin', sceneId: 'test' },
    glass: { blur: 16, tint: '#14143a', opacity: 0.5 },
  };

  it('パネルは tint から作った面の色を opacity で重ね、ぼかしを px で出す', () => {
    const vars = buildCssVars(GLASS_THEME, 1);
    const s = glassSurfaces('#14143a', 'dark');
    const rgb = (hex: string) =>
      [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ');
    expect(vars['--sidebar-bg']).toBe(`rgba(${rgb(s.bgSidebar)}, 0.5)`);
    expect(vars['--sidebar-bg-elevated']).toBe(`rgba(${rgb(s.bgElevated)}, 0.5)`);
    expect(vars['--group-header-bg']).toBe('rgba(20, 20, 58, 0.5)');
    expect(vars['--title-bar-bg']).toBe('rgba(20, 20, 58, 0.5)');
    expect(vars['--rk-glass-blur']).toBe('16px');
    expect(vars['--bg-alpha']).toBe('1');
  });

  it('ターミナルの面は max(opacity, TERMINAL_VEIL_MIN) の濃さ', () => {
    expect(TERMINAL_VEIL_MIN).toBe(0.72);
    expect(buildCssVars(GLASS_THEME, 1)['--terminal-bg']).toBe('rgba(20, 20, 58, 0.72)');
    const thick = { ...GLASS_THEME, glass: { blur: 0, tint: '#14143a', opacity: 0.9 } };
    expect(buildCssVars(thick, 1)['--terminal-bg']).toBe('rgba(20, 20, 58, 0.9)');
    expect(buildCssVars(thick, 1)['--rk-glass-blur']).toBe('0px');
  });

  it('透明度 (alpha) を変えても出力が変わらない', () => {
    expect(buildCssVars(GLASS_THEME, 0.3)).toEqual(buildCssVars(GLASS_THEME, 1));
  });

  it('crashed の薄赤と --rk-* の色トークンは glass の無いテーマと同じ作り方', () => {
    const vars = buildCssVars(GLASS_THEME, 1);
    expect(vars['--crashed-overlay-bg']).toBe('rgba(247, 118, 142, 0.08)');
    expect(vars['--rk-bg']).toBe('#14143a');
    expect(vars['--rk-hover-tint']).toBe('rgba(255, 255, 255, 0.1)');
  });

  it.each(BUILTIN_THEMES.filter((t) => t.glass).map((t) => [t.id, t] as const))(
    '%s: パネルの面は ui の面の色（tint から作ったもの）と一致する',
    (_id, theme) => {
      const vars = buildCssVars(theme, 0.5);
      const opacity = theme.glass?.opacity ?? Number.NaN;
      const rgb = (hex: string) =>
        [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ');
      expect(vars['--sidebar-bg']).toBe(`rgba(${rgb(theme.ui.bgSidebar)}, ${opacity})`);
      expect(vars['--sidebar-bg-elevated']).toBe(`rgba(${rgb(theme.ui.bgElevated)}, ${opacity})`);
      expect(vars['--title-bar-bg']).toBe(`rgba(${rgb(theme.ui.bg)}, ${opacity})`);
      expect(vars['--bg-alpha']).toBe('1');
    },
  );
});
