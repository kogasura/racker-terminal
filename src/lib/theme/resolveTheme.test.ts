import { describe, it, expect } from 'vitest';
import { buildCatalog, resolveTheme, toXtermTheme } from './resolveTheme';
import { BUILTIN_THEMES, TOKYO_NIGHT } from './builtinThemes';
import { parseThemeFile } from './parseTheme';
import type { ThemeDefinition } from './types';

function userTheme(fileName: string, name: string): ThemeDefinition {
  const result = parseThemeFile(fileName, JSON.stringify({ name, ui: { accent: '#ff0000' } }));
  if (!result.ok) throw new Error(result.error);
  return result.theme;
}

describe('buildCatalog', () => {
  it('組み込みが先、ユーザーのテーマが後に並ぶ', () => {
    const sunset = userTheme('sunset.json', 'Sunset');
    const catalog = buildCatalog([sunset]);
    expect(catalog.map((t) => t.id)).toEqual([...BUILTIN_THEMES.map((t) => t.id), 'user:sunset']);
  });

  it('ユーザーのテーマが無ければ組み込みだけ', () => {
    expect(buildCatalog([])).toEqual([...BUILTIN_THEMES]);
  });
});

describe('resolveTheme', () => {
  const catalog = buildCatalog([userTheme('sunset.json', 'Sunset')]);

  it('組み込みの ID を解決する', () => {
    expect(resolveTheme(catalog, 'nord').name).toBe('Nord');
  });

  it('user: の ID を解決する', () => {
    const theme = resolveTheme(catalog, 'user:sunset');
    expect(theme.name).toBe('Sunset');
    expect(theme.source).toBe('user');
  });

  it('未知の ID は Tokyo Night にフォールバックする', () => {
    expect(resolveTheme(catalog, 'user:deleted')).toBe(TOKYO_NIGHT);
    expect(resolveTheme(catalog, '')).toBe(TOKYO_NIGHT);
  });

  it('undefined は Tokyo Night', () => {
    expect(resolveTheme(catalog, undefined)).toBe(TOKYO_NIGHT);
  });

  it('カタログが空でも Tokyo Night を返す', () => {
    expect(resolveTheme([], 'tokyo-night')).toBe(TOKYO_NIGHT);
  });
});

describe('toXtermTheme', () => {
  it('background を含めず、それ以外の terminal の色をそのまま渡す', () => {
    const xterm = toXtermTheme(TOKYO_NIGHT);
    expect(xterm).not.toHaveProperty('background');
    const { background: _bg, ...expected } = TOKYO_NIGHT.terminal;
    expect(xterm).toEqual(expected);
    expect(Object.keys(xterm)).toHaveLength(20);
  });

  it('元のテーマを書き換えない', () => {
    const xterm = toXtermTheme(TOKYO_NIGHT);
    xterm.red = '#000000';
    expect(TOKYO_NIGHT.terminal.red).toBe('#f7768e');
    expect(TOKYO_NIGHT.terminal.background).toBe('#1a1b26');
  });
});
