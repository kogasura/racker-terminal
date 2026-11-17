/**
 * テーマと透明度から、documentElement に当てる CSS 変数一式を作る。
 *
 * - `--rk-*`: 色トークン 22 個（ui の 19 個 + appearance から決める hoverTint / scrim / shadow）
 * - 透明度を掛けた背景: `--sidebar-bg` など。variables.css の既定値と同じ `rgba(r, g, b, a)` 形式
 * - `--bg-alpha`: 透明度そのもの
 *
 * @module theme/cssVars
 */

import type { ThemeAppearance, ThemeDefinition, UiPalette } from './types';

/** ui のキーと CSS 変数名の対応。変数名は variables.css と一致させる。 */
const UI_VAR_NAMES: Record<keyof UiPalette, string> = {
  bg: '--rk-bg',
  bgSidebar: '--rk-bg-sidebar',
  bgElevated: '--rk-bg-elevated',
  bgInset: '--rk-bg-inset',
  bgHover: '--rk-bg-hover',
  bgActive: '--rk-bg-active',
  fg: '--rk-fg',
  fgMuted: '--rk-fg-muted',
  fgDim: '--rk-fg-dim',
  border: '--rk-border',
  borderStrong: '--rk-border-strong',
  accent: '--rk-accent',
  accent2: '--rk-accent-2',
  onAccent: '--rk-on-accent',
  danger: '--rk-danger',
  warning: '--rk-warning',
  success: '--rk-success',
  agentBlocked: '--rk-agent-blocked',
  agentWorking: '--rk-agent-working',
};

/** appearance から自動で決める色（テーマの JSON では指定しない）。 */
const APPEARANCE_VARS: Record<ThemeAppearance, Record<string, string>> = {
  dark: {
    '--rk-hover-tint': 'rgba(255, 255, 255, 0.1)',
    '--rk-scrim': 'rgba(0, 0, 0, 0.5)',
    '--rk-shadow': 'rgba(0, 0, 0, 0.5)',
  },
  light: {
    '--rk-hover-tint': 'rgba(0, 0, 0, 0.06)',
    '--rk-scrim': 'rgba(0, 0, 0, 0.3)',
    '--rk-shadow': 'rgba(0, 0, 0, 0.15)',
  },
};

/** crashed 状態のタブに重ねる薄い赤の濃さ。透明度とは無関係に固定。 */
const CRASHED_OVERLAY_ALPHA = 0.08;

/** `#rrggbb` を `rgba(r, g, b, a)` にする。 */
function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * テーマと透明度から CSS 変数一式を作る。
 * @param theme - 適用するテーマ（色は `#rrggbb`）
 * @param alpha - 背景の透明度（設定の transparency。1 で不透明）
 */
export function buildCssVars(theme: ThemeDefinition, alpha: number): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of Object.keys(UI_VAR_NAMES) as (keyof UiPalette)[]) {
    vars[UI_VAR_NAMES[key]] = theme.ui[key];
  }
  Object.assign(vars, APPEARANCE_VARS[theme.appearance]);

  vars['--bg-alpha'] = String(alpha);
  vars['--sidebar-bg'] = rgba(theme.ui.bgSidebar, alpha);
  vars['--sidebar-bg-elevated'] = rgba(theme.ui.bgElevated, alpha);
  vars['--group-header-bg'] = rgba(theme.ui.bg, alpha);
  vars['--title-bar-bg'] = rgba(theme.ui.bg, alpha);
  vars['--terminal-bg'] = rgba(theme.terminal.background, alpha);
  vars['--crashed-overlay-bg'] = rgba(theme.ui.danger, CRASHED_OVERLAY_ALPHA);
  return vars;
}
