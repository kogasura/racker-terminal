import { describe, it, expect } from 'vitest';
import { applyBackdropSignals, buildBackdropDocument } from './backdropDocument';

const CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `style-src 'unsafe-inline'; img-src data:; font-src data:">`;

/** srcdoc の文字列から Document を作る（iframe の contentDocument の代わり）。 */
function docOf(svg: string): Document {
  return new DOMParser().parseFromString(buildBackdropDocument(svg), 'text/html');
}

describe('buildBackdropDocument', () => {
  it('CSP の meta と、全面に広げる style・止める指定を head に入れる', () => {
    const html = buildBackdropDocument('<svg></svg>');
    expect(html.startsWith('<!doctype html><html><head><meta charset=utf-8>')).toBe(true);
    expect(html).toContain(CSP);
    expect(html).toContain(
      '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent} ' +
        'body>svg{display:block;width:100%;height:100%} ' +
        '.rk-paused *{animation-play-state:paused !important}</style>',
    );
    // CSP は SVG より前に置く（後ろだと SVG の読み込みに効かない）
    expect(html.indexOf(CSP)).toBeLessThan(html.indexOf('<svg>'));
  });

  it('SVG を改変せずに body にそのまま入れる', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<style>@keyframes a{to{opacity:0}}</style><text>&amp; "x" \'y\'</text></svg>';
    const html = buildBackdropDocument(svg);
    expect(html).toContain(`</head><body>${svg}</body></html>`);
    expect(html.endsWith('</body></html>')).toBe(true);
  });
});

describe('applyBackdropSignals', () => {
  it('止めるときは documentElement に rk-paused を付け、動かすときは外す', () => {
    const doc = docOf('<svg></svg>');
    applyBackdropSignals(doc, { paused: true, context: 0, agent: 'idle' });
    expect(doc.documentElement.classList.contains('rk-paused')).toBe(true);
    applyBackdropSignals(doc, { paused: false, context: 0, agent: 'idle' });
    expect(doc.documentElement.classList.contains('rk-paused')).toBe(false);
  });

  it('SVG のルートに --rk-context と data-agent を書き込む', () => {
    const doc = docOf('<svg id="root"><g><svg id="inner"></svg></g></svg>');
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
    const doc = docOf('<svg></svg>');
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
