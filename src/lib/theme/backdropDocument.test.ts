import { describe, it, expect, vi } from 'vitest';
import { BUILTIN_SCENES, sceneSvg } from '../backdrop/catalog';
import { applyBackdropSignals, buildBackdropDocument, extractSvgRoot } from './backdropDocument';

const CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `style-src 'unsafe-inline'; img-src data:; font-src data:">`;

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const EMPTY_SVG = `<svg ${NS}></svg>`;

/** srcdoc の文字列から Document を作る（iframe の contentDocument の代わり）。 */
function docOf(svg: string): Document {
  return new DOMParser().parseFromString(buildBackdropDocument(svg), 'text/html');
}

describe('buildBackdropDocument', () => {
  it('CSP の meta と、全面に広げる style・止める指定を head に入れる', () => {
    const html = buildBackdropDocument(EMPTY_SVG);
    expect(html.startsWith('<!doctype html><html><head><meta charset=utf-8>')).toBe(true);
    expect(html).toContain(CSP);
    expect(html).toContain(
      '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent} ' +
        'body>svg{display:block;width:100%;height:100%} ' +
        '.rk-paused *{animation-play-state:paused !important}</style>',
    );
    // CSP は SVG より前に置く（後ろだと SVG の読み込みに効かない）
    expect(html.indexOf(CSP)).toBeLessThan(html.indexOf('<svg'));
  });

  it('整形式の SVG は、ルートの svg 要素をそのまま body に入れる', () => {
    const svg =
      `<svg ${NS} viewBox="0 0 10 10">` +
      `<style>@keyframes a{to{opacity:0}}</style><text>&amp; "x" 'y'</text></svg>`;
    const html = buildBackdropDocument(svg);
    expect(html).toContain(`</head><body>${svg}</body></html>`);
    expect(html.endsWith('</body></html>')).toBe(true);
  });

  it('svg 要素だけが入り、その外側の処理命令・DOCTYPE・コメントは落ちる', () => {
    const root = `<svg ${NS}><rect width="1" height="1"/></svg>`;
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg>' +
      '<?xml-stylesheet href="https://example.com/x.css"?>' +
      '<!-- <link rel="preconnect" href="https://example.com"> -->' +
      root +
      '<!-- <meta http-equiv="refresh" content="0;url=https://example.com"> -->';
    const html = buildBackdropDocument(svg);
    expect(html).toContain(`<body>${root}</body>`);
    expect(html).not.toContain('example.com');
  });

  it('</svg> の後ろに link / meta を続けたものは整形式でないので、何も入れない', () => {
    const svg =
      `<svg ${NS}><rect/></svg>` +
      '<link rel="preconnect" href="https://example.com"/>' +
      '<meta http-equiv="refresh" content="0;url=https://example.com"/>';
    const html = buildBackdropDocument(svg);
    expect(html).toContain('<body></body>');
    expect(html).not.toContain('example.com');
  });

  it.each([
    [
      'ルートが svg でない',
      '<html xmlns="http://www.w3.org/1999/xhtml"><link rel="preconnect" href="https://example.com"/></html>',
    ],
    ['svg の名前空間が無い', '<svg><rect/></svg>'],
    ['XML でない', 'not svg'],
  ])('%s ものは何も入れない', (_label, svg) => {
    const html = buildBackdropDocument(svg);
    expect(html).toContain('<body></body>');
    expect(html).not.toContain('example.com');
  });

  it('組み込みのシーンは 20 件', () => {
    expect(BUILTIN_SCENES).toHaveLength(20);
  });

  it.each(BUILTIN_SCENES.map((scene) => [scene.id] as const))(
    '組み込みのシーン %s は、同じ処理を通しても変わらない',
    (id) => {
      const svg = sceneSvg(id) ?? '';
      expect(svg).not.toBe('');
      expect(extractSvgRoot(svg)).toEqual({ ok: true, svg });
      expect(buildBackdropDocument(svg)).toContain(`<body>${svg}</body>`);
    },
  );
});

