/**
 * 動く背景のアニメーションを、親の 1 本の時計で間引いて進める。
 *
 * SVG の CSS アニメーションをブラウザに任せると、画面のリフレッシュレートのまま毎フレーム
 * SVG 全体を描き直し、その上ですりガラスのぼかしも計算し直す。dev 版の WebView2 で計ると、
 * Snow Pines（すりガラスあり）で約 6.3 コア、ぼかし無しでも約 2.2 コアを使っていた。
 * 背景の文書のアニメーションを止めておき、親が BACKDROP_MAX_FPS ごとに経過時間ぶん
 * 進めると、30fps で約 1.4 コア、15fps で約 0.7 コアに下がった（ぼかしあり）。
 *
 * - CSS アニメーション: `doc.getAnimations()` を pause し、`currentTime` を進める。
 *   data-agent の変化などで後から増えたものも拾うよう、進めるたびに取り直す。
 * - SMIL（`<animate>` など）: ルートの svg を `pauseAnimations()` し、`setCurrentTime()` で進める。
 * - OS の「アニメーションを減らす」で SVG 側が animation:none にしていれば、アニメーションが
 *   無いので何もしない（止まったまま）。
 *
 * 止める（「背景を動かす」がオフ・最小化中）ときは時計を止めるだけで、アニメーションは
 * 止めた時点のまま残る。時計を動かし直すと、そこから続きを進める。
 *
 * @module theme/backdropClock
 */

/**
 * 背景のアニメーションを進める上限（回/秒）。上の計測で、見た目を損なわずに負荷が十分に
 * 下がる値として 30 にした。
 */
export const BACKDROP_MAX_FPS = 30;

/** 進める間隔（ミリ秒）。 */
const FRAME_INTERVAL_MS = 1000 / BACKDROP_MAX_FPS;

/**
 * requestAnimationFrame の時刻の揺れを吸収する余裕（ミリ秒）。60Hz の 2 フレーム
 * （約 33.3ms）がわずかに短く届いても 3 フレーム目まで待たない（20fps に落ちない）ように。
 */
const FRAME_SLACK_MS = 2;

/** SMIL の時計を操作する口。SVGSVGElement にある。 */
interface SmilClock {
  pauseAnimations(): void;
  getCurrentTime(): number;
  setCurrentTime(seconds: number): void;
}

function hasSmilClock(el: object): el is SmilClock {
  const candidate = el as Partial<SmilClock>;
  return (
    typeof candidate.pauseAnimations === 'function' &&
    typeof candidate.getCurrentTime === 'function' &&
    typeof candidate.setCurrentTime === 'function'
  );
}

/**
 * 背景の文書のアニメーションを止め、dtMs だけ進める。dtMs が 0 なら止めるだけ。
 * @param doc - 背景の iframe の contentDocument
 * @param dtMs - 進める時間（ミリ秒）
 */
export function advanceBackdropDocument(doc: Document, dtMs: number): void {
  advanceCssAnimations(doc, dtMs);
  advanceSmil(doc, dtMs);
}

/** CSS アニメーション（Web Animations）を止め、dtMs だけ進める。 */
function advanceCssAnimations(doc: Document, dtMs: number): void {
  // getAnimations が無い環境（古いブラウザ・テスト）でも落ちないよう、あるときだけ呼ぶ
  const withAnimations = doc as Partial<Pick<Document, 'getAnimations'>>;
  if (typeof withAnimations.getAnimations !== 'function') return;
  for (const animation of withAnimations.getAnimations.call(doc)) {
    // idle（取り消し済み）のものに pause を呼ぶと、また動き出してしまう
    if (animation.playState === 'idle') continue;
    if (animation.playState !== 'paused') animation.pause();
    const current = animation.currentTime;
    if (dtMs > 0 && typeof current === 'number') animation.currentTime = current + dtMs;
  }
}

/** ルートの svg の SMIL の時計を止め、dtMs だけ進める。 */
function advanceSmil(doc: Document, dtMs: number): void {
  const svg = doc.body?.querySelector('svg') ?? null;
  if (svg === null || !hasSmilClock(svg)) return;
  svg.pauseAnimations();
  if (dtMs > 0) svg.setCurrentTime(svg.getCurrentTime() + dtMs / 1000);
}

/**
 * 時計を動かす。動かした時点で文書のアニメーションを止め、以後は requestAnimationFrame で
 * 1/BACKDROP_MAX_FPS 秒ごとに、前回からの経過時間ぶん進める。
 * @param getDocuments - 進める文書。進めるたびに呼ぶ（iframe の出し入れに追従するため）
 * @returns 時計を止める関数。アニメーションは止めた時点のまま残る
 */
export function startBackdropClock(getDocuments: () => Iterable<Document>): () => void {
  let stopped = false;
  let last: number | null = null;
  let handle = 0;
  const advanceAll = (dtMs: number) => {
    for (const doc of getDocuments()) advanceBackdropDocument(doc, dtMs);
  };

  advanceAll(0);
  const frame = (now: number) => {
    if (stopped) return;
    if (last === null) {
      last = now;
    } else if (now - last >= FRAME_INTERVAL_MS - FRAME_SLACK_MS) {
      const dtMs = now - last;
      last = now;
      advanceAll(dtMs);
    }
    handle = requestAnimationFrame(frame);
  };
  handle = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(handle);
  };
}
