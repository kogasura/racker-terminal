import { describe, it, expect } from 'vitest';
import { TOKYO_NIGHT } from '../../lib/theme/builtinThemes';
import type { ThemeDefinition } from '../../lib/theme/types';
import { createInitialState, initialState, transition, type ThemeState } from './machine';
import type { ThemeEvent, ThemeFileError } from './events';

// 遷移関数は純粋なので、非同期も I/O も無しで全パターンを踏める。

const sunset: ThemeDefinition = { ...TOKYO_NIGHT, id: 'user:sunset', name: 'Sunset', source: 'user' };
const broken: ThemeFileError = { fileName: 'broken.json', error: 'JSON として読めません' };

const RELOAD: ThemeEvent = { type: 'theme/reload-requested' };

function loaded(
  themes: readonly ThemeDefinition[] = [sunset],
  errors: readonly ThemeFileError[] = [broken],
): ThemeEvent {
  return { type: 'theme/loaded', themes, errors };
}

/** 遷移させて次の状態を取り出す。無視されたら元の状態をそのまま返す。 */
function next(s: ThemeState, event: ThemeEvent): ThemeState {
  return transition(s, event)?.state ?? s;
}

/** 発行された副作用の種類。 */
function effects(s: ThemeState, event: ThemeEvent): string[] {
  return (transition(s, event)?.effects ?? []).map((e) => e.kind);
}

const loading: ThemeState = { status: 'loading', themes: [], errors: [], reloadQueued: false };
const loadedState: ThemeState = { status: 'loaded', themes: [sunset], errors: [broken] };

describe('theme machine', () => {
  describe('起動時', () => {
    it('初期状態は idle (まだ読みに行っていない)', () => {
      expect(initialState).toEqual({ status: 'idle', themes: [] });
    });

    it('前回のキャッシュを持たせた idle → loading でも、キャッシュのテーマを持ち続ける', () => {
      const cached = createInitialState([sunset]);
      expect(cached).toEqual({ status: 'idle', themes: [sunset] });
      expect(next(cached, RELOAD)).toEqual({ ...loading, themes: [sunset] });
      expect(effects(cached, RELOAD)).toEqual(['load']);
    });

    it('idle → loading し、load 副作用を出す', () => {
      expect(next(initialState, RELOAD)).toEqual(loading);
      expect(effects(initialState, RELOAD)).toEqual(['load']);
    });

    it('idle に読み込み結果が届いても捨てる (頼んでいない)', () => {
      expect(transition(initialState, loaded())).toBeNull();
    });
  });

  describe('読み込み中', () => {
    it('結果が届いたら loaded になり、テーマとエラーを持つ', () => {
      expect(next(loading, loaded())).toEqual(loadedState);
      expect(effects(loading, loaded())).toEqual([]);
    });

    it('読み込み中の再読み込みは重ねて走らせず、覚えておく', () => {
      const s = next(loading, RELOAD);
      expect(s).toEqual({ ...loading, reloadQueued: true });
      expect(effects(loading, RELOAD)).toEqual([]);
    });

    it('覚えている間にもう一度来ても何も変わらない', () => {
      const queued: ThemeState = { ...loading, reloadQueued: true };
      expect(transition(queued, RELOAD)).toBeNull();
    });

    it('再読み込みを覚えていたら、結果を反映したうえでもう一度読む', () => {
      const queued: ThemeState = { ...loading, reloadQueued: true };
      expect(next(queued, loaded())).toEqual({
        status: 'loading',
        themes: [sunset],
        errors: [broken],
        reloadQueued: false,
      });
      expect(effects(queued, loaded())).toEqual(['load']);
    });
  });

  describe('読み込み後', () => {
    it('再読み込みで loading に戻り、前回の結果は持ち続ける (選択中の自作テーマを消さない)', () => {
      expect(next(loadedState, RELOAD)).toEqual({
        status: 'loading',
        themes: [sunset],
        errors: [broken],
        reloadQueued: false,
      });
      expect(effects(loadedState, RELOAD)).toEqual(['load']);
    });

    it('再読み込みの結果で置き換わる (消したファイルはいなくなる)', () => {
      const reloading = next(loadedState, RELOAD);
      expect(next(reloading, loaded([], []))).toEqual({ status: 'loaded', themes: [], errors: [] });
    });

    it('頼んでいない結果は捨てる', () => {
      expect(transition(loadedState, loaded([], []))).toBeNull();
    });
  });

  describe('フォルダまわり (状態は動かさない)', () => {
    const states: ThemeState[] = [initialState, loading, loadedState];

    it.each(states)('open-folder-requested は open-folder 副作用だけを出す (%o)', (s) => {
      const e: ThemeEvent = { type: 'theme/open-folder-requested' };
      expect(transition(s, e)?.state).toBe(s);
      expect(effects(s, e)).toEqual(['open-folder']);
    });

    it.each(states)('create-with-claude-requested は create-with-claude 副作用だけを出す (%o)', (s) => {
      const e: ThemeEvent = { type: 'theme/create-with-claude-requested' };
      expect(transition(s, e)?.state).toBe(s);
      expect(effects(s, e)).toEqual(['create-with-claude']);
    });
  });
});
