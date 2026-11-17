import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { BACKDROP_DOCUMENT } from '../lib/theme/backdropDocument';
import { BACKDROP_FADE_MS, BackdropFrames, type BackdropFramesProps } from './BackdropLayer';

// 中の文書への書き込みは backdropDocument.test.ts が見ている。ここでは「いつ・何を渡すか」を見る。
const applyBackdropSignals = vi.hoisted(() => vi.fn());
vi.mock('../lib/theme/backdropDocument', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/theme/backdropDocument')>()),
  applyBackdropSignals,
}));

const SVG_A = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/></svg>';
const SVG_B = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="b"/></svg>';

const BASE: BackdropFramesProps = { svg: SVG_A, paused: false, context: 0, agent: 'idle' };

function frames(container: HTMLElement): HTMLIFrameElement[] {
  return Array.from(container.querySelectorAll('iframe'));
}

/** 文書に取り込まれた SVG（rect の id で見分ける）。取り込まれていなければ null。 */
function mountedId(doc: Document): string | null {
  return doc.body.querySelector('svg > rect')?.getAttribute('id') ?? null;
}

/** iframe の中の文書を差し替えて、読み込み完了を起こす。 */
function load(iframe: HTMLIFrameElement): Document {
  const doc = document.implementation.createHTMLDocument('backdrop');
  Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => doc });
  fireEvent.load(iframe);
  return doc;
}

