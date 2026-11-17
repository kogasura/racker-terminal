/**
 * 組み込みテーマ（26 種）。配色だけの 6 種と、動く背景の付いた 20 種。
 *
 * 配色だけの 6 種:
 * - Tokyo Night: 従来の配色そのまま（variables.css と terminalRegistry.ts にあった値を移したもの）
 * - Dracula / Nord / Catppuccin Mocha: 各テーマの公式パレットから取る（MIT。LICENSES/themes-MIT.txt）
 * - Racker Ember: racker オリジナルの赤みのある暗色
 * - Racker Paper: racker オリジナルのライト
 *
 * 公式パレットに無い UI の色（サイドバー・ホバーなど）は、パレットの近い色から選んでいる。
 *
 * 選択範囲 (selectionBackground) について: xterm は不透明な選択色を 30% の濃さで
 * 重ねるため、各テーマとも「30% で重ねて見える」明るさの色を置いている。
 *
 * 背景付きの 20 種: 本家 Claude Code の公式プラグイン theme-examples（Apache-2.0）のシーンから作る
 * （src/lib/backdrop/catalog.ts）。ID は `scene:<シーンの id>`。
 *
 * @module theme/builtinThemes
 */

import { BUILTIN_SCENES, type BuiltinScene } from '../backdrop/catalog';
import type { ThemeAppearance, ThemeDefinition } from './types';

/** 設定で選んだ ID が見つからないときに使うテーマ。 */
export const DEFAULT_THEME_ID = 'tokyo-night';

/**
 * Tokyo Night（従来の配色）。値は 1 つも変えずに移している。
 * terminal.cursorAccent / selectionBackground は従来 xterm に指定しておらず、
 * xterm の既定（カーソル上の文字は黒、選択は白の 30%）で描かれていたので、同じ見た目になる値を書く。
 */
export const TOKYO_NIGHT: ThemeDefinition = {
  id: 'tokyo-night',
  name: 'Tokyo Night',
  appearance: 'dark',
  source: 'builtin',
  ui: {
    bg: '#1a1b26',
    bgSidebar: '#16161e',
    bgElevated: '#232333',
    bgInset: '#0d0e14',
    bgHover: '#1f2335',
    bgActive: '#292e42',
    fg: '#c0caf5',
    fgMuted: '#9aa5ce',
    fgDim: '#737aa2',
    border: '#24283b',
    borderStrong: '#414868',
    accent: '#7aa2f7',
    accent2: '#bb9af7',
    onAccent: '#1a1b26',
    danger: '#f7768e',
    warning: '#e0af68',
    success: '#9ece6a',
    agentBlocked: '#5f87ff',
    agentWorking: '#ff9500',
  },
  terminal: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
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
  },
};

/** Dracula。https://draculatheme.com/contribute のパレットと、公式のターミナル配色。 */
const DRACULA: ThemeDefinition = {
  id: 'dracula',
  name: 'Dracula',
  appearance: 'dark',
  source: 'builtin',
  ui: {
    bg: '#282a36',
    bgSidebar: '#21222c',
    bgElevated: '#343746',
    bgInset: '#191a21',
    bgHover: '#343746',
    bgActive: '#44475a',
    fg: '#f8f8f2',
    fgMuted: '#c6c8d1',
    fgDim: '#8b93bf',
    border: '#343746',
    borderStrong: '#6272a4',
    accent: '#bd93f9',
    accent2: '#ff79c6',
    onAccent: '#282a36',
    danger: '#ff5555',
    warning: '#f1fa8c',
    success: '#50fa7b',
    agentBlocked: '#8be9fd',
    agentWorking: '#ffb86c',
  },
  terminal: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#f8f8f2',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
};

/** Nord。https://www.nordtheme.com/docs/colors-and-palettes の nord0〜nord15。 */
const NORD: ThemeDefinition = {
  id: 'nord',
  name: 'Nord',
  appearance: 'dark',
  source: 'builtin',
  ui: {
    bg: '#2e3440',
    bgSidebar: '#292e39',
    bgElevated: '#3b4252',
    bgInset: '#242933',
    bgHover: '#3b4252',
    bgActive: '#434c5e',
    fg: '#d8dee9',
    fgMuted: '#b4bccb',
    fgDim: '#8590a6',
    border: '#3b4252',
    borderStrong: '#4c566a',
    accent: '#88c0d0',
    accent2: '#b48ead',
    onAccent: '#2e3440',
    danger: '#bf616a',
    warning: '#ebcb8b',
    success: '#a3be8c',
    agentBlocked: '#81a1c1',
    agentWorking: '#d08770',
  },
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#d8dee9',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
};

