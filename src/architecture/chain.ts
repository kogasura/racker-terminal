/**
 * Chain of Responsibility — UI イベントを上へバブリングさせる仕組み。
 *
 * Passive View は「何が起きたか」だけを `emit` で投げる。投げられたイベントは
 * 最も近い `EventScope` のリンク列を順に通り、処理されなければ親のスコープへ、
 * 最終的に Root の Mediator まで昇っていく。DOM のイベントバブリングと同じ形を、
 * アプリケーションの意味を持つイベントに対して作っている。
 *
 * 各リンクは 2 つのうちどちらかを行う:
 *   - `next(event)` を呼ぶ → 自分は関与せず上へ流す
 *   - `next` を呼ばない   → そこでイベントを握り潰す (消費した)
 *
 * リンクがイベントを書き換えて上へ渡すこともできる (`next(別のイベント)`)。
 *
 * View がここに置かれる判断ロジックを持たないことが肝心で、
 * 「押せるかどうか」「今は無視するか」といった裁定はすべてリンクか Mediator 側にある。
 */

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';

/** チェーンを流れるイベントの最低条件。`type` で識別する。 */
export interface ChainEvent {
  readonly type: string;
}

/** イベントを次のリンクへ渡す関数。 */
export type Next<E extends ChainEvent> = (event: E) => void;

/**
 * チェーンの 1 リンク。
 * 上へ流すなら `next(event)` を呼び、ここで消費するなら呼ばない。
 */
export type Link<E extends ChainEvent> = (event: E, next: Next<E>) => void;

/**
 * リンク列を 1 本の `emit` に畳み込む。
 *
 * 先頭のリンクが最初に呼ばれ、`tail` が最後に呼ばれる。`tail` には親スコープの
 * `emit` (最上位なら Mediator への送出) を渡す。
 */
export function composeLinks<E extends ChainEvent>(links: readonly Link<E>[], tail: Next<E>): Next<E> {
  return links.reduceRight<Next<E>>((next, link) => (event) => link(event, next), tail);
}

/**
 * チェーンの終端。どのリンクも処理しなかったイベントがここへ来る。
 *
 * 握り潰さず警告を出すのは、イベント名の打ち間違いや Mediator 側の
 * ハンドラ追加漏れが「何も起きない」という形で静かに埋もれるのを防ぐため。
 */
export function unhandledSink<E extends ChainEvent>(event: E): void {
  console.warn(`[chain] 誰も処理しなかったイベント: ${event.type}`, event);
}

/**
 * 自分の機能宛てのイベントだけを Mediator に渡し、それ以外は上へ流すリンク。
 *
 * 機能ごとの Root はこれをチェーンに挿す。`tail` を指定して終端を乗っ取ると、
 * 他の機能のイベントまで飲み込んでしまい Root を入れ子にできなくなる。
 *
 * イベント名の接頭辞 (`updater/`, `tabs/`) が宛先を表す。
 */
export function mediatorLink<E extends ChainEvent>(prefix: string, send: (event: E) => void): Link<E> {
  return (event, next) => {
    if (event.type.startsWith(prefix)) {
      send(event);
      return; // ここで消費する
    }
    next(event);
  };
}

const EmitContext = createContext<Next<ChainEvent> | null>(null);

export interface EventScopeProps<E extends ChainEvent> {
  /**
   * このスコープで先に通すリンク列。上に書いたものから順に呼ばれる。
   * 再レンダーのたびにチェーンを作り直さないよう、呼び出し側で安定させること
   * (`useMemo` などで固定するか、モジュールスコープの定数にする)。
   */
  links: readonly Link<E>[];
  /**
   * チェーンの終端。最上位のスコープ (Root) でだけ指定する。
   * 省略すると親スコープの `emit` に繋がり、そこへバブリングする。
   */
  tail?: Next<E>;
  children: ReactNode;
}

/**
 * チェーンの 1 段を作るコンポーネント。入れ子にするとバブリングの階層になる。
 *
 * 最上位では `tail` に Mediator への送出を渡す。入れ子側は `tail` を省略して、
 * 処理しなかったイベントを親へ委ねる。
 */
export function EventScope<E extends ChainEvent>({ links, tail, children }: EventScopeProps<E>) {
  const parent = useContext(EmitContext);

  const emit = useMemo(() => {
    // tail の指定がなければ親へ。親も無ければ終端 (未処理の警告) で止める。
    const upstream = (tail ?? parent ?? unhandledSink) as Next<E>;
    return composeLinks(links, upstream);
  }, [links, tail, parent]);

  return createElement(EmitContext.Provider, { value: emit as Next<ChainEvent> }, children);
}

/**
 * Passive View からイベントを投げるための関数を取り出す。
 *
 * 返る関数はチェーンの入口で、View はこれを呼ぶだけでよい。どこで処理されるか、
 * そもそも処理されるのかを View は知らない。
 */
export function useEmit<E extends ChainEvent>(): Next<E> {
  const emit = useContext(EmitContext);
  if (!emit) {
    throw new Error('useEmit は EventScope の内側でしか使えません。');
  }
  return emit as Next<E>;
}
