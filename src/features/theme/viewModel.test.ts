import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES, TOKYO_NIGHT } from '../../lib/theme/builtinThemes';
import type { ThemeDefinition } from '../../lib/theme/types';
import type { ThemeState } from './machine';
import { resolveTabTheme, selectAppTheme, selectThemeView } from './viewModel';

const sunset: ThemeDefinition = { ...TOKYO_NIGHT, id: 'user:sunset', name: 'Sunset', source: 'user' };
const aurora: ThemeDefinition = { ...TOKYO_NIGHT, id: 'user:aurora', name: 'Aurora', source: 'user' };
const broken = { fileName: 'broken.json', error: 'ui.accent: "#zz0" は色として読めません' };

const loaded: ThemeState = { status: 'loaded', themes: [sunset, aurora], errors: [broken] };

describe('selectThemeView', () => {
  it('選択肢は組み込みが先、ユーザーのテーマが後 (読み込んだ順)', () => {
    const vm = selectThemeView(loaded);
    expect(vm.options.map((o) => o.id)).toEqual([
      ...BUILTIN_THEMES.map((t) => t.id),
      'user:sunset',
      'user:aurora',
    ]);
  });

  it('選択肢は id / name / source だけを持つ', () => {
    const vm = selectThemeView(loaded);
    expect(vm.options[0]).toEqual({ id: 'tokyo-night', name: 'Tokyo Night', source: 'builtin' });
    expect(vm.options[vm.options.length - 1]).toEqual({ id: 'user:aurora', name: 'Aurora', source: 'user' });
  });

  it('読み込めなかったファイルの一覧を出す', () => {
    expect(selectThemeView(loaded).errors).toEqual([broken]);
  });

  it('カタログは選択肢と同じ並びのテーマ定義', () => {
    const vm = selectThemeView(loaded);
    expect(vm.catalog.map((t) => t.id)).toEqual(vm.options.map((o) => o.id));
    expect(vm.catalog).toContain(sunset);
  });

  it('idle は組み込みだけ・エラーなし・読み込み中扱い', () => {
    const vm = selectThemeView({ status: 'idle' });
    expect(vm.options.map((o) => o.id)).toEqual(BUILTIN_THEMES.map((t) => t.id));
    expect(vm.errors).toEqual([]);
    expect(vm.loading).toBe(true);
  });

  it('再読み込み中は前回の結果を出しつつ、読み込み中扱い', () => {
    const vm = selectThemeView({
      status: 'loading',
      themes: [sunset],
      errors: [broken],
      reloadQueued: false,
    });
    expect(vm.options.map((o) => o.id)).toContain('user:sunset');
    expect(vm.errors).toEqual([broken]);
    expect(vm.loading).toBe(true);
  });

  it('読み込み後は loading=false', () => {
    expect(selectThemeView(loaded).loading).toBe(false);
  });
});

describe('selectAppTheme', () => {
  it('選んだテーマを返す', () => {
    expect(selectAppTheme(selectThemeView(loaded), 'user:sunset')).toBe(sunset);
    const dracula = BUILTIN_THEMES.find((t) => t.id === 'dracula')!;
    expect(selectAppTheme(selectThemeView(loaded), 'dracula')).toBe(dracula);
  });

  it('読み込み後に見つからない ID は Tokyo Night にフォールバックする', () => {
    expect(selectAppTheme(selectThemeView(loaded), 'user:deleted')).toBe(TOKYO_NIGHT);
  });

  it('読み込み前に見つからない ID はまだ当てない (起動時のキャッシュの色を潰さない)', () => {
    expect(selectAppTheme(selectThemeView({ status: 'idle' }), 'user:sunset')).toBeNull();
  });

  it('読み込み前でも組み込みテーマはすぐ当てる', () => {
    const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;
    expect(selectAppTheme(selectThemeView({ status: 'idle' }), 'nord')).toBe(nord);
  });
});

describe('resolveTabTheme', () => {
  const catalog = selectThemeView(loaded).catalog;
  const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;

  it('タブに themeId があればそれを使う', () => {
    expect(resolveTabTheme(catalog, 'user:sunset', 'nord')).toBe(sunset);
  });

  it('タブに themeId が無ければアプリの設定を使う', () => {
    expect(resolveTabTheme(catalog, undefined, 'nord')).toBe(nord);
  });

  it('見つからない ID は Tokyo Night にフォールバックする', () => {
    expect(resolveTabTheme(catalog, 'user:deleted', 'nord')).toBe(TOKYO_NIGHT);
    expect(resolveTabTheme(catalog, undefined, 'no-such-theme')).toBe(TOKYO_NIGHT);
  });
});
