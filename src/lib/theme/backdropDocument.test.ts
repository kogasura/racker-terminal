import { describe, it, expect, vi } from 'vitest';
import { BUILTIN_SCENES, sceneSvg } from '../backdrop/catalog';
import {
  applyBackdropSignals,
  BACKDROP_DOCUMENT,
  extractSvgRoot,
  mountBackdropSvg,
} from './backdropDocument';

const CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `style-src 'unsafe-inline'; img-src data:; font-src data:">`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const NS = `xmlns="${SVG_NS}"`;
const EMPTY_SVG = `<svg ${NS}></svg>`;

/** iframe の文書の代わり。srcdoc を HTML として読み、SVG を取り込む（BackdropLayer と同じ手順）。 */
function docOf(svg: string): Document {
  const doc = new DOMParser().parseFromString(BACKDROP_DOCUMENT, 'text/html');
  mountBackdropSvg(doc, svg);
  return doc;
}

/** 文書の中の、HTML の名前空間の要素の名前（html / head / body と head の中身を除く）。 */
function htmlElementsInBody(doc: Document): string[] {
  return Array.from(doc.body.getElementsByTagName('*'))
    .filter((el) => el.namespaceURI === XHTML_NS)
    .map((el) => el.localName);
}

/** 文書全体にある、HTML の名前空間の link / meta 要素の数（head の CSP の meta は除く）。 */
function htmlLinksAndMetas(doc: Document): number {
  return Array.from(doc.getElementsByTagName('*')).filter(
    (el) =>
      el.namespaceURI === XHTML_NS &&
      (el.localName === 'link' || (el.localName === 'meta' && el.parentElement !== doc.head)),
  ).length;
}

describe('BACKDROP_DOCUMENT', () => {
  it('CSP の meta と、全面に広げる style・止める指定を head に持ち、body は空', () => {
    expect(BACKDROP_DOCUMENT.startsWith('<!doctype html><html><head><meta charset=utf-8>')).toBe(
      true,
    );
    expect(BACKDROP_DOCUMENT).toContain(CSP);
    expect(BACKDROP_DOCUMENT).toContain(
      '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent} ' +
        'body>svg{display:block;width:100%;height:100%} ' +
        '.rk-paused *{animation-play-state:paused !important}</style>',
    );
    expect(BACKDROP_DOCUMENT.endsWith('</head><body></body></html>')).toBe(true);
    // SVG を文字列として HTML に入れない
    expect(BACKDROP_DOCUMENT).not.toContain('<svg');
  });
});

