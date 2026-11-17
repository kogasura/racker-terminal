import { describe, it, expect } from 'vitest';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  RACKER_PAPER,
  TOKYO_NIGHT,
  glassSurfaces,
} from './builtinThemes';
import { parseThemeFile } from './parseTheme';
import { BUILTIN_SCENES } from '../backdrop/catalog';

const PALETTE_IDS = [
  'tokyo-night',
  'dracula',
  'nord',
  'catppuccin-mocha',
  'racker-ember',
  'racker-paper',
];

const SCENE_THEMES = BUILTIN_THEMES.filter((t) => t.backdrop !== undefined);

describe('BUILTIN_THEMES', () => {
  it('配色だけの 6 種 → 背景付きの 20 種の順で 26 種あり、ID が重複しない', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(ids).toHaveLength(26);
    expect(ids.slice(0, 6)).toEqual(PALETTE_IDS);
    expect(ids.slice(6)).toEqual(BUILTIN_SCENES.map((s) => `scene:${s.id}`));
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
        // 背景付きのテーマは、glass も自作のテーマと同じ検証（範囲・色）を通す
        ...(theme.glass ? { backdrop: { svg: 'scene.svg', glass: theme.glass } } : {}),
      });
      const result = parseThemeFile(`${theme.id}.json`, content, { 'scene.svg': '<svg/>' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.theme.ui).toEqual(theme.ui);
      expect(result.theme.terminal).toEqual(theme.terminal);
      expect(result.theme.glass).toEqual(theme.glass);
      for (const color of [...Object.values(theme.ui), ...Object.values(theme.terminal)]) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    },
  );

  it('配色だけのテーマで、ライトは racker-paper だけ', () => {
    expect(
      BUILTIN_THEMES.filter((t) => t.appearance === 'light' && t.backdrop === undefined).map(
        (t) => t.id,
      ),
    ).toEqual(['racker-paper']);
  });

  it('配色だけの 6 種は背景も glass も持たない', () => {
    for (const theme of BUILTIN_THEMES.slice(0, 6)) {
      expect(theme).not.toHaveProperty('backdrop');
      expect(theme).not.toHaveProperty('glass');
    }
  });
});

describe('背景付きのテーマ（本家の 20 シーン）', () => {
  it('20 種あり、どれも組み込みのシーンを背景に持つ', () => {
    expect(SCENE_THEMES).toHaveLength(20);
    for (const theme of SCENE_THEMES) {
      expect(theme.backdrop).toEqual({ kind: 'builtin', sceneId: theme.id.slice('scene:'.length) });
    }
  });

  it.each(BUILTIN_SCENES.map((s) => [s.id, s] as const))(
    '%s: 名前・明暗・accent・glass がシーンの値で、面の色は tint から作る',
    (sceneId, scene) => {
      const theme = BUILTIN_THEMES.find((t) => t.id === `scene:${sceneId}`);
      expect(theme).toBeDefined();
      if (!theme) return;
      const base = scene.window === 'light' ? RACKER_PAPER : TOKYO_NIGHT;
      const surfaces = glassSurfaces(scene.glass.tint, scene.window);

      expect(theme.name).toBe(scene.title);
      expect(theme.appearance).toBe(scene.window);
      expect(theme.source).toBe('builtin');
      expect(theme.glass).toEqual(scene.glass);
      expect(theme.ui).toEqual({
        ...base.ui,
        bg: scene.glass.tint,
        bgSidebar: surfaces.bgSidebar,
        bgElevated: surfaces.bgElevated,
        accent: scene.accent,
        accent2: scene.accent2,
      });
      expect(theme.terminal).toEqual({ ...base.terminal, background: scene.glass.tint });
    },
  );

  it('ダークはサイドバーを tint より暗く・浮いた面を明るく、ライトはサイドバーを暗く・浮いた面を明るくする', () => {
    const luminance = (hex: string) =>
      [1, 3, 5].reduce((sum, at) => sum + parseInt(hex.slice(at, at + 2), 16), 0);
    for (const appearance of ['dark', 'light'] as const) {
      const tint = appearance === 'dark' ? '#14143a' : '#e6fbff';
      const s = glassSurfaces(tint, appearance);
      expect(s.bg).toBe(tint);
      expect(luminance(s.bgSidebar)).toBeLessThan(luminance(tint));
      expect(luminance(s.bgElevated)).toBeGreaterThan(luminance(tint));
      expect(s.bgSidebar).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.bgElevated).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('土台のテーマ（Tokyo Night / Racker Paper）を書き換えない', () => {
    expect(BUILTIN_THEMES[0]).toBe(TOKYO_NIGHT);
    expect(BUILTIN_THEMES[5]).toBe(RACKER_PAPER);
    expect(TOKYO_NIGHT.ui.bg).toBe('#1a1b26');
    expect(RACKER_PAPER.ui.bg).toBe('#f7f5f0');
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
