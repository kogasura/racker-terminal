/**
 * 窓の動く背景。画面全体の最背面に、背景付きのテーマの SVG を描く。
 *
 * - SVG は `sandbox="allow-same-origin"`（allow-scripts なし）の iframe の srcdoc に入れる。
 *   SVG 内のスクリプトやイベント属性は動かず、文書の CSP の meta で外部からの読み込みも止まる
 *   （buildBackdropDocument）。
 * - 止める・連動の値（コンテキストの使用率・エージェントの状態）は、iframe の中の文書に
 *   直接書き込む（applyBackdropSignals）。srcdoc を差し替えないので、アニメーションが
 *   最初からやり直しにならない。
 * - テーマが変わったら、新しい iframe を上に重ね、読み込めたら 300ms でフェードインする。
 *   下の 1 枚はフェードが終わるまで不透明のまま残す（窓は透明なので、両方を薄めると
 *   下地が透けるため）。フェードの途中で切り替えても、フェードを終えた 1 枚を下地に残す。
 * - 下に表示済みの iframe が無いとき（起動直後・配色だけのテーマからの切り替え）は、
 *   フェードせずに読み込めた時点でそのまま出す（窓の下地から絵が浮き出てくるのを見せない）。
 * - 見えている背景に戻すときは iframe を作り直さない（アニメーションが最初からやり直しに
 *   ならないように）。
 * - 背景の無いテーマ（配色だけ）では何も描かない。
 *
 * 描く SVG と止めるか・エージェントの状態は ThemeRoot から、コンテキストの使用率は
 * ステータスバーの Claude の情報から受け取る。ClaudeStatusRoot の内側に置くこと。
 *
 * iframe の中の文書という命令的なリソースを世話するので、Passive View の例外にあたる
 * （src/architecture/README.md）。判断はしない（何を描くか・止めるかは View モデルが決める）。
 */

import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';
import { useStatusBarView } from '../features/claudeStatus/ClaudeStatusRoot';
import { useBackdropView } from '../features/theme/ThemeRoot';
import { backdropContext } from '../features/theme/viewModel';
import {
  applyBackdropSignals,
  buildBackdropDocument,
  type BackdropAgent,
} from '../lib/theme/backdropDocument';

/** テーマを切り替えたときのクロスフェードの長さ（title-bar.css の transition と揃える）。 */
export const BACKDROP_FADE_MS = 300;

/** 窓の背景。App の最背面に置く。 */
export function BackdropLayer() {
  const { svg, paused, agent } = useBackdropView();
  const { meta } = useStatusBarView();
  return <BackdropFrames svg={svg} paused={paused} context={backdropContext(meta)} agent={agent} />;
}

export interface BackdropFramesProps {
  /** 描く SVG。null なら何も描かない */
  readonly svg: string | null;
  /** アニメーションを止めるか */
  readonly paused: boolean;
  /** アクティブなタブのコンテキストの使用率（0〜1） */
  readonly context: number;
  /** アクティブなタブのエージェントの状態 */
  readonly agent: BackdropAgent;
}

/** iframe 1 枚ぶん。 */
interface Frame {
  readonly id: number;
  readonly svg: string;
  /** srcdoc。作ったら変えない */
  readonly doc: string;
  /** 読み込めたか。読み込めたらフェードインする */
  readonly loaded: boolean;
  /** フェードインが終わったか（不透明になったか）。下地に残すのはこれが立った 1 枚 */
  readonly settled: boolean;
  /**
   * フェードせずに出すか。作ったときに下に表示済みの iframe が無かった 1 枚
   * （起動直後・配色だけのテーマからの切り替え）。読み込めたらすぐ不透明にする
   */
  readonly instant: boolean;
}

function newFrame(id: number, svg: string, instant: boolean): Frame {
  return { id, svg, doc: buildBackdropDocument(svg), loaded: false, settled: false, instant };
}

/** 並んでいる iframe と、最後に振った id。 */
interface FrameStack {
  readonly frames: readonly Frame[];
  /**
   * 最後に振った id。切り詰めて外した iframe の id を使い回さないために持つ
   * (外した 1 枚のフェードのタイマーが、新しい 1 枚に効いてしまうため)
   */
  readonly lastId: number;
}

function initialStack(svg: string | null): FrameStack {
  return svg === null
    ? { frames: [], lastId: 0 }
    : { frames: [newFrame(1, svg, true)], lastId: 1 };
}

/** 条件に合う最後の 1 枚の位置。無ければ -1。 */
function lastIndexOf(frames: readonly Frame[], match: (frame: Frame) => boolean): number {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (match(frames[i])) return i;
  }
  return -1;
}

/**
 * 次に並べる iframe。描く SVG が変わったときだけ新しい配列を返し、変わらなければ null。
 *
 * - 描きたい SVG の読み込み済みの 1 枚がもう並んでいれば、作り直さずにそこまで切り詰める
 *   （見えている背景に戻すとき。アニメーションを続きから見せる）。
 * - そうでなければ、新しい 1 枚を下地の上に重ねる。下地はフェードを終えた最後の 1 枚。
 *   まだ 1 枚もフェードを終えていなければ、フェード中のもの（読み込み済み）を残す。
 *   読み込み中だった 1 枚は捨てる（切り替えを続けて押しても、重なりすぎないように）。
 *   下地が 1 枚も無ければ、新しい 1 枚はフェードせずに出す。
 */
