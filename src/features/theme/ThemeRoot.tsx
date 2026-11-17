/**
 * テーマ（配色）の Root。
 *
 * Root の役目:
 *
 *   1. ユーザーのテーマファイルの読み込み状況を Mediator で持つ（起動時に読み込む）
 *   2. 選んだテーマと透明度から CSS 変数一式を作って documentElement に当て、
 *      次回起動のちらつき対策に localStorage へ保存する
 *   3. 選択肢とエラーの一覧を `useThemeView()` で配る（設定ダイアログ・お気に入り
 *      ダイアログ・ターミナルの手入れが使う）
 *   4. 読み込んだ自作テーマを localStorage に覚えておき、次回の起動直後のカタログに
 *      入れる（ターミナルの配色が一瞬 Tokyo Night になるのを防ぐ）
 *   5. 購読せずに最新のカタログを読む口 `useThemeCatalogRef()` を配る（ターミナルの
 *      生成時に使う。読み込みのたびに全タブを描き直さないため）
 *
 * 選んだテーマの ID は設定の一部なので SettingsRoot から受け取る。この Root は
 * SettingsRoot の内側に置く。透明度の反映もここが持つ（`--bg-alpha` に依存する背景の
 * 変数を、テーマの色と一緒に計算するため）。
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { EventScope, mediatorLink, type Link } from '../../architecture/chain';
import { createMachine, type Machine } from '../../architecture/machine';
import { buildCssVars } from '../../lib/theme/cssVars';
import type { ThemeDefinition } from '../../lib/theme/types';
import { useSettingsView } from '../settings/SettingsRoot';
import { createEffectRunner, type EffectDeps } from './effects';
import type { ThemeEvent } from './events';
import { createInitialState, transition, type ThemeEffect, type ThemeState } from './machine';
import {
  applyThemeVars,
  loadCachedUserThemes,
  saveThemeCache,
  saveUserThemesCache,
} from './themeCache';
import { selectAppTheme, selectThemeView, type ThemeViewModel } from './viewModel';

const ThemeViewContext = createContext<ThemeViewModel | null>(null);

/** テーマの選択肢・読み込みエラー・カタログ。 */
export function useThemeView(): ThemeViewModel {
  const vm = useContext(ThemeViewContext);
  if (!vm) throw new Error('useThemeView は ThemeRoot の内側でしか使えません。');
  return vm;
}

/** 最新のカタログを指す参照。オブジェクト自体は変わらず、中身 (current) だけが入れ替わる。 */
export interface ThemeCatalogRef {
  readonly current: readonly ThemeDefinition[];
}

const ThemeCatalogRefContext = createContext<ThemeCatalogRef | null>(null);

/**
 * 購読しないカタログの取得口。
 *
 * 返す参照は ThemeRoot の寿命の間ずっと同じなので、これを使うコンポーネントは
 * テーマの読み込み状況が変わっても描き直されない。`current` は読んだ時点の最新の
 * カタログ。ターミナルの生成時のように「その瞬間の値が要るだけ」の箇所で使う。
 */
export function useThemeCatalogRef(): ThemeCatalogRef {
  const ref = useContext(ThemeCatalogRefContext);
  if (!ref) throw new Error('useThemeCatalogRef は ThemeRoot の内側でしか使えません。');
  return ref;
}

const traceLink: Link<ThemeEvent> = (event, next) => {
  if (import.meta.env.DEV) console.debug('[theme] event:', event.type);
  next(event);
};

export interface ThemeRootProps {
  readonly children: ReactNode;
  /**
   * 設定を当ててよいか。persist の hydration 完了を待つために使う。
   * 復元前の既定値 (Tokyo Night) を当てると、起動時のキャッシュで当てた色を潰してしまう。
   */
  readonly ready: boolean;
  /** テスト用の差し替え。 */
  readonly deps?: EffectDeps;
}

export function ThemeRoot({ children, ready, deps }: ThemeRootProps) {
  const machineRef = useRef<Machine<ThemeState, ThemeEvent> | null>(null);
  if (!machineRef.current) {
    machineRef.current = createMachine<ThemeState, ThemeEvent, ThemeEffect>({
      initial: createInitialState(loadCachedUserThemes()),
      transition,
      run: createEffectRunner(deps),
    });
  }
  const machine = machineRef.current;

  const state = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);
  const settings = useSettingsView();

  // theme 宛てのイベントだけを Mediator に渡し、他機能のイベントは上へ流す。
  const links = useMemo<readonly Link<ThemeEvent>[]>(
    () => [traceLink, mediatorLink('theme/', (event) => machine.send(event))],
    [machine],
  );

  // 起動時に themes フォルダを読む。
  useEffect(() => {
    machine.send({ type: 'theme/reload-requested' });
  }, [machine]);

  // 読み込みが終わったら、次回の起動のために自作テーマを覚えておく。
  useEffect(() => {
    if (state.status === 'loaded') saveUserThemesCache(state.themes);
  }, [state]);

  const view = useMemo(() => selectThemeView(state), [state]);
  // 描画中に差し替える。子の effect (ターミナルの生成) が同じコミットで読んでも最新になる。
  const catalogRef = useRef<readonly ThemeDefinition[]>(view.catalog);
  catalogRef.current = view.catalog;
  const appTheme = ready ? selectAppTheme(view, settings.theme) : null;
  const alpha = settings.transparency ?? 1;

  // 描画と同じフレームで当てる (useEffect だと、変更前の色で 1 フレーム描かれる)。
  useLayoutEffect(() => {
    if (!appTheme) return;
    const vars = buildCssVars(appTheme, alpha);
    applyThemeVars(vars);
    saveThemeCache(vars);
  }, [appTheme, alpha]);

  return (
    <EventScope<ThemeEvent> links={links}>
      <ThemeViewContext.Provider value={view}>
        <ThemeCatalogRefContext.Provider value={catalogRef}>{children}</ThemeCatalogRefContext.Provider>
      </ThemeViewContext.Provider>
    </EventScope>
  );
}