describe('extractSvgRoot', () => {
  it('整形式でなければ、パーサーの理由を付けて「SVG として読めません」を返す', () => {
    const result = extractSvgRoot(`<svg ${NS}><rect></svg>`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^SVG として読めません（.+）$/);
    expect(result.error).toContain('line 1');
    // 見出し（This page contains …）は載せない
    expect(result.error).not.toContain('This page contains');
  });

  it('ルートが svg でなければ、ルートの要素名と直し方を返す', () => {
    expect(extractSvgRoot('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toEqual({
      ok: false,
      error:
        'SVG として読めません（ルートの要素が <html> です。' +
        '<svg xmlns="http://www.w3.org/2000/svg"> で始めてください）',
    });
  });

  it('svg でも SVG の名前空間でなければ読めない', () => {
    expect(extractSvgRoot('<svg><rect/></svg>')).toEqual({
      ok: false,
      error:
        'SVG として読めません（ルートの要素が <svg> です。' +
        '<svg xmlns="http://www.w3.org/2000/svg"> で始めてください）',
    });
  });
});

describe('applyBackdropSignals', () => {
  it('止めるときは documentElement に rk-paused を付け、動かすときは外す', () => {
    const doc = docOf(EMPTY_SVG);
    applyBackdropSignals(doc, { paused: true, context: 0, agent: 'idle' });
    expect(doc.documentElement.classList.contains('rk-paused')).toBe(true);
    applyBackdropSignals(doc, { paused: false, context: 0, agent: 'idle' });
    expect(doc.documentElement.classList.contains('rk-paused')).toBe(false);
  });

  it('SMIL のアニメーションも、ルートの svg の pauseAnimations / unpauseAnimations で止める・動かす', () => {
    const doc = docOf(EMPTY_SVG);
    const root = doc.querySelector('svg') as unknown as Record<string, unknown>;
    const pauseAnimations = vi.fn();
    const unpauseAnimations = vi.fn();
    root.pauseAnimations = pauseAnimations;
    root.unpauseAnimations = unpauseAnimations;

    applyBackdropSignals(doc, { paused: true, context: 0, agent: 'idle' });
    expect(pauseAnimations).toHaveBeenCalledTimes(1);
    expect(unpauseAnimations).not.toHaveBeenCalled();

    applyBackdropSignals(doc, { paused: false, context: 0, agent: 'idle' });
    expect(unpauseAnimations).toHaveBeenCalledTimes(1);
    expect(pauseAnimations).toHaveBeenCalledTimes(1);
  });

  it('pauseAnimations が無い環境でも落ちない', () => {
    const doc = docOf(EMPTY_SVG);
    const root = doc.querySelector('svg') as unknown as Record<string, unknown>;
    root.pauseAnimations = undefined;
    root.unpauseAnimations = undefined;

    expect(() =>
      applyBackdropSignals(doc, { paused: true, context: 0, agent: 'idle' }),
    ).not.toThrow();
    expect(doc.documentElement.classList.contains('rk-paused')).toBe(true);
  });

  it('SVG のルートに --rk-context と data-agent を書き込む', () => {
    const doc = docOf(`<svg ${NS} id="root"><g><svg id="inner"></svg></g></svg>`);
    applyBackdropSignals(doc, { paused: false, context: 0.25, agent: 'working' });
    const root = doc.getElementById('root') as unknown as SVGElement;
    expect(root.style.getPropertyValue('--rk-context')).toBe('0.25');
    expect(root.getAttribute('data-agent')).toBe('working');
    // 入れ子の svg には書かない
    expect(doc.getElementById('inner')?.getAttribute('data-agent')).toBeNull();

    applyBackdropSignals(doc, { paused: false, context: 0.5, agent: 'blocked' });
    expect(root.style.getPropertyValue('--rk-context')).toBe('0.5');
    expect(root.getAttribute('data-agent')).toBe('blocked');
  });

  it.each([
    [-0.5, '0'],
    [0, '0'],
    [1, '1'],
    [1.7, '1'],
    [Number.NaN, '0'],
  ])('context %s は 0〜1 に収めて %s を書く', (context, expected) => {
    const doc = docOf(EMPTY_SVG);
    applyBackdropSignals(doc, { paused: false, context, agent: 'idle' });
    const root = doc.querySelector('svg') as unknown as SVGElement;
    expect(root.style.getPropertyValue('--rk-context')).toBe(expected);
  });

  it('SVG が無ければ documentElement に書き込む', () => {
    const doc = docOf('<p>no svg</p>');
    applyBackdropSignals(doc, { paused: false, context: 0.3, agent: 'idle' });
    expect(doc.documentElement.style.getPropertyValue('--rk-context')).toBe('0.3');
    expect(doc.documentElement.getAttribute('data-agent')).toBe('idle');
  });
});