function nextFrames(stack: FrameStack, svg: string | null): FrameStack | null {
  const { frames, lastId } = stack;
  if (svg === null) return frames.length === 0 ? null : { frames: [], lastId };
  const top = frames[frames.length - 1];
  if (top?.svg === svg) return null;
  const reuse = lastIndexOf(frames, (frame) => frame.loaded && frame.svg === svg);
  if (reuse >= 0) return { frames: frames.slice(0, reuse + 1), lastId };
  const settled = lastIndexOf(frames, (frame) => frame.settled);
  const base = settled >= 0 ? [frames[settled]] : frames.filter((frame) => frame.loaded);
  return { frames: [...base, newFrame(lastId + 1, svg, base.length === 0)], lastId: lastId + 1 };
}

/**
 * フェードを終えた 1 枚に印を付け、その下の (もう見えない) iframe を外す。
 * 該当する 1 枚が無ければ (フェード中に外された) 何もしない。
 */
function settleFrame(stack: FrameStack, id: number): FrameStack {
  const index = stack.frames.findIndex((frame) => frame.id === id);
  if (index < 0) return stack;
  const frames = stack.frames
    .slice(index)
    .map((frame) => (frame.id === id ? { ...frame, settled: true } : frame));
  return { ...stack, frames };
}

/** 読み込めた 1 枚に印を付ける。フェードせずに出す 1 枚は、そのままフェードも終えた扱いにする。 */
function loadFrame(stack: FrameStack, id: number): FrameStack {
  const frames = stack.frames.map((frame) =>
    frame.id === id ? { ...frame, loaded: true, settled: frame.settled || frame.instant } : frame,
  );
  return { ...stack, frames };
}

function frameClassName(frame: Frame): string {
  let name = 'backdrop-layer__frame';
  if (frame.instant) name += ' backdrop-layer__frame--instant';
  if (frame.loaded) name += ' backdrop-layer__frame--shown';
  return name;
}

/** 描く SVG と連動の値から iframe を並べる。テスト用に export する。 */
export function BackdropFrames({ svg, paused, context, agent }: BackdropFramesProps) {
  const [stack, setStack] = useState<FrameStack>(() => initialStack(svg));
  // 描く SVG が変わったら、描画中に並びを作り直す (props から導く状態)
  const next = nextFrames(stack, svg);
  if (next !== null) setStack(next);
  const { frames } = stack;

  const iframes = useRef(new Map<number, HTMLIFrameElement>());
  const signals = useRef({ paused, context, agent });

  // 止める・連動の値が変わったら、いま並んでいる全部の文書に書き込む (srcdoc は触らない)
  useEffect(() => {
    signals.current = { paused, context, agent };
    for (const iframe of iframes.current.values()) {
      const doc = iframe.contentDocument;
      if (doc) applyBackdropSignals(doc, signals.current);
    }
  }, [paused, context, agent]);

  // フェードインの終わりを待つタイマー (iframe ごと)。外されていても、終わったら何もしない
  const fadeTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = fadeTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const handleLoad = useCallback((id: number, instant: boolean) => {
    const doc = iframes.current.get(id)?.contentDocument;
    if (doc) applyBackdropSignals(doc, signals.current);
    setStack((current) => loadFrame(current, id));
    // フェードしない 1 枚は、下に外す iframe も無いので待たない
    if (instant) return;
    // フェードインが終わったら不透明になったと印を付け、下の古い iframe を外す
    if (fadeTimers.current.has(id)) return;
    fadeTimers.current.set(
      id,
      setTimeout(() => {
        fadeTimers.current.delete(id);
        setStack((current) => settleFrame(current, id));
      }, BACKDROP_FADE_MS),
    );
  }, []);

  // iframe の ref は id ごとに 1 つ覚えておく。描画のたびに作り直すと、React が古い ref を
  // null で、新しい ref を要素で呼び直すため
  const refCallbacks = useRef(new Map<number, RefCallback<HTMLIFrameElement>>());
  const iframeRef = useCallback((id: number): RefCallback<HTMLIFrameElement> => {
    const cached = refCallbacks.current.get(id);
    if (cached) return cached;
    const callback: RefCallback<HTMLIFrameElement> = (el) => {
      if (el) {
        iframes.current.set(id, el);
      } else {
        iframes.current.delete(id);
        if (refCallbacks.current.get(id) === callback) refCallbacks.current.delete(id);
      }
    };
    refCallbacks.current.set(id, callback);
    return callback;
  }, []);

  if (frames.length === 0) return null;
  return (
    <div className="backdrop-layer" aria-hidden="true">
      {frames.map((frame) => (
        <iframe
          key={frame.id}
          ref={iframeRef(frame.id)}
          className={frameClassName(frame)}
          title="背景"
          sandbox="allow-same-origin"
          srcDoc={frame.doc}
          tabIndex={-1}
          onLoad={() => handleLoad(frame.id, frame.instant)}
        />
      ))}
    </div>
  );
}