/** Catppuccin Mocha。https://catppuccin.com/palette の Mocha と、公式のターミナル配色。 */
const CATPPUCCIN_MOCHA: ThemeDefinition = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  appearance: 'dark',
  source: 'builtin',
  ui: {
    bg: '#1e1e2e',
    bgSidebar: '#181825',
    bgElevated: '#313244',
    bgInset: '#11111b',
    bgHover: '#313244',
    bgActive: '#45475a',
    fg: '#cdd6f4',
    fgMuted: '#a6adc8',
    fgDim: '#7f849c',
    border: '#313244',
    borderStrong: '#585b70',
    accent: '#89b4fa',
    accent2: '#cba6f7',
    onAccent: '#11111b',
    danger: '#f38ba8',
    warning: '#f9e2af',
    success: '#a6e3a1',
    agentBlocked: '#74c7ec',
    agentWorking: '#fab387',
  },
  terminal: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#9399b2',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
};

/** Racker Ember（オリジナル）。熾火のような赤みのある暗色。 */
const RACKER_EMBER: ThemeDefinition = {
  id: 'racker-ember',
  name: 'Racker Ember',
  appearance: 'dark',
  source: 'builtin',
  ui: {
    bg: '#1c1614',
    bgSidebar: '#171210',
    bgElevated: '#271e1b',
    bgInset: '#100c0b',
    bgHover: '#2a1f1b',
    bgActive: '#3a2924',
    fg: '#f0dcd2',
    fgMuted: '#c9ab9e',
    fgDim: '#977a6e',
    border: '#2e2320',
    borderStrong: '#5a3f36',
    accent: '#ff7a45',
    accent2: '#f2a65a',
    onAccent: '#1c1614',
    danger: '#ff5c5c',
    warning: '#f2c45a',
    success: '#9fcf6a',
    agentBlocked: '#78a6ff',
    agentWorking: '#ffa630',
  },
  terminal: {
    background: '#1c1614',
    foreground: '#f0dcd2',
    cursor: '#ff7a45',
    cursorAccent: '#1c1614',
    selectionBackground: '#ffb38a',
    black: '#2a1f1b',
    red: '#ef5a4f',
    green: '#9fcf6a',
    yellow: '#f2c45a',
    blue: '#6f9bd8',
    magenta: '#d97aa8',
    cyan: '#6fc2b8',
    white: '#d9c4b8',
    brightBlack: '#6b524a',
    brightRed: '#ff7a6b',
    brightGreen: '#b8e08a',
    brightYellow: '#ffd97a',
    brightBlue: '#8fb5ee',
    brightMagenta: '#ef9cc4',
    brightCyan: '#8fdcd2',
    brightWhite: '#fff0e8',
  },
};

/**
 * Racker Paper（オリジナル）。生成りの紙のようなライト。
 * 文字色は背景に対して WCAG AA（4.5:1）以上、onAccent は accent の上で 4.5:1 以上を目安にしている。
 * ANSI の white / brightWhite は背景に溶けないよう灰色にしている（ライト系の一般的な扱い）。
 */
