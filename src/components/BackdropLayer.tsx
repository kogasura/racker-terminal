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
 *   下の 1 枚はフェードが終わるまで残す（窓は透明なので、両方を薄めると下地が透けるため）。
 * - 背景の無いテーマ（配色だけ）では何も描かない。
 *
 * 描く SVG と止めるか・エージェントの状態は ThemeRoot から、コンテキストの使用率は
 * ステータスバーの Claude の情報から受け取る。ClaudeStatusRoot の内側に置くこと。
 *
 * iframe の中の文書という命令的なリソースを世話するので、Passive View の例外にあたる
 * （src/architecture/README.md）。判断はしない（何を描くか・止めるかは View モデルが決める）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
}

function newFrame(id: number, svg: string): Frame {
  return { id, svg, doc: buildBackdropDocument(svg), loaded: false };
}

/**
 * 次に並べる iframe。描く SVG が変わったときだけ新しい配列を返し、変わらなければ null。
 * 新しい 1 枚は、いま見えている 1 枚（読み込み済みの最後）の上に重ねる。
 * 読み込み中だった 1 枚は捨てる（切り替えを続けて押しても、重ねるのは 2 枚まで）。
 */
function nextFrames(frames: readonly Frame[], svg: string | null): readonly Frame[] | null {
  if (svg === null) return frames.length === 0 ? null : [];
  const top = frames[frames.length - 1];
  if (top?.svg === svg) return null;
  const shown = frames.filter((frame) => frame.loaded).slice(-1);
  return [...shown, newFrame((top?.id ?? 0) + 1, svg)];
}

/** 描く SVG と連動の値から iframe を並べる。テスト用に export する。 */
export function BackdropFrames({ svg, paused, context, agent }: BackdropFramesProps) {
  const [frames, setFrames] = useState<readonly Frame[]>(() =>
    svg === null ? [] : [newFrame(1, svg)],
  );
  // 描く SVG が変わったら、描画中に並びを作り直す (props から導く状態)
  const next = nextFrames(frames, svg);
  if (next !== null) setFrames(next);

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

  // 新しい 1 枚のフェードインが終わったら、下の古い 1 枚を外す
  const top = frames[frames.length - 1];
  const fadeDone = top?.loaded === true && frames.length > 1;
  useEffect(() => {
    if (!fadeDone || top === undefined) return;
    const timer = setTimeout(() => {
      setFrames((current) => current.filter((frame) => frame.id >= top.id));
    }, BACKDROP_FADE_MS);
    return () => clearTimeout(timer);
  }, [fadeDone, top]);

  const handleLoad = useCallback((id: number) => {
    const doc = iframes.current.get(id)?.contentDocument;
    if (doc) applyBackdropSignals(doc, signals.current);
    setFrames((current) =>
      current.map((frame) => (frame.id === id ? { ...frame, loaded: true } : frame)),
    );
  }, []);

  if (frames.length === 0) return null;
  return (
    <div className="backdrop-layer" aria-hidden="true">
      {frames.map((frame) => (
        <iframe
          key={frame.id}
          ref={(el) => {
            if (el) iframes.current.set(frame.id, el);
            else iframes.current.delete(frame.id);
          }}
          className={`backdrop-layer__frame${frame.loaded ? ' backdrop-layer__frame--shown' : ''}`}
          title="背景"
          sandbox="allow-same-origin"
          srcDoc={frame.doc}
          tabIndex={-1}
          onLoad={() => handleLoad(frame.id)}
        />
      ))}
    </div>
  );
}
