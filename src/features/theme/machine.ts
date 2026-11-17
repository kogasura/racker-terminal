/**
 * theme の Mediator 本体 — ユーザーのテーマファイルの読み込み状況。
 *
 * ```
 *   idle ──reload-requested──> loading ──loaded──> loaded
 *                               ^   |                 |
 *                               |   +─(読み込み中に   |
 *                               |      再読み込み)    |
 *                               +──reload-requested───+
 * ```
 *
 * - `idle` は起動直後の「まだ一度も読みに行っていない」状態。Root が起動時に
 *   `reload-requested` を流して `loading` へ進める。
 * - 読み込み中に `reload-requested` が来たら、いま走っている読み込みが始まった後に
 *   ファイルが書き換えられた可能性がある。捨てずに覚えておき、結果が返ったらもう一度読む。
 * - 再読み込みの間も前回の結果は持ち続ける。選択中の自作テーマが一瞬消えて
 *   Tokyo Night に戻る、というちらつきを起こさないため。
 *
 * フォルダを開く / Claude で作るは状態を持たない副作用なので、状態は動かさず
 * 副作用だけを出す。
 */

import type { Step, TransitionFn } from '../../architecture/machine';
import type { ThemeDefinition } from '../../lib/theme/types';
import type { ThemeEvent, ThemeFileError } from './events';

export type ThemeState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'loading';
      /** 前回読み込んだ結果（初回は空）。読み込みが終わるまではこれを使う */
      readonly themes: readonly ThemeDefinition[];
      readonly errors: readonly ThemeFileError[];
      /** 読み込み中に再読み込みを頼まれたか。true なら結果が返ったあともう一度読む */
      readonly reloadQueued: boolean;
    }
  | {
      readonly status: 'loaded';
      readonly themes: readonly ThemeDefinition[];
      readonly errors: readonly ThemeFileError[];
    };

/** Mediator が「やってほしい」と言う副作用。実行は effects.ts の担当。 */
export type ThemeEffect =
  | { readonly kind: 'load' }
  | { readonly kind: 'open-folder' }
  | { readonly kind: 'create-with-claude' };

export const initialState: ThemeState = { status: 'idle' };

const LOAD: ThemeEffect = { kind: 'load' };

type Handler<K extends ThemeEvent['type']> = (
  state: ThemeState,
  event: Extract<ThemeEvent, { type: K }>,
) => Step<ThemeState, ThemeEffect> | null;

type HandlerMap = { [K in ThemeEvent['type']]: Handler<K> };

const handlers: HandlerMap = {
  'theme/reload-requested': (state) => {
    if (state.status === 'idle') {
      return {
        state: { status: 'loading', themes: [], errors: [], reloadQueued: false },
        effects: [LOAD],
      };
    }
    if (state.status === 'loading') {
      // 読み込みは 1 本だけ走らせる。重ねずに、終わったらもう一度読む。
      return state.reloadQueued ? null : { state: { ...state, reloadQueued: true } };
    }
    return {
      state: { status: 'loading', themes: state.themes, errors: state.errors, reloadQueued: false },
      effects: [LOAD],
    };
  },

  'theme/loaded': (state, event) => {
    // 読み込みを頼んでいないのに届いた結果は捨てる。
    if (state.status !== 'loading') return null;
    if (state.reloadQueued) {
      return {
        state: { status: 'loading', themes: event.themes, errors: event.errors, reloadQueued: false },
        effects: [LOAD],
      };
    }
    return { state: { status: 'loaded', themes: event.themes, errors: event.errors } };
  },

  'theme/open-folder-requested': (state) => ({ state, effects: [{ kind: 'open-folder' }] }),

  'theme/create-with-claude-requested': (state) => ({
    state,
    effects: [{ kind: 'create-with-claude' }],
  }),
};

/**
 * theme の遷移関数。純粋。
 * 返り値が `null` のイベントは「今の状態では意味を持たない」ので黙って捨てる。
 */
export const transition: TransitionFn<ThemeState, ThemeEvent, ThemeEffect> = (state, event) => {
  // 写像型でキーと引数の対応は保証済み。ここだけは型を合わせるためのキャストが要る。
  const handler = handlers[event.type] as Handler<ThemeEvent['type']>;
  return handler(state, event);
};
