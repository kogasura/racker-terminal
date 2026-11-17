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
import { useSettingsView } from '../settings/SettingsRoot';
import { createEffectRunner, type EffectDeps } from './effects';
import type { ThemeEvent } from './events';
import { initialState, transition, type ThemeEffect, type ThemeState } from './machine';
import { applyThemeVars, saveThemeCache } from './themeCache';
import { selectAppTheme, selectThemeView, type ThemeViewModel } from './viewModel';

const ThemeViewContext = createContext<ThemeViewModel | null>(null);

/** テーマの選択肢・読み込みエラー・カタログ。 */
export function useThemeView(): ThemeViewModel {
  const vm = useContext(ThemeViewContext);
  if (!vm) throw new Error('useThemeView は ThemeRoot の内側でしか使えません。');
  return vm;
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
      initial: initialState,
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

  const view = useMemo(() => selectThemeView(state), [state]);
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
      <ThemeViewContext.Provider value={view}>{children}</ThemeViewContext.Provider>
    </EventScope>
  );
}
