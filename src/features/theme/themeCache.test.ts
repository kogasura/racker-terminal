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
  loadCachedWindowThemeId,
  MAX_CACHED_SVG_BYTES,
  MAX_CACHED_SVG_TOTAL_BYTES,
  saveThemeCache,
  saveUserThemesCache,
  THEME_CACHE_KEY,
  USER_THEMES_CACHE_KEY,
  WINDOW_THEME_CACHE_KEY,
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
    // 色トークン 22 個 + すりガラスの filter (--rk-glass-filter。配色だけのテーマでは none)
    expect(rkKeys).toHaveLength(23);
    for (const key of rkKeys) {
      expect([key, vars[key]]).toEqual([key, initial.get(key)]);
    }
  });

  // 配色だけのテーマが当て直す --context-menu-bg は、variables.css の既定値と同じ式
  it.each(BUILTIN_THEMES.filter((t) => t.glass === undefined).map((t) => [t.id, t] as const))(
    '%s: --context-menu-bg は variables.css の既定値と同じ',
    (_id, theme) => {
      const initial = /--context-menu-bg\s*:\s*([^;]+);/.exec(variablesCss)?.[1].trim();
      expect(initial).toBeDefined();
      expect(buildCssVars(theme, 0.8)['--context-menu-bg']).toBe(initial);
    },
  );
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
    saveUserThemesCache([sunset, paper], []);

    expect(loadCachedUserThemes()).toEqual([sunset, paper]);
    expect(loadCachedUserThemes()[1].terminal).toEqual(RACKER_PAPER.terminal);
  });

  it('保存が無ければ空', () => {
    expect(loadCachedUserThemes()).toEqual([]);
  });

  it('空の一覧を保存すると、前回のキャッシュを消す (ファイルを消したテーマを引かない)', () => {
    saveUserThemesCache([sunset], []);
    saveUserThemesCache([], []);

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
    expect(() => saveUserThemesCache([sunset], [])).not.toThrow();
  });

  describe('背景付きの自作テーマ', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="#f0f"/></svg>';
    const neonJson = {
      name: 'Neon',
      backdrop: { svg: 'neon.svg', glass: { blur: 12, tint: '#1a0f2e', opacity: 0.5 } },
    };
    function neonWith(svg: string): ThemeDefinition {
      const result = parseThemeFile('neon.json', JSON.stringify(neonJson), { 'neon.svg': svg });
      if (!result.ok) throw new Error(result.error);
      return result.theme;
    }

    it('SVG の中身も保存し、次の起動で背景付きのまま取り出せる', () => {
      const neon = neonWith(SVG);
      saveUserThemesCache([neon, sunset], [neon.id]);

      const restored = loadCachedUserThemes();
      expect(restored).toEqual([neon, sunset]);
      expect(restored[0].backdrop).toEqual({ kind: 'user', fileName: 'neon.svg', svg: SVG });
      expect(restored[0].glass).toEqual({ blur: 12, tint: '#1a0f2e', opacity: 0.5 });
    });

    it('256 KiB を超える SVG は入れず、配色だけを覚える', () => {
      const huge = `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(MAX_CACHED_SVG_BYTES)}--></svg>`;
      saveUserThemesCache([neonWith(huge)], ['user:neon']);

      const [restored] = loadCachedUserThemes();
      expect(restored.id).toBe('user:neon');
      expect(restored.backdrop).toBeUndefined();
      expect(restored.glass).toBeUndefined();
      expect(localStorage.getItem(USER_THEMES_CACHE_KEY)).not.toContain('xxxxxxxx');
    });

    it('容量を超えて保存できなければ、SVG を外して保存し直す', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // SVG を含む書き込みだけが容量超過で失敗する localStorage に差し替える
      const items = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (value.includes('<svg')) throw new DOMException('quota', 'QuotaExceededError');
          items.set(key, value);
        },
      });

      try {
        saveUserThemesCache([neonWith(SVG)], ['user:neon']);

        const [restored] = loadCachedUserThemes();
        expect(restored.id).toBe('user:neon');
        expect(restored.backdrop).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('SVG の中身が欠けた項目は捨てる (参照先の無い背景をカタログに入れない)', () => {
      saveUserThemesCache([neonWith(SVG)], ['user:neon']);
      const [entry] = JSON.parse(localStorage.getItem(USER_THEMES_CACHE_KEY)!);
      delete entry.backdropSvg;
      localStorage.setItem(USER_THEMES_CACHE_KEY, JSON.stringify([entry]));

      expect(loadCachedUserThemes()).toEqual([]);
    });

    /** ID と SVG のファイル名を変えた、背景付きの自作テーマ。 */
    function backdropTheme(stem: string, svg: string): ThemeDefinition {
      const json = { ...neonJson, name: stem, backdrop: { ...neonJson.backdrop, svg: `${stem}.svg` } };
      const result = parseThemeFile(`${stem}.json`, JSON.stringify(json), { [`${stem}.svg`]: svg });
      if (!result.ok) throw new Error(result.error);
      return result.theme;
    }

    it('使っていないテーマの SVG は入れず、配色だけを覚える', () => {
      const used = backdropTheme('used', SVG);
      const unused = backdropTheme('unused', SVG.replace('#f0f', '#0ff'));
      saveUserThemesCache([used, unused], ['tokyo-night', used.id]);

      const [restoredUsed, restoredUnused] = loadCachedUserThemes();
      expect(restoredUsed).toEqual(used);
      expect(restoredUnused.id).toBe('user:unused');
      expect(restoredUnused.backdrop).toBeUndefined();
      expect(restoredUnused.glass).toBeUndefined();
      expect(restoredUnused.ui).toEqual(unused.ui);
      expect(localStorage.getItem(USER_THEMES_CACHE_KEY)).not.toContain('#0ff');
    });

    it('SVG は合計 1 MiB まで。使っている ID の順に入れ、超えた分は配色だけを覚える', () => {
      expect(MAX_CACHED_SVG_TOTAL_BYTES).toBe(1024 * 1024);
      // 1 つ 220 KiB 強。4 つまでは入り、5 つで 1 MiB を超える
      const big = (mark: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg"><!--${mark.repeat(220 * 1024)}--></svg>`;
      const themes = ['a', 'b', 'c', 'd', 'e'].map((stem) => backdropTheme(stem, big(stem)));
      // e を先に並べると、e から入れていく
      saveUserThemesCache(themes, ['user:e', 'user:a', 'user:b', 'user:c', 'user:d']);

      const restored = loadCachedUserThemes();
      expect(restored.map((t) => t.id)).toEqual(['user:a', 'user:b', 'user:c', 'user:d', 'user:e']);
      expect(restored.map((t) => t.backdrop !== undefined)).toEqual([true, true, true, false, true]);
    });

    it('使っている ID が重複しても SVG は 1 回だけ数える', () => {
      const neon = neonWith(SVG);
      saveUserThemesCache([neon], [neon.id, neon.id]);

      expect(loadCachedUserThemes()).toEqual([neon]);
    });
  });
});

