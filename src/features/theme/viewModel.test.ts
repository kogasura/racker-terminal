import { describe, it, expect } from 'vitest';
import { BUILTIN_SCENES, sceneSvg } from '../../lib/backdrop/catalog';
import { contextLimitFor } from '../../lib/claudeMeta';
import { BUILTIN_THEMES, RACKER_PAPER, TOKYO_NIGHT } from '../../lib/theme/builtinThemes';
import type { ThemeDefinition } from '../../lib/theme/types';
import type { ThemeState } from './machine';
import {
  backdropContext,
  isBackdropPaused,
  resolveRuntimeThemes,
  resolveTabTheme,
  selectAppTheme,
  selectBackdropSvg,
  selectBackdropView,
  selectThemeView,
  selectWindowTheme,
  toBackdropAgent,
} from './viewModel';

const sunset: ThemeDefinition = { ...TOKYO_NIGHT, id: 'user:sunset', name: 'Sunset', source: 'user' };
const aurora: ThemeDefinition = { ...TOKYO_NIGHT, id: 'user:aurora', name: 'Aurora', source: 'user' };
const broken = { fileName: 'broken.json', error: 'ui.accent: "#zz0" は色として読めません' };

const loaded: ThemeState = { status: 'loaded', themes: [sunset, aurora], errors: [broken] };

const NEON_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const neon: ThemeDefinition = {
  ...TOKYO_NIGHT,
  id: 'user:neon',
  name: 'Neon',
  source: 'user',
  backdrop: { kind: 'user', fileName: 'neon.svg', svg: NEON_SVG },
  glass: { blur: 14, tint: '#1a0f2e', opacity: 0.4 },
};
const HONU = BUILTIN_THEMES.find((t) => t.id === 'scene:honu-lagoon')!;