beforeEach(() => {
  applyBackdropSignals.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BackdropFrames', () => {
  it('背景の無いテーマ (svg が null) では何も描かない', () => {
    const { container } = render(<BackdropFrames {...BASE} svg={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('iframe は allow-same-origin だけの sandbox で、srcdoc は SVG を含まない空の文書', () => {
    const { container } = render(<BackdropFrames {...BASE} />);
    const [iframe] = frames(container);

    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toMatch(/allow-scripts/);
    expect(iframe.getAttribute('srcdoc')).toBe(BACKDROP_DOCUMENT);
    expect(iframe.getAttribute('srcdoc')).not.toContain('<svg');
    expect(container.querySelector('.backdrop-layer')?.getAttribute('aria-hidden')).toBe('true');
    expect(iframe.tabIndex).toBe(-1);
  });

  it('読み込めたら連動の値を書き込み、表示する (フェードイン)', () => {
    const { container } = render(<BackdropFrames {...BASE} paused context={0.4} agent="working" />);
    const [iframe] = frames(container);
    expect(iframe.classList.contains('backdrop-layer__frame--shown')).toBe(false);
    // 連動の値を書き込む時点で、SVG はもう取り込まれている (書き込む先が SVG のルート)
    let mountedWhenSignaled: string | null = null;
    applyBackdropSignals.mockImplementation((d: Document) => {
      mountedWhenSignaled = mountedId(d);
    });

    const doc = load(iframe);

    expect(mountedId(doc)).toBe('a');
    expect(mountedWhenSignaled).toBe('a');
    expect(applyBackdropSignals).toHaveBeenLastCalledWith(doc, {
      paused: true,
      context: 0.4,
      agent: 'working',
    });
    expect(iframe.classList.contains('backdrop-layer__frame--shown')).toBe(true);
  });

  it('止める・連動の値を変えても SVG は取り込み直さず、中の文書に書き込む', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [iframe] = frames(container);
    const doc = load(iframe);
    const svgElement = doc.body.firstChild;
    applyBackdropSignals.mockClear();

    rerender(<BackdropFrames {...BASE} paused />);
    rerender(<BackdropFrames {...BASE} paused context={0.8} />);
    rerender(<BackdropFrames {...BASE} paused context={0.8} agent="blocked" />);

    expect(frames(container)).toEqual([iframe]);
    expect(doc.body.firstChild).toBe(svgElement);
    expect(applyBackdropSignals).toHaveBeenCalledTimes(3);
    expect(applyBackdropSignals).toHaveBeenLastCalledWith(doc, {
      paused: true,
      context: 0.8,
      agent: 'blocked',
    });
  });

  it('テーマを切り替えると新しい iframe を上に重ね、新しい SVG を取り込み、フェードが終わったら古い方を外す', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [first] = frames(container);
    const firstDoc = load(first);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);

    const [old, next] = frames(container);
    expect(old).toBe(first);
    expect(mountedId(firstDoc)).toBe('a');
    // 新しい方が読み込めるまでは、古い方を見せたまま
    expect(next.classList.contains('backdrop-layer__frame--shown')).toBe(false);

    expect(mountedId(load(next))).toBe('b');
    expect(next.classList.contains('backdrop-layer__frame--shown')).toBe(true);
    expect(frames(container)).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });
    expect(frames(container)).toEqual([next]);
  });

  it('切り替えを続けても重ねるのは 2 枚まで (読み込み中だった 1 枚は捨てる)', () => {
    const SVG_C = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="c"/></svg>';
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [first] = frames(container);
    load(first);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);
    rerender(<BackdropFrames {...BASE} svg={SVG_C} />);

    const [base, top] = frames(container);
    expect(frames(container)).toHaveLength(2);
    expect(base).toBe(first);
    expect(mountedId(load(top))).toBe('c');
  });

  it('フェード中に切り替えても、フェードを終えた不透明な下地が残る', () => {
    vi.useFakeTimers();
    const SVG_C = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="c"/></svg>';
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [first] = frames(container);
    load(first);
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });

    // B が読み込めてフェードしている途中で C へ切り替える
    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);
    load(frames(container)[1]);
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS / 2);
    });
    rerender(<BackdropFrames {...BASE} svg={SVG_C} />);

    const [base, top] = frames(container);
    expect(frames(container)).toHaveLength(2);
    expect(base).toBe(first);
    expect(base.classList.contains('backdrop-layer__frame--shown')).toBe(true);

    // 外した B のフェードが終わる時刻を過ぎても、読み込み中の C の下の A は外さない
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });
    expect(frames(container)).toEqual([first, top]);

    expect(mountedId(load(top))).toBe('c');
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });
    expect(frames(container)).toEqual([top]);
  });

  it('見えている背景に戻すと、iframe を作り直さない', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [first] = frames(container);
    load(first);
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });

    // 読み込み中の B から戻す
    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);
    rerender(<BackdropFrames {...BASE} svg={SVG_A} />);
    expect(frames(container)).toEqual([first]);

    // フェード中の B から戻す
    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);
    load(frames(container)[1]);
    rerender(<BackdropFrames {...BASE} svg={SVG_A} />);
    expect(frames(container)).toEqual([first]);
    expect(first.classList.contains('backdrop-layer__frame--shown')).toBe(true);

    // 外した B のフェードのタイマーが来ても、A はそのまま
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });
    expect(frames(container)).toEqual([first]);
  });

  it('起動直後の 1 枚はフェードせず、読み込めた時点で不透明の下地になる', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [first] = frames(container);
    expect(first.classList.contains('backdrop-layer__frame--instant')).toBe(true);
    expect(first.classList.contains('backdrop-layer__frame--shown')).toBe(false);

    load(first);
    expect(first.classList.contains('backdrop-layer__frame--shown')).toBe(true);

    // フェードの時間を待たずに切り替えても、最初の 1 枚が下地に残り、新しい 1 枚はフェードする
    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);
    const [base, next] = frames(container);
    expect(base).toBe(first);
    expect(next.classList.contains('backdrop-layer__frame--instant')).toBe(false);
    load(next);
    act(() => {
      vi.advanceTimersByTime(BACKDROP_FADE_MS);
    });
    expect(frames(container)).toEqual([next]);
  });

  it('配色だけのテーマから背景付きに切り替えたときはフェードしない', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} svg={null} />);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);

    const [iframe] = frames(container);
    expect(iframe.classList.contains('backdrop-layer__frame--instant')).toBe(true);
    load(iframe);
    expect(iframe.classList.contains('backdrop-layer__frame--shown')).toBe(true);
  });

  it('読み込み中の 1 枚しか無いうちに切り替えても、新しい 1 枚はフェードしない', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} />);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);

    const [iframe] = frames(container);
    expect(frames(container)).toHaveLength(1);
    expect(iframe.classList.contains('backdrop-layer__frame--instant')).toBe(true);
    expect(mountedId(load(iframe))).toBe('b');
  });

  it('背景どうしの切り替えはフェードする', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    load(frames(container)[0]);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);

    const next = frames(container)[1];
    expect(next.classList.contains('backdrop-layer__frame--instant')).toBe(false);
  });

  it('読めない SVG は取り込まない (iframe の body は空のまま)', () => {
    const { container } = render(
      <BackdropFrames {...BASE} svg={'<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>'} />,
    );
    const doc = load(frames(container)[0]);
    expect(doc.body.childNodes).toHaveLength(0);
  });

  it('背景の無いテーマに切り替えたら何も描かない', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    load(frames(container)[0]);

    rerender(<BackdropFrames {...BASE} svg={null} />);

    expect(frames(container)).toEqual([]);
  });
});
