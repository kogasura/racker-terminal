import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { buildBackdropDocument } from '../lib/theme/backdropDocument';
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

  it('iframe は allow-same-origin だけの sandbox で、srcdoc に背景の文書を入れる', () => {
    const { container } = render(<BackdropFrames {...BASE} />);
    const [iframe] = frames(container);

    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toMatch(/allow-scripts/);
    expect(iframe.getAttribute('srcdoc')).toBe(buildBackdropDocument(SVG_A));
    expect(container.querySelector('.backdrop-layer')?.getAttribute('aria-hidden')).toBe('true');
    expect(iframe.tabIndex).toBe(-1);
  });

  it('読み込めたら連動の値を書き込み、表示する (フェードイン)', () => {
    const { container } = render(<BackdropFrames {...BASE} paused context={0.4} agent="working" />);
    const [iframe] = frames(container);
    expect(iframe.classList.contains('backdrop-layer__frame--shown')).toBe(false);

    const doc = load(iframe);

    expect(applyBackdropSignals).toHaveBeenLastCalledWith(doc, {
      paused: true,
      context: 0.4,
      agent: 'working',
    });
    expect(iframe.classList.contains('backdrop-layer__frame--shown')).toBe(true);
  });

  it('止める・連動の値を変えても srcdoc は差し替えず、中の文書に書き込む', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [iframe] = frames(container);
    const doc = load(iframe);
    applyBackdropSignals.mockClear();

    rerender(<BackdropFrames {...BASE} paused />);
    rerender(<BackdropFrames {...BASE} paused context={0.8} />);
    rerender(<BackdropFrames {...BASE} paused context={0.8} agent="blocked" />);

    expect(frames(container)).toEqual([iframe]);
    expect(iframe.getAttribute('srcdoc')).toBe(buildBackdropDocument(SVG_A));
    expect(applyBackdropSignals).toHaveBeenCalledTimes(3);
    expect(applyBackdropSignals).toHaveBeenLastCalledWith(doc, {
      paused: true,
      context: 0.8,
      agent: 'blocked',
    });
  });

  it('テーマを切り替えると新しい srcdoc の iframe を上に重ね、フェードが終わったら古い方を外す', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    const [first] = frames(container);
    load(first);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);

    const [old, next] = frames(container);
    expect(old).toBe(first);
    expect(old.getAttribute('srcdoc')).toBe(buildBackdropDocument(SVG_A));
    expect(next.getAttribute('srcdoc')).toBe(buildBackdropDocument(SVG_B));
    // 新しい方が読み込めるまでは、古い方を見せたまま
    expect(next.classList.contains('backdrop-layer__frame--shown')).toBe(false);

    load(next);
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
    load(frames(container)[0]);

    rerender(<BackdropFrames {...BASE} svg={SVG_B} />);
    rerender(<BackdropFrames {...BASE} svg={SVG_C} />);

    const srcdocs = frames(container).map((f) => f.getAttribute('srcdoc'));
    expect(srcdocs).toEqual([buildBackdropDocument(SVG_A), buildBackdropDocument(SVG_C)]);
  });

  it('背景の無いテーマに切り替えたら何も描かない', () => {
    const { container, rerender } = render(<BackdropFrames {...BASE} />);
    load(frames(container)[0]);

    rerender(<BackdropFrames {...BASE} svg={null} />);

    expect(frames(container)).toEqual([]);
  });
});