describe('窓のテーマの ID のキャッシュ', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CSS 変数と一緒に保存した ID を、次の起動で取り出せる (組み込みのシーンは ID から描ける)', () => {
    const scene = BUILTIN_THEMES.find((t) => t.id === 'scene:honu-lagoon')!;
    saveThemeCache(buildCssVars(scene, 1), scene.id);

    expect(loadCachedWindowThemeId()).toBe('scene:honu-lagoon');
    expect(localStorage.getItem(WINDOW_THEME_CACHE_KEY)).toBe('scene:honu-lagoon');
  });

  it('保存が無い・空・長すぎる値は null', () => {
    expect(loadCachedWindowThemeId()).toBeNull();
    localStorage.setItem(WINDOW_THEME_CACHE_KEY, '');
    expect(loadCachedWindowThemeId()).toBeNull();
    localStorage.setItem(WINDOW_THEME_CACHE_KEY, 'x'.repeat(1000));
    expect(loadCachedWindowThemeId()).toBeNull();
  });

  it('ID を渡さなければ、前回の ID はそのまま残す', () => {
    saveThemeCache({ '--rk-accent': '#000000' }, 'nord');
    saveThemeCache({ '--rk-accent': '#111111' });

    expect(loadCachedWindowThemeId()).toBe('nord');
  });

  it('localStorage が使えなくても例外にしない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(loadCachedWindowThemeId()).toBeNull();
  });
});
