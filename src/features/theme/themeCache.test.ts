import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_THEMES, RACKER_PAPER, TOKYO_NIGHT } from '../../lib/theme/builtinThemes';
import { buildCssVars } from '../../lib/theme/cssVars';
import { parseThemeFile } from '../../lib/theme/parseTheme';
import type { ThemeDefinition } from '../../lib/theme/types';
import {
  applyCachedThemeVars,
  applyThemeVars,
  loadCachedUserThemes,
  saveThemeCache,
  saveUserThemesCache,
  THEME_CACHE_KEY,
  USER_THEMES_CACHE_KEY,
} from './themeCache';

// vitest は CSS を処理しない設定なので `?raw` でも中身が空になる。ファイルとして直接読む。
// (URL は happy-dom の実装に差し替わっていて file: を解決できないので、パスで組み立てる)
const variablesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../styles/variables.css'),
  'utf-8',
);

/** variables.css で定義されているカスタムプロパティ名。 */
function definedVariables(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]));
}

describe('buildCssVars と variables.css の対応', () => {
  // 当てる変数の名前が CSS 側とずれると、テーマを選んでも色が変わらない箇所が黙って残る
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))(
    '%s: 出力キーがすべて variables.css に定義されている',
    (_id, theme) => {
      const defined = definedVariables(variablesCss);
      const missing = Object.keys(buildCssVars(theme, 0.8)).filter((key) => !defined.has(key));
      expect(missing).toEqual([]);
    },
  );

  // ThemeRoot が Tokyo Night を当てた時点で、CSS の初期値から見た目が変わらないこと
  it('Tokyo Night の --rk-* は variables.css の初期値と一致する', () => {
    const initial = new Map(
      Array.from(variablesCss.matchAll(/(--rk-[a-z0-9-]+)\s*:\s*([^;]+);/g), (m) => [
        m[1],
        m[2].trim(),
      ]),
    );
    const vars = buildCssVars(TOKYO_NIGHT, 1);
    const rkKeys = Object.keys(vars).filter((key) => key.startsWith('--rk-'));
    expect(rkKeys).toHaveLength(22);
    for (const key of rkKeys) {
      expect([key, vars[key]]).toEqual([key, initial.get(key)]);
    }
  });
});

describe('themeCache', () => {
  const root = document.documentElement.style;

  beforeEach(() => {
    localStorage.clear();
    root.removeProperty('--rk-accent');
    root.removeProperty('--bg-alpha');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applyThemeVars は documentElement に変数を当てる', () => {
    applyThemeVars({ '--rk-accent': '#ff0000', '--bg-alpha': '0.8' });

    expect(root.getPropertyValue('--rk-accent')).toBe('#ff0000');
    expect(root.getPropertyValue('--bg-alpha')).toBe('0.8');
  });

  it('保存したものを、次の起動で当て直せる', () => {
    saveThemeCache({ '--rk-accent': '#00ff00' });
    expect(localStorage.getItem(THEME_CACHE_KEY)).not.toBeNull();

    applyCachedThemeVars();

    expect(root.getPropertyValue('--rk-accent')).toBe('#00ff00');
  });

  it('保存が無ければ何もしない', () => {
    applyCachedThemeVars();

    expect(root.getPropertyValue('--rk-accent')).toBe('');
  });

  it('壊れた中身では例外にせず何もしない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(THEME_CACHE_KEY, '{not json');

    expect(() => applyCachedThemeVars()).not.toThrow();
    expect(root.getPropertyValue('--rk-accent')).toBe('');
  });

  it('カスタムプロパティ以外のキーや文字列以外の値は当てない', () => {
    localStorage.setItem(
      THEME_CACHE_KEY,
      JSON.stringify({ color: 'red', '--rk-accent': 42, '--bg-alpha': '0.9' }),
    );

    applyCachedThemeVars();

    expect(root.getPropertyValue('color')).toBe('');
    expect(root.getPropertyValue('--rk-accent')).toBe('');
    expect(root.getPropertyValue('--bg-alpha')).toBe('0.9');
  });

  it('localStorage が使えなくても例外にしない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => applyCachedThemeVars()).not.toThrow();
    expect(() => saveThemeCache({ '--rk-accent': '#000000' })).not.toThrow();
  });
});

describe('自作テーマのキャッシュ', () => {
  /** themes フォルダから読んだのと同じ手順でテーマを作る。 */
  function userTheme(fileName: string, json: unknown): ThemeDefinition {
    const result = parseThemeFile(fileName, JSON.stringify(json));
    if (!result.ok) throw new Error(result.error);
    return result.theme;
  }

  const sunset = userTheme('sunset.json', { name: 'Sunset', ui: { accent: '#f80', bg: '#201010' } });
  const paper = userTheme('my-paper.json', { name: 'My Paper', appearance: 'light' });

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('保存したテーマを、次の起動で同じ定義として取り出せる', () => {
    saveUserThemesCache([sunset, paper]);

    expect(loadCachedUserThemes()).toEqual([sunset, paper]);
    expect(loadCachedUserThemes()[1].terminal).toEqual(RACKER_PAPER.terminal);
  });

  it('保存が無ければ空', () => {
    expect(loadCachedUserThemes()).toEqual([]);
  });

  it('空の一覧を保存すると、前回のキャッシュを消す (ファイルを消したテーマを引かない)', () => {
    saveUserThemesCache([sunset]);
    saveUserThemesCache([]);

    expect(loadCachedUserThemes()).toEqual([]);
  });

  it('壊れた中身では例外にせず空', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(USER_THEMES_CACHE_KEY, '{not json');
    expect(loadCachedUserThemes()).toEqual([]);

    localStorage.setItem(USER_THEMES_CACHE_KEY, JSON.stringify({ id: 'user:x' }));
    expect(loadCachedUserThemes()).toEqual([]);
  });

  it('検証を通らない項目だけを捨てる', () => {
    const good = { id: sunset.id, name: sunset.name, appearance: 'dark', ui: sunset.ui, terminal: sunset.terminal };
    localStorage.setItem(
      USER_THEMES_CACHE_KEY,
      JSON.stringify([
        good,
        // 色が読めない
        { ...good, id: 'user:bad-color', ui: { ...sunset.ui, accent: 'red' } },
        // 組み込みの ID を名乗る
        { ...good, id: 'tokyo-night' },
        // ID が無い
        { name: 'No id' },
        null,
        'user:sunset',
      ]),
    );

    expect(loadCachedUserThemes()).toEqual([sunset]);
  });

  it('localStorage が使えなくても例外にしない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(loadCachedUserThemes()).toEqual([]);
    expect(() => saveUserThemesCache([sunset])).not.toThrow();
  });
});
