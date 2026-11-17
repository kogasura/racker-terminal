import { describe, it, expect } from 'vitest';
import { buildCssVars } from './cssVars';
import { BUILTIN_THEMES, RACKER_PAPER, TOKYO_NIGHT } from './builtinThemes';

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
];

describe('buildCssVars', () => {
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s: --rk-* 22 個と透明度つきの背景 7 個をちょうど返す',
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
