import { describe, it, expect, vi, afterEach } from 'vitest';
import { advanceBackdropDocument, BACKDROP_MAX_FPS, startBackdropClock } from './backdropClock';

/** Animation の代わり。pause と currentTime だけを持つ。 */
class FakeAnimation {
  playState: AnimationPlayState = 'running';
  currentTime: number | null = 0;
  pause = vi.fn(() => {
    this.playState = 'paused';
  });
}

/** SVGSVGElement の SMIL の時計の代わり。 */
function fakeSvg(seconds = 0) {
  let time = seconds;
  return {
    pauseAnimations: vi.fn(),
    getCurrentTime: () => time,
    setCurrentTime: vi.fn((next: number) => {
      time = next;
    }),
  };
}

/** advanceBackdropDocument が触る分だけを持つ文書。 */
function fakeDoc(animations: FakeAnimation[], svg: object | null = null): Document {
  return {
    getAnimations: () => animations,
    body: { querySelector: (selector: string) => (selector === 'svg' ? svg : null) },
  } as unknown as Document;
}

/** 1 フレームの長さ（fake timers の requestAnimationFrame は 16ms ごと）。 */
const RAF_MS = 16;

function useFakeRaf() {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('advanceBackdropDocument', () => {
  it('動いている CSS アニメーションを pause し、currentTime を dt だけ進める', () => {
    const a = new FakeAnimation();
    a.currentTime = 100;
    const b = new FakeAnimation();
    b.playState = 'paused';
    b.currentTime = 5;

    advanceBackdropDocument(fakeDoc([a, b]), 33);

    expect(a.pause).toHaveBeenCalledTimes(1);
    expect(a.currentTime).toBe(133);
    // 止まっているものは pause し直さない
    expect(b.pause).not.toHaveBeenCalled();
    expect(b.currentTime).toBe(38);
  });

  it('dt が 0 なら止めるだけで進めない', () => {
    const a = new FakeAnimation();
    a.currentTime = 100;
    advanceBackdropDocument(fakeDoc([a]), 0);
    expect(a.pause).toHaveBeenCalled();
    expect(a.currentTime).toBe(100);
  });

  it('取り消し済み (idle) のアニメーションには触らない (pause すると動き出すため)', () => {
    const a = new FakeAnimation();
    a.playState = 'idle';
    a.currentTime = null;
    advanceBackdropDocument(fakeDoc([a]), 33);
    expect(a.pause).not.toHaveBeenCalled();
    expect(a.currentTime).toBeNull();
  });

  it('SMIL はルートの svg を pauseAnimations し、setCurrentTime で秒単位に進める', () => {
    const svg = fakeSvg(2);
    advanceBackdropDocument(fakeDoc([], svg), 500);
    expect(svg.pauseAnimations).toHaveBeenCalled();
    expect(svg.setCurrentTime).toHaveBeenLastCalledWith(2.5);

    advanceBackdropDocument(fakeDoc([], svg), 0);
    expect(svg.setCurrentTime).toHaveBeenCalledTimes(1);
  });

  it('アニメーションが無い (reduced-motion で animation:none) 文書では何もしない', () => {
    expect(() => advanceBackdropDocument(fakeDoc([]), 33)).not.toThrow();
  });

  it('getAnimations や SMIL の口が無い文書でも落ちない', () => {
    const doc = { body: { querySelector: () => ({}) } } as unknown as Document;
    expect(() => advanceBackdropDocument(doc, 33)).not.toThrow();
  });
});

describe('startBackdropClock', () => {
  it(`アニメーションを止め、${BACKDROP_MAX_FPS}fps に間引いて経過時間ぶん進める`, () => {
    useFakeRaf();
    const a = new FakeAnimation();
    const stop = startBackdropClock(() => [fakeDoc([a])]);
    // 動かした時点で止める
    expect(a.pause).toHaveBeenCalled();
    expect(a.currentTime).toBe(0);

    // 最初のフレームで時刻を覚える。次のフレーム (16ms 後) は 1/30 秒に満たないので進めない
    vi.advanceTimersByTime(RAF_MS);
    vi.advanceTimersByTime(RAF_MS);
    expect(a.currentTime).toBe(0);
    // 2 フレーム目 (32ms 後) で、経過した 32ms ぶん進める
    vi.advanceTimersByTime(RAF_MS);
    expect(a.currentTime).toBe(2 * RAF_MS);

    // 1 秒あたり 30 回前後しか進めず、進めた合計は経過時間と同じ
    const setTimes: number[] = [];
    let last = a.currentTime;
    for (let elapsed = 0; elapsed < 1000; elapsed += RAF_MS) {
      vi.advanceTimersByTime(RAF_MS);
      if (a.currentTime !== last) setTimes.push(a.currentTime ?? 0);
      last = a.currentTime;
    }
    expect(setTimes.length).toBeLessThanOrEqual(BACKDROP_MAX_FPS + 1);
    expect(setTimes.length).toBeGreaterThanOrEqual(BACKDROP_MAX_FPS - 1);
    expect((a.currentTime ?? 0) - 2 * RAF_MS).toBeGreaterThanOrEqual(1000 - 2 * RAF_MS);
    expect((a.currentTime ?? 0) - 2 * RAF_MS).toBeLessThanOrEqual(1000 + RAF_MS);
    stop();
  });

  it('後から増えたアニメーションも、進めるたびに拾い直す', () => {
    useFakeRaf();
    const animations: FakeAnimation[] = [];
    const doc = fakeDoc(animations);
    const stop = startBackdropClock(() => [doc]);
    vi.advanceTimersByTime(RAF_MS);

    const late = new FakeAnimation();
    animations.push(late);
    vi.advanceTimersByTime(2 * RAF_MS);

    expect(late.pause).toHaveBeenCalled();
    expect(late.currentTime).toBe(2 * RAF_MS);
    stop();
  });

  it('止めたら進めず、動かし直すと止めた時点の続きから進める', () => {
    useFakeRaf();
    const a = new FakeAnimation();
    const svg = fakeSvg();
    const docs = () => [fakeDoc([a], svg)];
    let stop = startBackdropClock(docs);
    vi.advanceTimersByTime(3 * RAF_MS);
    const pausedAt = a.currentTime ?? 0;
    expect(pausedAt).toBe(2 * RAF_MS);

    stop();
    vi.advanceTimersByTime(5000);
    expect(a.currentTime).toBe(pausedAt);
    expect(svg.getCurrentTime()).toBeCloseTo(pausedAt / 1000);

    // 止めていた 5 秒は飛ばさない
    stop = startBackdropClock(docs);
    vi.advanceTimersByTime(3 * RAF_MS);
    expect(a.currentTime).toBe(pausedAt + 2 * RAF_MS);
    expect(svg.getCurrentTime()).toBeCloseTo((pausedAt + 2 * RAF_MS) / 1000);
    stop();
  });

  it('進める文書は毎回取り直す (iframe の出し入れに追従する)', () => {
    useFakeRaf();
    const getDocuments = vi.fn(() => [] as Document[]);
    const stop = startBackdropClock(getDocuments);
    vi.advanceTimersByTime(3 * RAF_MS);
    // 動かした時点の 1 回 + 進めた 1 回
    expect(getDocuments).toHaveBeenCalledTimes(2);
    stop();
  });
});
