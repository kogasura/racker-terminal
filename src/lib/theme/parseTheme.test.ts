import { describe, it, expect, vi } from 'vitest';
import { parseThemeFile, type ParseThemeResult } from './parseTheme';
import { RACKER_PAPER, TOKYO_NIGHT } from './builtinThemes';
import type { ThemeDefinition } from './types';

/** 成功を前提にテーマを取り出す。失敗ならエラー文ごと落とす。 */
function okTheme(result: ParseThemeResult): ThemeDefinition {
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  return result.theme;
}

/** 失敗を前提にエラー文を取り出す。 */
function errorOf(result: ParseThemeResult): string {
  if (result.ok) throw new Error('parse unexpectedly succeeded');
  return result.error;
}

function parse(json: unknown, fileName = 'my.json'): ParseThemeResult {
  return parseThemeFile(fileName, JSON.stringify(json));
}

describe('parseThemeFile: 成功', () => {
  it('最小の JSON（name と ui.accent だけ）は Tokyo Night とマージされる', () => {
    const theme = okTheme(parse({ name: 'Sunset', ui: { accent: '#ff8800' } }, 'sunset.json'));
    expect(theme).toEqual({
      id: 'user:sunset',
      name: 'Sunset',
      appearance: 'dark',
      source: 'user',
      ui: { ...TOKYO_NIGHT.ui, accent: '#ff8800' },
      terminal: TOKYO_NIGHT.terminal,
    });
  });

  it('appearance: light ならベースは Racker Paper', () => {
    const theme = okTheme(parse({ name: 'Light', appearance: 'light', ui: { accent: '#123456' } }));
    expect(theme.appearance).toBe('light');
    expect(theme.ui).toEqual({ ...RACKER_PAPER.ui, accent: '#123456' });
    expect(theme.terminal).toEqual(RACKER_PAPER.terminal);
  });

  it('appearance: dark を明示しても Tokyo Night がベース', () => {
    const theme = okTheme(parse({ name: 'Dark', appearance: 'dark' }));
    expect(theme.ui).toEqual(TOKYO_NIGHT.ui);
  });

  it('#abc は #aabbcc に、大文字は小文字に揃える', () => {
    const theme = okTheme(
      parse({ name: 'x', ui: { accent: '#abc', fg: '#ABCDEF' }, terminal: { red: '#F0a' } }),
    );
    expect(theme.ui.accent).toBe('#aabbcc');
    expect(theme.ui.fg).toBe('#abcdef');
    expect(theme.terminal.red).toBe('#ff00aa');
  });

  it('未知のキー（effect や ui の未知キー）は無視して成功する', () => {
    const theme = okTheme(
      parse({
        name: 'x',
        effect: { kind: 'snow', density: 3 },
        ui: { accent: '#111111', glow: 'not a color' },
        terminal: { sparkle: 1 },
      }),
    );
    expect(theme).not.toHaveProperty('effect');
    expect(theme.ui).not.toHaveProperty('glow');
    expect(theme.terminal).not.toHaveProperty('sparkle');
    expect(theme.ui.accent).toBe('#111111');
  });

  it('terminal.background を省略すると ui.bg になる', () => {
    const theme = okTheme(parse({ name: 'x', ui: { bg: '#102030' } }));
    expect(theme.ui.bg).toBe('#102030');
    expect(theme.terminal.background).toBe('#102030');
  });

  it('terminal.background を書けばそちらが優先される', () => {
    const theme = okTheme(
      parse({ name: 'x', ui: { bg: '#102030' }, terminal: { background: '#000000' } }),
    );
    expect(theme.terminal.background).toBe('#000000');
  });

  it('ui.bg も terminal.background も無ければベースの背景', () => {
    const theme = okTheme(parse({ name: 'x', appearance: 'light' }));
    expect(theme.terminal.background).toBe(RACKER_PAPER.terminal.background);
  });

  it('ID は user:<拡張子を除いたファイル名>、name は前後の空白を落とす', () => {
    const theme = okTheme(parse({ name: '  夕焼け  ' }, 'Sunset.Neon.JSON'));
    expect(theme.id).toBe('user:Sunset.Neon');
    expect(theme.name).toBe('夕焼け');
  });

  it('name はちょうど 40 文字まで受け付ける（絵文字は 1 文字と数える）', () => {
    expect(okTheme(parse({ name: 'a'.repeat(40) })).name).toHaveLength(40);
    expect(parseThemeFile('x.json', JSON.stringify({ name: '🔥'.repeat(40) })).ok).toBe(true);
  });

  it('ベースのテーマを書き換えない', () => {
    const before = structuredClone(TOKYO_NIGHT);
    okTheme(parse({ name: 'x', ui: { accent: '#000000' }, terminal: { red: '#000000' } }));
    expect(TOKYO_NIGHT).toEqual(before);
  });
});