describe('extractSvgRoot', () => {
  it('整形式の SVG は、ルートの svg 要素をそのまま返す', () => {
    const svg =
      `<svg ${NS} viewBox="0 0 10 10">` +
      `<style>@keyframes a{to{opacity:0}}</style><text>&amp; "x" 'y'</text></svg>`;
    expect(extractSvgRoot(svg)).toEqual({ ok: true, svg });
  });

  it('svg 要素だけを返し、その外側の処理命令・DOCTYPE・コメントは落ちる', () => {
    const root = `<svg ${NS}><rect width="1" height="1"/></svg>`;
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg>' +
      '<?xml-stylesheet href="https://example.com/x.css"?>' +
      '<!-- <link rel="preconnect" href="https://example.com"> -->' +
      root +
      '<!-- <meta http-equiv="refresh" content="0;url=https://example.com"> -->';
    expect(extractSvgRoot(svg)).toEqual({ ok: true, svg: root });
  });

  it('中の foreignObject・SVG でない要素・処理命令を取り除く', () => {
    const svg =
      `<svg ${NS}><rect id="keep"/>` +
      `<foreignObject><link xmlns="${XHTML_NS}" rel="preconnect" href="https://example.com/"/></foreignObject>` +
      `<h:div xmlns:h="${XHTML_NS}"><h:link rel="preconnect" href="https://example.com/"/></h:div>` +
      '<?pi data?><g><?x-y a="1"?><circle r="1"/></g></svg>';
    expect(extractSvgRoot(svg)).toEqual({
      ok: true,
      svg: `<svg ${NS}><rect id="keep"/><g><circle r="1"/></g></svg>`,
    });
  });

  it('</svg> の後ろに link / meta を続けたものは整形式でないので読めない', () => {
    const svg =
      `<svg ${NS}><rect/></svg>` +
      '<link rel="preconnect" href="https://example.com"/>' +
      '<meta http-equiv="refresh" content="0;url=https://example.com"/>';
    const result = extractSvgRoot(svg);
    expect(result.ok).toBe(false);
  });

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
    expect(extractSvgRoot(`<html xmlns="${XHTML_NS}"/>`)).toEqual({
      ok: false,
      error:
        'SVG として読めません（ルートの要素が <html> です。' +
        '<svg xmlns="http://www.w3.org/2000/svg"> で始めてください）',
    });
  });

  it('パーサーが投げても例外にせず「SVG として読めません」を返す', () => {
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(extractSvgRoot(EMPTY_SVG)).toEqual({ ok: false, error: 'SVG として読めません（boom）' });
    } finally {
      spy.mockRestore();
    }
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

describe('mountBackdropSvg', () => {
  it('SVG を XML として読んだ要素のまま body に取り込む', () => {
    const doc = docOf(`<svg ${NS}><rect id="a" width="1" height="1"/></svg>`);
    const svg = doc.body.firstElementChild;
    expect(svg?.namespaceURI).toBe(SVG_NS);
    expect(svg?.localName).toBe('svg');
    expect(doc.getElementById('a')?.namespaceURI).toBe(SVG_NS);
    expect(doc.body.childNodes).toHaveLength(1);
  });

  it('取り込み直すと body の中身を入れ替える', () => {
    const doc = docOf(`<svg ${NS}><rect id="a"/></svg>`);
    expect(mountBackdropSvg(doc, `<svg ${NS}><rect id="b"/></svg>`)).toBe(true);
    expect(doc.getElementById('a')).toBeNull();
    expect(doc.getElementById('b')).not.toBeNull();
    expect(doc.body.childNodes).toHaveLength(1);
  });

  it.each([
    ['整形式でない', `<svg ${NS}><rect></svg>`],
    ['ルートが svg でない', `<html xmlns="${XHTML_NS}"><link rel="preconnect" href="https://example.com"/></html>`],
    ['svg の名前空間が無い', '<svg><rect/></svg>'],
    ['XML でない', 'not svg'],
    [
      '</svg> の後ろに link を続けた',
      `<svg ${NS}><rect/></svg><link rel="preconnect" href="https://example.com"/>`,
    ],
  ])('%s ものは取り込まず、body を空にして false を返す', (_label, svg) => {
    const doc = docOf(`<svg ${NS}><rect id="before"/></svg>`);
    expect(mountBackdropSvg(doc, svg)).toBe(false);
    expect(doc.body.childNodes).toHaveLength(0);
    expect(htmlLinksAndMetas(doc)).toBe(0);
  });

  // HTML として読み直すと、XML と HTML の読み方の違いで HTML の要素が作れてしまう例
  it.each([
    [
      'SVG の中の <div/> (HTML では SVG から抜け出す)',
      `<svg ${NS}><div/><link rel="preconnect" href="https://example.com/"/></svg>`,
    ],
    [
      'foreignObject の中の XHTML',
      `<svg ${NS}><foreignObject><link xmlns="${XHTML_NS}" rel="preconnect" href="https://example.com/"/>` +
        `<meta xmlns="${XHTML_NS}" http-equiv="refresh" content="0;url=https://example.com/"/></foreignObject></svg>`,
    ],
    [
      'XHTML の名前空間の要素',
      `<svg ${NS}><h:link xmlns:h="${XHTML_NS}" rel="preconnect" href="https://example.com/"/></svg>`,
    ],
  ])('%s を入れても、HTML の link / meta 要素は 1 つもできない', (_label, svg) => {
    const doc = docOf(svg);
    expect(doc.body.firstElementChild?.localName).toBe('svg');
    expect(htmlLinksAndMetas(doc)).toBe(0);
    expect(htmlElementsInBody(doc)).toEqual([]);
    expect(doc.getElementsByTagName('foreignObject')).toHaveLength(0);
  });

  // XML としては正しい形だが、happy-dom の XML パーサーは処理命令の中の > を読めずに
  // エラーにする（Edge は読める）。どちらでも HTML の要素ができないことを見る。
  // 処理命令そのものを取り除くことは extractSvgRoot のテストで見ている。
  it('処理命令の中の HTML (HTML では最初の > で終わる) を入れても、HTML の link / meta 要素は 1 つもできない', () => {
    const doc = docOf(
      `<svg ${NS}><?x a><div></div><link rel="preconnect" href="https://example.com/"/>?></svg>`,
    );
    expect(htmlLinksAndMetas(doc)).toBe(0);
    expect(htmlElementsInBody(doc)).toEqual([]);
    expect(doc.body.innerHTML).not.toContain('example.com');
  });

  it('組み込みのシーンは 20 件', () => {
    expect(BUILTIN_SCENES).toHaveLength(20);
  });

  it.each(BUILTIN_SCENES.map((scene) => [scene.id] as const))(
    '組み込みのシーン %s は、取り込んだ結果が元の SVG と同じ',
    (id) => {
      const svg = sceneSvg(id) ?? '';
      expect(svg).not.toBe('');
      expect(extractSvgRoot(svg)).toEqual({ ok: true, svg });
      const doc = docOf(svg);
      expect(doc.body.childNodes).toHaveLength(1);
      expect(new XMLSerializer().serializeToString(doc.body.firstChild as Node)).toBe(svg);
    },
  );
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