describe('selectThemeView', () => {
  it('選択肢は組み込みが先、ユーザーのテーマが後 (読み込んだ順)', () => {
    const vm = selectThemeView(loaded);
    expect(vm.options.map((o) => o.id)).toEqual([
      ...BUILTIN_THEMES.map((t) => t.id),
      'user:sunset',
      'user:aurora',
    ]);
  });

  it('選択肢は id / name / source / appearance / hasBackdrop を持つ (配色だけのテーマに blurb は無い)', () => {
    const vm = selectThemeView(loaded);
    expect(vm.options[0]).toEqual({
      id: 'tokyo-night',
      name: 'Tokyo Night',
      source: 'builtin',
      appearance: 'dark',
      hasBackdrop: false,
    });
    expect(vm.options[vm.options.length - 1]).toEqual({
      id: 'user:aurora',
      name: 'Aurora',
      source: 'user',
      appearance: 'dark',
      hasBackdrop: false,
    });
    expect(vm.options.find((o) => o.id === RACKER_PAPER.id)?.appearance).toBe('light');
  });

  it('背景付きの組み込みテーマは hasBackdrop と、シーンのひとこと説明を持つ', () => {
    const vm = selectThemeView(loaded);
    for (const scene of BUILTIN_SCENES) {
      const option = vm.options.find((o) => o.id === `scene:${scene.id}`);
      expect(option).toMatchObject({
        source: 'builtin',
        appearance: scene.window,
        hasBackdrop: true,
        blurb: scene.blurb,
      });
    }
  });

  it('背景付きの自作テーマは hasBackdrop だけを持つ (blurb は無い)', () => {
    const vm = selectThemeView({ status: 'loaded', themes: [neon], errors: [] });
    const option = vm.options.find((o) => o.id === neon.id);
    expect(option).toEqual({ id: neon.id, name: 'Neon', source: 'user', appearance: 'dark', hasBackdrop: true });
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
    const vm = selectThemeView({ status: 'idle', themes: [] });
    expect(vm.options.map((o) => o.id)).toEqual(BUILTIN_THEMES.map((t) => t.id));
    expect(vm.errors).toEqual([]);
    expect(vm.loading).toBe(true);
  });

  it('再読み込み中は前回の結果を出しつつ、読み込み中扱い', () => {
    const vm = selectThemeView({ status: 'loading', themes: [sunset], errors: [broken] });
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
    expect(selectAppTheme(selectThemeView({ status: 'idle', themes: [] }), 'user:sunset')).toBeNull();
  });

  it('読み込み前でも、キャッシュ済みの自作テーマはすぐ当てる', () => {
    const idle: ThemeState = { status: 'idle', themes: [sunset] };
    expect(selectAppTheme(selectThemeView(idle), 'user:sunset')).toBe(sunset);
  });

  it('読み込み前でも組み込みテーマはすぐ当てる', () => {
    const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;
    expect(selectAppTheme(selectThemeView({ status: 'idle', themes: [] }), 'nord')).toBe(nord);
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

  it('idle でもキャッシュ済みの自作テーマを解決できる (起動直後に Tokyo Night で描かない)', () => {
    const idleCatalog = selectThemeView({ status: 'idle', themes: [sunset] }).catalog;
    expect(resolveTabTheme(idleCatalog, undefined, 'user:sunset')).toBe(sunset);
    expect(resolveTabTheme(idleCatalog, 'user:sunset', 'nord')).toBe(sunset);
  });

  it('上書きの ID がカタログにあれば、アプリの設定より上書きを使う', () => {
    expect(resolveTabTheme(catalog, 'dracula', 'user:sunset')).toBe(
      BUILTIN_THEMES.find((t) => t.id === 'dracula'),
    );
  });

  it('上書きの ID が見つからなければ、アプリの設定のテーマに従う', () => {
    expect(resolveTabTheme(catalog, 'user:deleted', 'nord')).toBe(nord);
    expect(resolveTabTheme(catalog, 'user:deleted', 'user:sunset')).toBe(sunset);
  });

  it('上書きもアプリの設定も見つからなければ Tokyo Night にフォールバックする', () => {
    expect(resolveTabTheme(catalog, 'user:deleted', 'no-such-theme')).toBe(TOKYO_NIGHT);
    expect(resolveTabTheme(catalog, undefined, 'no-such-theme')).toBe(TOKYO_NIGHT);
  });
});

describe('resolveRuntimeThemes', () => {
  const catalog = selectThemeView(loaded).catalog;
  const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;

  it('タブの上書きがあればそれ、無ければアプリの設定のテーマを runtime ごとに返す', () => {
    const tabs = { a: { themeId: 'user:sunset' }, b: {} };

    expect(resolveRuntimeThemes([['a', 'rt-a'], ['b', 'rt-b']], tabs, catalog, 'nord')).toEqual([
      ['rt-a', sunset],
      ['rt-b', nord],
    ]);
  });

  it('runtime はあるのにタブが無ければ、アプリの設定のテーマにする', () => {
    expect(resolveRuntimeThemes([['gone', 'rt']], {}, catalog, 'nord')).toEqual([['rt', nord]]);
  });

  it('上書きの ID が見つからなければアプリの設定のテーマ、それも無ければ Tokyo Night', () => {
    const tabs = { a: { themeId: 'user:deleted' } };
    expect(resolveRuntimeThemes([['a', 'rt']], tabs, catalog, 'nord')).toEqual([['rt', nord]]);
    expect(resolveRuntimeThemes([['a', 'rt']], tabs, catalog, 'no-such-theme')).toEqual([
      ['rt', TOKYO_NIGHT],
    ]);
  });

  it('runtime が無ければ空', () => {
    expect(resolveRuntimeThemes([], { a: {} }, catalog, 'nord')).toEqual([]);
  });

  it('試しに表示の間はアクティブなタブだけ試しのテーマになり、終えたら戻る', () => {
    const dracula = BUILTIN_THEMES.find((t) => t.id === 'dracula')!;
    const tabs = { a: { themeId: 'user:sunset' }, b: {} };
    const entries: [string, string][] = [
      ['a', 'rt-a'],
      ['b', 'rt-b'],
    ];

    // アクティブなタブに上書きがあっても、試しのテーマを当てる (窓と同じ)
    expect(
      resolveRuntimeThemes(entries, tabs, catalog, 'nord', {
        activeTabId: 'a',
        previewThemeId: 'dracula',
      }),
    ).toEqual([
      ['rt-a', dracula],
      ['rt-b', nord],
    ]);
    expect(
      resolveRuntimeThemes(entries, tabs, catalog, 'nord', {
        activeTabId: 'b',
        previewThemeId: 'dracula',
      }),
    ).toEqual([
      ['rt-a', sunset],
      ['rt-b', dracula],
    ]);
    // 試しに表示を終えたら元のテーマ
    expect(
      resolveRuntimeThemes(entries, tabs, catalog, 'nord', {
        activeTabId: 'a',
        previewThemeId: null,
      }),
    ).toEqual([
      ['rt-a', sunset],
      ['rt-b', nord],
    ]);
  });

  it('試しのテーマがカタログに無ければ、試していないときと同じに解決する', () => {
    const tabs = { a: { themeId: 'user:sunset' } };
    expect(
      resolveRuntimeThemes([['a', 'rt']], tabs, catalog, 'nord', {
        activeTabId: 'a',
        previewThemeId: 'user:deleted',
      }),
    ).toEqual([['rt', sunset]]);
  });
});

describe('selectWindowTheme', () => {
  const view = selectThemeView(loaded);
  const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;
  const ids = (tabThemeId: string | undefined, appThemeId: string, previewThemeId: string | null = null) => ({
    previewThemeId,
    tabThemeId,
    appThemeId,
  });

  it('アクティブなタブの上書きがあれば、それを窓に当てる', () => {
    expect(selectWindowTheme(view, ids('user:sunset', 'nord'))).toBe(sunset);
    expect(selectWindowTheme(view, ids(HONU.id, 'nord'))).toBe(HONU);
  });

  it('上書きが無い (タブが無い・お気に入りで選んでいない) ときはアプリの設定', () => {
    expect(selectWindowTheme(view, ids(undefined, 'nord'))).toBe(nord);
  });

  it('上書きのファイルが消えたら、アプリの設定のテーマに従う', () => {
    expect(selectWindowTheme(view, ids('user:deleted', 'nord'))).toBe(nord);
  });

  it('上書きもアプリの設定も見つからなければ Tokyo Night', () => {
    expect(selectWindowTheme(view, ids('user:deleted', 'no-such-theme'))).toBe(TOKYO_NIGHT);
  });

  it('試しに表示しているテーマがあれば、それが最優先', () => {
    expect(selectWindowTheme(view, ids('user:sunset', 'nord', HONU.id))).toBe(HONU);
    expect(selectWindowTheme(view, ids(undefined, 'nord', 'user:aurora'))).toBe(aurora);
  });

  it('試しに表示の ID がカタログに無ければ無視する', () => {
    expect(selectWindowTheme(view, ids('user:sunset', 'nord', 'user:deleted'))).toBe(sunset);
  });

  it('読み込み前に上書きの ID がカタログに無ければ、まだ当てない (起動時のキャッシュを潰さない)', () => {
    const idle = selectThemeView({ status: 'idle', themes: [] });
    expect(selectWindowTheme(idle, ids('user:sunset', 'nord'))).toBeNull();
    expect(selectWindowTheme(idle, ids(undefined, 'user:sunset'))).toBeNull();
  });

  it('読み込み前でも、組み込みとキャッシュ済みの自作テーマはすぐ当てる', () => {
    const idle = selectThemeView({ status: 'idle', themes: [sunset] });
    expect(selectWindowTheme(idle, ids('user:sunset', 'nord'))).toBe(sunset);
    expect(selectWindowTheme(idle, ids(HONU.id, 'user:deleted'))).toBe(HONU);
    expect(selectWindowTheme(idle, ids(undefined, 'nord'))).toBe(nord);
  });
});

describe('動く背景', () => {
  it('組み込みの背景付きテーマは、シーンの SVG を描く', () => {
    expect(selectBackdropSvg(HONU)).toBe(sceneSvg('honu-lagoon'));
    expect(selectBackdropSvg(HONU)).toMatch(/<svg/);
  });

  it('自作の背景付きテーマは、ファイルの中身をそのまま描く', () => {
    expect(selectBackdropSvg(neon)).toBe(NEON_SVG);
  });

  it('背景の無いテーマ・テーマが決まっていないときは null', () => {
    expect(selectBackdropSvg(TOKYO_NIGHT)).toBeNull();
    expect(selectBackdropSvg(null)).toBeNull();
  });

  it('知らないシーンの ID は null (描かない)', () => {
    const unknown: ThemeDefinition = { ...HONU, backdrop: { kind: 'builtin', sceneId: 'no-such-scene' } };
    expect(selectBackdropSvg(unknown)).toBeNull();
  });

  it('「背景を動かす」が未設定ならオン扱い (止めない)。false のときだけ止める', () => {
    expect(isBackdropPaused({})).toBe(false);
    expect(isBackdropPaused({ backdropMotion: undefined })).toBe(false);
    expect(isBackdropPaused({ backdropMotion: true })).toBe(false);
    expect(isBackdropPaused({ backdropMotion: false })).toBe(true);
  });

  it('エージェントの状態は idle / working / blocked に写す (done と未検出は idle)', () => {
    expect(toBackdropAgent('working')).toBe('working');
    expect(toBackdropAgent('blocked')).toBe('blocked');
    expect(toBackdropAgent('done')).toBe('idle');
    expect(toBackdropAgent('idle')).toBe('idle');
    expect(toBackdropAgent(undefined)).toBe('idle');
  });

  it('selectBackdropView は SVG・止めるか・エージェントの状態をまとめる', () => {
    expect(selectBackdropView(neon, {}, 'working')).toEqual({ svg: NEON_SVG, paused: false, agent: 'working' });
    expect(selectBackdropView(TOKYO_NIGHT, { backdropMotion: false }, undefined)).toEqual({
      svg: null,
      paused: true,
      agent: 'idle',
    });
  });

  describe('backdropContext', () => {
    it('コンテキストの使用率は contextTokens / モデルの上限', () => {
      const model = 'claude-opus-4-5';
      const limit = contextLimitFor(model, 50_000);
      expect(backdropContext({ model, contextTokens: 50_000 })).toBeCloseTo(50_000 / limit);
    });

    it('Claude の情報が無い (ステータスバーが無効など)・トークン数が無いときは 0', () => {
      expect(backdropContext(null)).toBe(0);
      expect(backdropContext({ model: 'claude-opus-5' })).toBe(0);
    });

    it('0〜1 に収める', () => {
      expect(backdropContext({ contextTokens: 0 })).toBe(0);
      expect(backdropContext({ contextTokens: 5_000_000 })).toBe(1);
    });
  });
});