describe('parseThemeFile: 失敗', () => {
  it('JSON として読めない', () => {
    const result = parseThemeFile('broken.json', '{ "name": ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fileName).toBe('broken.json');
    expect(result.error).toMatch(/^JSON として読めません: /);
  });

  it('ルートがオブジェクトでない', () => {
    expect(errorOf(parseThemeFile('x.json', '[]'))).toContain('JSON のオブジェクト');
    expect(errorOf(parseThemeFile('x.json', '"name"'))).toContain('JSON のオブジェクト');
    expect(errorOf(parseThemeFile('x.json', 'null'))).toContain('JSON のオブジェクト');
  });

  it('name が無い', () => {
    expect(errorOf(parse({ ui: { accent: '#fff' } }))).toBe(
      'name がありません。テーマの表示名を書いてください',
    );
  });

  it('name が文字列でない', () => {
    expect(errorOf(parse({ name: 42 }))).toBe('name: 42 は文字列で書いてください');
  });

  it('name が空（空白だけを含む）', () => {
    expect(errorOf(parse({ name: '' }))).toBe('name が空です。テーマの表示名を書いてください');
    expect(errorOf(parse({ name: '   ' }))).toBe('name が空です。テーマの表示名を書いてください');
  });

  it('name が 40 文字を超える', () => {
    expect(errorOf(parse({ name: 'a'.repeat(41) }))).toBe(
      'name は 40 文字以内にしてください（いまは 41 文字）',
    );
  });

  it('appearance が dark / light 以外', () => {
    expect(errorOf(parse({ name: 'x', appearance: 'dim' }))).toBe(
      'appearance: "dim" は "dark" か "light" のどちらかにしてください',
    );
  });

  it('ui / terminal がオブジェクトでない', () => {
    expect(errorOf(parse({ name: 'x', ui: '#fff' }))).toBe(
      'ui はオブジェクト（{ ... }）で書いてください',
    );
    expect(errorOf(parse({ name: 'x', terminal: ['#fff'] }))).toBe(
      'terminal はオブジェクト（{ ... }）で書いてください',
    );
  });

  it('色が読めないときは、キーの場所と値を示す', () => {
    expect(errorOf(parse({ name: 'x', ui: { accent: '#zz0' } }))).toBe(
      'ui.accent: "#zz0" は色として読めません（#rgb か #rrggbb で書いてください）',
    );
    expect(errorOf(parse({ name: 'x', terminal: { brightRed: 'red' } }))).toMatch(
      /^terminal\.brightRed: "red" は色として読めません/,
    );
  });

  it.each([
    ['#abcd'],
    ['#abcdef0'],
    ['abcdef'],
    ['#ffffff80'],
    ['rgb(1, 2, 3)'],
    [' #ffffff'],
  ])('%s は色として受け付けない', (value) => {
    expect(errorOf(parse({ name: 'x', ui: { bg: value } }))).toContain('は色として読めません');
  });

  it('文字列でない色（数値・null）も受け付けない', () => {
    expect(errorOf(parse({ name: 'x', ui: { bg: 123 } }))).toBe(
      'ui.bg: 123 は色として読めません（#rgb か #rrggbb で書いてください）',
    );
    expect(errorOf(parse({ name: 'x', ui: { bg: null } }))).toBe(
      'ui.bg: null は色として読めません（#rgb か #rrggbb で書いてください）',
    );
  });

  it('配列・オブジェクトの値は型名で示す', () => {
    expect(errorOf(parse({ name: 'x', ui: { accent: ['#fff'] } }))).toBe(
      'ui.accent: 配列 は色として読めません（#rgb か #rrggbb で書いてください）',
    );
    expect(errorOf(parse({ name: { ja: 'x' } }))).toBe('name: オブジェクト は文字列で書いてください');
    expect(errorOf(parse({ name: 'x', appearance: ['dark'] }))).toBe(
      'appearance: 配列 は "dark" か "light" のどちらかにしてください',
    );
  });

  it('深くネストした値（64 KiB 以内）でも投げずにエラーを返す', () => {
    const depth = 30_000;
    const content = `{"name":"x","ui":{"accent":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    expect(content.length).toBeLessThan(64 * 1024);
    const result = parseThemeFile('deep.json', content);
    expect(result).toEqual({
      ok: false,
      fileName: 'deep.json',
      error: 'ui.accent: 配列 は色として読めません（#rgb か #rrggbb で書いてください）',
    });
  });

  it('想定外の例外も投げずに、ファイル単位のエラーにする', () => {
    const spy = vi.spyOn(Array, 'from').mockImplementation(() => {
      throw new RangeError('boom');
    });
    try {
      expect(parseThemeFile('odd.json', JSON.stringify({ name: 'x' }))).toEqual({
        ok: false,
        fileName: 'odd.json',
        error: 'テーマを読み込めませんでした: boom',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parseThemeFile: 背景 (backdrop)', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const SVG_FILES = { 'neon-sunset.svg': SVG };

  function parseWith(json: unknown, svgFiles: Readonly<Record<string, string>> = SVG_FILES) {
    return parseThemeFile('neon.json', JSON.stringify(json), svgFiles);
  }

  it('backdrop.svg を対応表から引き、glass を読む', () => {
    const theme = okTheme(
      parseWith({
        name: 'Neon Sunset',
        appearance: 'dark',
        backdrop: {
          svg: 'neon-sunset.svg',
          glass: { blur: 14, tint: '#1A0F2E', opacity: 0.4 },
        },
        ui: { accent: '#ff4fa3' },
      }),
    );
    expect(theme.backdrop).toEqual({ kind: 'user', fileName: 'neon-sunset.svg', svg: SVG });
    expect(theme.glass).toEqual({ blur: 14, tint: '#1a0f2e', opacity: 0.4 });
    expect(theme.id).toBe('user:neon');
    expect(theme.ui.accent).toBe('#ff4fa3');
  });

  it('SVG の中身は改変しない', () => {
    const raw = '<svg><style>@keyframes a{to{opacity:0}}</style><text>&amp; "x"</text></svg>';
    const theme = okTheme(parseWith({ name: 'x', backdrop: { svg: 'a.svg' } }, { 'a.svg': raw }));
    expect(theme.backdrop).toEqual({ kind: 'user', fileName: 'a.svg', svg: raw });
  });

  it('glass を省略すると blur 14・tint は ui.bg・opacity 0.4', () => {
    const theme = okTheme(
      parseWith({ name: 'x', backdrop: { svg: 'neon-sunset.svg' }, ui: { bg: '#102030' } }),
    );
    expect(theme.glass).toEqual({ blur: 14, tint: '#102030', opacity: 0.4 });
  });

  it('glass はキーごとに省略でき、省略したキーだけ既定値になる', () => {
    const theme = okTheme(
      parseWith({
        name: 'x',
        appearance: 'light',
        backdrop: { svg: 'neon-sunset.svg', glass: { blur: 3 } },
      }),
    );
    expect(theme.glass).toEqual({ blur: 3, tint: RACKER_PAPER.ui.bg, opacity: 0.4 });
  });

  it('glass の範囲の両端（blur 0 / 40、opacity 0 / 1）は受け付ける', () => {
    for (const glass of [
      { blur: 0, opacity: 0 },
      { blur: 40, opacity: 1 },
    ]) {
      const theme = okTheme(parseWith({ name: 'x', backdrop: { svg: 'neon-sunset.svg', glass } }));
      expect(theme.glass).toMatchObject(glass);
    }
  });

  it('backdrop が無ければ backdrop も glass も持たない', () => {
    const theme = okTheme(parseWith({ name: 'x' }));
    expect(theme).not.toHaveProperty('backdrop');
    expect(theme).not.toHaveProperty('glass');
  });

  it('SVG の対応表を渡さなくても、backdrop の無いテーマは従来どおり読める', () => {
    expect(okTheme(parse({ name: 'x' })).ui).toEqual(TOKYO_NIGHT.ui);
  });

  it('SVG が themes フォルダに無い', () => {
    expect(errorOf(parseWith({ name: 'x', backdrop: { svg: 'x.svg' } }))).toBe(
      'backdrop.svg: "x.svg" が themes フォルダにありません',
    );
    // 対応表を渡さなかったときも、無いものとして扱う
    expect(errorOf(parse({ name: 'x', backdrop: { svg: 'neon-sunset.svg' } }))).toBe(
      'backdrop.svg: "neon-sunset.svg" が themes フォルダにありません',
    );
  });

  it('完全に一致する名前が無ければ、大文字小文字を区別せずに探す', () => {
    const theme = okTheme(parseWith({ name: 'x', backdrop: { svg: 'Neon-Sunset.SVG' } }));
    expect(theme.backdrop).toEqual({ kind: 'user', fileName: 'neon-sunset.svg', svg: SVG });
  });

  it('完全に一致する名前があれば、そちらを使う', () => {
    const other = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    const files = { 'neon-sunset.svg': SVG, 'Neon-Sunset.svg': other };
    const theme = okTheme(parseWith({ name: 'x', backdrop: { svg: 'Neon-Sunset.svg' } }, files));
    expect(theme.backdrop).toEqual({ kind: 'user', fileName: 'Neon-Sunset.svg', svg: other });
  });

  it('フォルダにあるが読めなかった SVG は「読めませんでした」と、その SVG のエラーを指す', () => {
    const json = JSON.stringify({ name: 'x', backdrop: { svg: 'broken.SVG' } });
    expect(
      errorOf(parseThemeFile('neon.json', json, {}, { unreadable: new Set(['Broken.svg']) })),
    ).toBe('backdrop.svg: "broken.SVG" を読めませんでした（Broken.svg のエラーを参照）');
  });

  it('ファイル数の上限に達していれば、見つからない理由に上限のことも書く', () => {
    const json = JSON.stringify({ name: 'x', backdrop: { svg: 'x.svg' } });
    expect(errorOf(parseThemeFile('neon.json', json, {}, { truncated: true }))).toBe(
      'backdrop.svg: "x.svg" が themes フォルダにありません' +
        '（ファイルが 100 個を超えると、名前順で後ろのファイルは読みません）',
    );
    // 読めなかった SVG なら、そちらの文を優先する
    expect(
      errorOf(
        parseThemeFile('neon.json', json, {}, { truncated: true, unreadable: new Set(['x.svg']) }),
      ),
    ).toBe('backdrop.svg: "x.svg" を読めませんでした（x.svg のエラーを参照）');
  });

  it('継承したキー（__proto__ など）を SVG として拾わない', () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect(errorOf(parseWith({ name: 'x', backdrop: { svg: name } }))).toBe(
        `backdrop.svg: "${name}" が themes フォルダにありません`,
      );
    }
  });

  it.each([['sub/a.svg'], ['sub\\a.svg'], ['..'], ['../a.svg'], ['C:\\a.svg'], ['/a.svg']])(
    'backdrop.svg にパスの区切り（%s）があればエラー',
    (svg) => {
      expect(errorOf(parseWith({ name: 'x', backdrop: { svg } }, { [svg]: SVG }))).toBe(
        `backdrop.svg: ${JSON.stringify(svg)} にはフォルダを含めず、themes フォルダ内のファイル名だけを書いてください`,
      );
    },
  );

  it('backdrop.svg が無い・文字列でない・空', () => {
    expect(errorOf(parseWith({ name: 'x', backdrop: {} }))).toBe(
      'backdrop.svg がありません。themes フォルダに置いた SVG のファイル名を書いてください',
    );
    expect(errorOf(parseWith({ name: 'x', backdrop: { svg: 1 } }))).toBe(
      'backdrop.svg: 1 は SVG のファイル名（文字列）で書いてください',
    );
    expect(errorOf(parseWith({ name: 'x', backdrop: { svg: ' ' } }))).toBe(
      'backdrop.svg: " " は SVG のファイル名（文字列）で書いてください',
    );
  });

  it('backdrop / glass がオブジェクトでない', () => {
    expect(errorOf(parseWith({ name: 'x', backdrop: 'neon-sunset.svg' }))).toBe(
      'backdrop はオブジェクト（{ ... }）で書いてください',
    );
    expect(errorOf(parseWith({ name: 'x', backdrop: { svg: 'neon-sunset.svg', glass: [1] } }))).toBe(
      'backdrop.glass はオブジェクト（{ ... }）で書いてください',
    );
  });

  it.each([[-1], [40.5], ['14'], [null]])('glass.blur: %s は範囲外としてエラー', (blur) => {
    expect(
      errorOf(parseWith({ name: 'x', backdrop: { svg: 'neon-sunset.svg', glass: { blur } } })),
    ).toBe(`backdrop.glass.blur: ${JSON.stringify(blur)} は 0〜40 の数で書いてください`);
  });

  it.each([[-0.1], [1.01], ['0.4'], [null]])('glass.opacity: %s は範囲外としてエラー', (opacity) => {
    expect(
      errorOf(parseWith({ name: 'x', backdrop: { svg: 'neon-sunset.svg', glass: { opacity } } })),
    ).toBe(`backdrop.glass.opacity: ${JSON.stringify(opacity)} は 0〜1 の数で書いてください`);
  });

  it('glass.tint が色でない', () => {
    expect(
      errorOf(
        parseWith({ name: 'x', backdrop: { svg: 'neon-sunset.svg', glass: { tint: 'navy' } } }),
      ),
    ).toBe(
      'backdrop.glass.tint: "navy" は色として読めません（#rgb か #rrggbb で書いてください）',
    );
  });
});
