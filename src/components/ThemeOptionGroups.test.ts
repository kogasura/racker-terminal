import { describe, it, expect } from 'vitest';
import { groupThemeOptions, isMissingTheme } from './ThemeOptionGroups';
import type { ThemeOption } from '../features/theme/viewModel';
import { selectThemeView } from '../features/theme/viewModel';

function option(id: string, overrides: Partial<ThemeOption> = {}): ThemeOption {
  return {
    id,
    name: id,
    source: 'builtin',
    appearance: 'dark',
    hasBackdrop: false,
    ...overrides,
  };
}

describe('groupThemeOptions', () => {
  it('配色だけ・動く背景（ダーク）・動く背景（ライト）・自分のテーマの順に分ける', () => {
    const groups = groupThemeOptions([
      option('tokyo-night'),
      option('scene:night-reef', { hasBackdrop: true }),
      option('scene:honu-lagoon', { hasBackdrop: true, appearance: 'light' }),
      option('racker-paper', { appearance: 'light' }),
      option('user:sunset', { source: 'user' }),
      option('user:neon', { source: 'user', hasBackdrop: true }),
    ]);
    expect(groups.map((g) => [g.label, g.options.map((o) => o.id)])).toEqual([
      ['配色だけ', ['tokyo-night', 'racker-paper']],
      ['動く背景（ダーク）', ['scene:night-reef']],
      ['動く背景（ライト）', ['scene:honu-lagoon']],
      // 自分のテーマは背景の有無を問わずまとめる
      ['自分のテーマ', ['user:sunset', 'user:neon']],
    ]);
  });

  it('自分のテーマが無ければ、そのグループを出さない', () => {
    const groups = groupThemeOptions([
      option('tokyo-night'),
      option('scene:night-reef', { hasBackdrop: true }),
      option('scene:honu-lagoon', { hasBackdrop: true, appearance: 'light' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['plain', 'backdrop-dark', 'backdrop-light']);
  });

  it('組み込みの 26 種は 3 グループに漏れなく入る (配色だけ 6・背景付き 20)', () => {
    const { options } = selectThemeView({ status: 'idle', themes: [] });
    const groups = groupThemeOptions(options);
    expect(groups.map((g) => g.key)).toEqual(['plain', 'backdrop-dark', 'backdrop-light']);
    expect(groups[0].options).toHaveLength(6);
    expect(groups[1].options.length + groups[2].options.length).toBe(20);
    expect(groups.flatMap((g) => g.options)).toHaveLength(options.length);
  });

  it('空の選択肢なら何も返さない', () => {
    expect(groupThemeOptions([])).toEqual([]);
  });
});

describe('isMissingTheme', () => {
  const options = [option('tokyo-night')];

  it('カタログに無い ID は見つからない扱い', () => {
    expect(isMissingTheme(options, 'user:deleted')).toBe(true);
  });

  it('カタログにある ID と、空文字 (アプリの設定に従う) は見つからない扱いにしない', () => {
    expect(isMissingTheme(options, 'tokyo-night')).toBe(false);
    expect(isMissingTheme(options, '')).toBe(false);
  });
});
