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
 *   `reload-requested` を流して `loading` へ進める。`idle` と初回の `loading` は、
 *   前回の起動で読み込んだテーマ（localStorage のキャッシュ）を持つ。起動直後から
 *   自作テーマを引けるようにして、ターミナルが一瞬 Tokyo Night で描かれるのを防ぐ。
 * - 読み込み中に `reload-requested` が来たら、いま走っている読み込みが始まった後に
 *   ファイルが書き換えられた可能性がある。捨てずに覚えておき、結果が返ったらもう一度読む。
 * - 再読み込みの間も前回の結果は持ち続ける。選択中の自作テーマが一瞬消えて
 *   Tokyo Night に戻る、というちらつきを起こさないため。
 *
 * フォルダを開く / Claude で作るは状態を持たない副作用なので、状態は動かさず
 * 副作用だけを出す。
 *
 * 試しに表示（設定ダイアログでカードを押したテーマ）は、読み込み状況とは別の軸なので
 * どの状態にも `previewThemeId` として載せる。読み込みの遷移では持ち越す。
 *
 * ```
 *   (試していない) ──preview-requested──> (previewThemeId あり) ──preview-ended──> (試していない)
 * ```
 */

import type { Step, TransitionFn } from '../../architecture/machine';
import type { ThemeDefinition } from '../../lib/theme/types';
import type { ThemeEvent, ThemeFileError } from './events';

/** 読み込み状況。 */
type ThemeLoadState =
  | {
      readonly status: 'idle';
      /** 前回の起動で読み込んだテーマ（キャッシュ。無ければ空） */
      readonly themes: readonly ThemeDefinition[];
    }
  | {
      readonly status: 'loading';
      /** 前回読み込んだ結果（初回はキャッシュ）。読み込みが終わるまではこれを使う */
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

/** 試しに表示。読み込み状況とは別の軸。 */
interface ThemePreview {
  /**
   * 設定ダイアログで試しに表示しているテーマの ID。試していなければ無し。
   * 窓にはアプリの設定やタブの上書きより優先して当てる（設定そのものは変えない）。
   */
  readonly previewThemeId?: string;
}

export type ThemeState = ThemeLoadState & ThemePreview;

/** Mediator が「やってほしい」と言う副作用。実行は effects.ts の担当。 */
export type ThemeEffect =
  | { readonly kind: 'load' }
  | { readonly kind: 'open-folder' }
  | { readonly kind: 'create-with-claude' };

/** 前回の起動で読み込んだテーマ（キャッシュ）を持たせた初期状態を作る。 */
export function createInitialState(cachedThemes: readonly ThemeDefinition[]): ThemeState {
  return { status: 'idle', themes: cachedThemes };
}

export const initialState: ThemeState = createInitialState([]);

const LOAD: ThemeEffect = { kind: 'load' };

type Handler<K extends ThemeEvent['type']> = (
  state: ThemeState,
  event: Extract<ThemeEvent, { type: K }>,
) => Step<ThemeState, ThemeEffect> | null;

type HandlerMap = { [K in ThemeEvent['type']]: Handler<K> };

/** 読み込みの遷移で作り直した状態に、元の状態の試しに表示を持ち越す。 */
function keepPreview(from: ThemeState, to: ThemeLoadState): ThemeState {
  return from.previewThemeId === undefined ? to : { ...to, previewThemeId: from.previewThemeId };
}

const handlers: HandlerMap = {
  'theme/reload-requested': (state) => {
    if (state.status === 'idle') {
      return {
        state: keepPreview(state, {
          status: 'loading',
          themes: state.themes,
          errors: [],
          reloadQueued: false,
        }),
        effects: [LOAD],
      };
    }
    if (state.status === 'loading') {
      // 読み込みは 1 本だけ走らせる。重ねずに、終わったらもう一度読む。
      return state.reloadQueued ? null : { state: { ...state, reloadQueued: true } };
    }
    return {
      state: keepPreview(state, {
        status: 'loading',
        themes: state.themes,
        errors: state.errors,
        reloadQueued: false,
      }),
      effects: [LOAD],
    };
  },

  'theme/loaded': (state, event) => {
    // 読み込みを頼んでいないのに届いた結果は捨てる。
    if (state.status !== 'loading') return null;
    if (state.reloadQueued) {
      return {
        state: keepPreview(state, {
          status: 'loading',
          themes: event.themes,
          errors: event.errors,
          reloadQueued: false,
        }),
        effects: [LOAD],
      };
    }
    return {
      state: keepPreview(state, { status: 'loaded', themes: event.themes, errors: event.errors }),
    };
  },

  'theme/open-folder-requested': (state) => ({ state, effects: [{ kind: 'open-folder' }] }),

  'theme/create-with-claude-requested': (state) => ({
    state,
    effects: [{ kind: 'create-with-claude' }],
  }),

  'theme/preview-requested': (state, event) =>
    state.previewThemeId === event.themeId
      ? null
      : { state: { ...state, previewThemeId: event.themeId } },

  'theme/preview-ended': (state) => {
    if (state.previewThemeId === undefined) return null;
    // 試しに表示の印を外す。読み込み状況はそのまま
    const { previewThemeId: _ended, ...rest } = state;
    return { state: rest };
  },
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