export const RACKER_PAPER: ThemeDefinition = {
  id: 'racker-paper',
  name: 'Racker Paper',
  appearance: 'light',
  source: 'builtin',
  ui: {
    bg: '#f7f5f0',
    bgSidebar: '#efece4',
    bgElevated: '#ffffff',
    bgInset: '#e9e5db',
    bgHover: '#e6e2d8',
    bgActive: '#dcd6c8',
    fg: '#2b2a28',
    fgMuted: '#55524b',
    fgDim: '#6e6a62',
    border: '#ddd8cc',
    borderStrong: '#b9b2a2',
    accent: '#2862c0',
    accent2: '#8247c4',
    onAccent: '#ffffff',
    danger: '#b83039',
    warning: '#8f5a00',
    success: '#2b7230',
    agentBlocked: '#3a5fd0',
    agentWorking: '#c45f00',
  },
  terminal: {
    background: '#f7f5f0',
    foreground: '#2b2a28',
    cursor: '#2b2a28',
    cursorAccent: '#f7f5f0',
    selectionBackground: '#2862c0',
    black: '#2b2a28',
    red: '#b83039',
    green: '#2b7230',
    yellow: '#8f5a00',
    blue: '#2862c0',
    magenta: '#8247c4',
    cyan: '#0f7480',
    white: '#6e6a62',
    brightBlack: '#5f5b53',
    brightRed: '#d4464f',
    brightGreen: '#38893c',
    brightYellow: '#a86d00',
    brightBlue: '#3d78d6',
    brightMagenta: '#9358d1',
    brightCyan: '#13808c',
    brightWhite: '#8a867c',
  },
};

/** 配色だけの組み込みテーマ（第 1 段の 6 種）。 */
const PALETTE_THEMES: readonly ThemeDefinition[] = [
  TOKYO_NIGHT,
  DRACULA,
  NORD,
  CATPPUCCIN_MOCHA,
  RACKER_EMBER,
  RACKER_PAPER,
];

/** `#rrggbb` を、`toward` の色へ `ratio`（0〜1）だけ寄せる。 */
function mixHex(hex: string, toward: string, ratio: number): string {
  const channel = (color: string, at: number) => parseInt(color.slice(at, at + 2), 16);
  let out = '#';
  for (const at of [1, 3, 5]) {
    const value = Math.round(channel(hex, at) * (1 - ratio) + channel(toward, at) * ratio);
    out += value.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * すりガラスの色 (glass.tint) から、パネルの面の色を作る。
 * - bg: tint そのもの（タイトルバー・グループ見出し・ターミナル）
 * - bgSidebar: 少し沈める（Tokyo Night / Racker Paper の bg とサイドバーの段差に合わせる）
 * - bgElevated: 少し浮かせる（ダイアログ・メニュー）
 *
 * 背景付きのテーマの面の色（builtin）と、すりガラスのパネルの色（cssVars.ts）で共有する。
 */
export function glassSurfaces(
  tint: string,
  appearance: ThemeAppearance,
): { bg: string; bgSidebar: string; bgElevated: string } {
  if (appearance === 'dark') {
    return {
      bg: tint,
      bgSidebar: mixHex(tint, '#000000', 0.2),
      bgElevated: mixHex(tint, '#ffffff', 0.06),
    };
  }
  return {
    bg: tint,
    bgSidebar: mixHex(tint, '#000000', 0.03),
    bgElevated: mixHex(tint, '#ffffff', 0.6),
  };
}

/** ID の接頭辞。背景付きの組み込みテーマは `scene:<シーンの id>`。 */
export const SCENE_THEME_ID_PREFIX = 'scene:';

/**
 * 本家のシーン 1 つから、背景付きのテーマを作る。
 * 土台はダークなら Tokyo Night、ライトなら Racker Paper。面の色は glass.tint から、
 * accent / accent2 はシーンごとに選んだ色にする。glass はシーンの値そのまま。
 */
function sceneTheme(scene: BuiltinScene): ThemeDefinition {
  const base = scene.window === 'light' ? RACKER_PAPER : TOKYO_NIGHT;
  const surfaces = glassSurfaces(scene.glass.tint, scene.window);
  return {
    id: `${SCENE_THEME_ID_PREFIX}${scene.id}`,
    name: scene.title,
    appearance: scene.window,
    source: 'builtin',
    ui: { ...base.ui, ...surfaces, accent: scene.accent, accent2: scene.accent2 },
    terminal: { ...base.terminal, background: surfaces.bg },
    backdrop: { kind: 'builtin', sceneId: scene.id },
    glass: { ...scene.glass },
  };
}

/** 背景付きの組み込みテーマ（本家の 20 シーン）。 */
const SCENE_THEMES: readonly ThemeDefinition[] = BUILTIN_SCENES.map(sceneTheme);

/** 組み込みテーマの一覧。設定画面にはこの順で並ぶ（配色だけの 6 種 → 背景付きの 20 種）。 */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = [...PALETTE_THEMES, ...SCENE_THEMES];
