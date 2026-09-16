import { describe, it, expect, vi } from 'vitest';
import { composeLinks, type Link } from './chain';

interface TestEvent {
  readonly type: string;
  readonly n?: number;
}

describe('composeLinks', () => {
  it('先頭から順に呼ばれ、最後に終端へ届く', () => {
    const order: string[] = [];
    const a: Link<TestEvent> = (e, next) => {
      order.push('a');
      next(e);
    };
    const b: Link<TestEvent> = (e, next) => {
      order.push('b');
      next(e);
    };
    const tail = vi.fn(() => order.push('tail'));

    composeLinks([a, b], tail)({ type: 'x' });

    expect(order).toEqual(['a', 'b', 'tail']);
    expect(tail).toHaveBeenCalledOnce();
  });

  it('next を呼ばないリンクがイベントを消費する', () => {
    const consume: Link<TestEvent> = () => {};
    const tail = vi.fn();

    composeLinks([consume], tail)({ type: 'x' });

    expect(tail).not.toHaveBeenCalled();
  });

  it('リンクはイベントを差し替えて上へ流せる', () => {
    const bump: Link<TestEvent> = (e, next) => next({ ...e, n: (e.n ?? 0) + 1 });
    const tail = vi.fn();

    composeLinks([bump, bump], tail)({ type: 'x', n: 0 });

    expect(tail).toHaveBeenCalledWith({ type: 'x', n: 2 });
  });

  it('リンクが無ければそのまま終端へ抜ける', () => {
    const tail = vi.fn();
    composeLinks([], tail)({ type: 'x' });
    expect(tail).toHaveBeenCalledWith({ type: 'x' });
  });
});
