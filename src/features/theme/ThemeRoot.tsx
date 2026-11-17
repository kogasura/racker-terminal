/**
 * テーマ（配色）の Root。
 *
 * Root の役目:
 *
 *   1. ユーザーのテーマファイルの読み込み状況を Mediator で持つ（起動時に読み込む）
 *   2. 窓に当てるテーマを決め（試しに表示 → アクティブなタブの上書き → アプリの設定）、
 *      透明度と合わせて CSS 変数一式を作って documentElement に当て、
 *      次回起動のちらつき対策に localStorage へ保存する（窓のテーマの ID も）
 *   3. 選択肢とエラーの一覧を `useThemeView()` で配る（設定ダイアログ・お気に入り
 *      ダイアログ・ターミナルの手入れが使う）
 *   3b. 窓の背景（SVG・止めるか・エージェントの状態）を `useBackdropView()` で配る
 *      （BackdropLayer が使う）。起動直後は、設定の復元や themes フォルダの読み込みを待たずに
 *      前回の窓のテーマの背景を出す
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
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { EventScope, mediatorLink, type Link } from '../../architecture/chain';
import { createMachine, type Machine } from '../../architecture/machine';
import { buildCssVars } from '../../lib/theme/cssVars';
import type { ThemeDefinition } from '../../lib/theme/types';
import { useAppStore } from '../../store/appStore';
import { useSettingsView } from '../settings/SettingsRoot';
import { createEffectRunner, type EffectDeps } from './effects';
import type { ThemeEvent } from './events';
import { createInitialState, transition, type ThemeEffect, type ThemeState } from './machine';
import {
  applyThemeVars,
  loadCachedUserThemes,
  loadCachedWindowThemeId,
  saveThemeCache,
  saveUserThemesCache,
} from './themeCache';
import {
  selectBackdropView,
  selectThemeView,
  selectWindowTheme,
  type BackdropViewModel,
  type ThemeViewModel,
} from './viewModel';

const ThemeViewContext = createContext<ThemeViewModel | null>(null);

/** テーマの選択肢・読み込みエラー・カタログ。 */
export function useThemeView(): ThemeViewModel {
  const vm = useContext(ThemeViewContext);
  if (!vm) throw new Error('useThemeView は ThemeRoot の内側でしか使えません。');
  return vm;
}

/**
 * 窓の背景。useThemeView と分けているのは、エージェントの状態のように頻繁に変わる値で
 * 選択肢やカタログの利用者（ターミナルの手入れなど）まで描き直さないため。
 */
const BackdropViewContext = createContext<BackdropViewModel | null>(null);

/** 窓の背景（描く SVG・止めるか・エージェントの状態）。 */
export function useBackdropView(): BackdropViewModel {
  const vm = useContext(BackdropViewContext);
  if (!vm) throw new Error('useBackdropView は ThemeRoot の内側でしか使えません。');
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

  // アクティブなタブの上書きとエージェントの状態。窓のテーマと背景の連動に使う。
  const activeTabThemeId = useAppStore((s) =>
    s.activeTabId === null ? undefined : s.tabs[s.activeTabId]?.themeId,
  );
  const activeAgentState = useAppStore((s) =>
    s.activeTabId === null ? undefined : s.tabs[s.activeTabId]?.agentState,
  );
  // 前回、窓に当てたテーマの ID。起動直後の背景に使う (読むのは最初の 1 回だけ)。
  const [startupThemeId] = useState(loadCachedWindowThemeId);
  // 設定ダイアログで試しに表示しているテーマ (theme/preview-requested / theme/preview-ended)。
  const previewThemeId = state.previewThemeId ?? null;

  const view = useMemo(() => selectThemeView(state), [state]);
  // 描画中に差し替える。子の effect (ターミナルの生成) が同じコミットで読んでも最新になる。
  const catalogRef = useRef<readonly ThemeDefinition[]>(view.catalog);
  catalogRef.current = view.catalog;
  const windowTheme = ready
    ? selectWindowTheme(view, {
        previewThemeId,
        tabThemeId: activeTabThemeId,
        appThemeId: settings.theme,
      })
    : null;
  const alpha = settings.transparency ?? 1;

  // 描画と同じフレームで当てる (useEffect だと、変更前の色で 1 フレーム描かれる)。
  // 試しに表示の間は保存しない (表示中に閉じても、次の起動で試したテーマが出ないように)。
  const previewing = previewThemeId !== null;
  useLayoutEffect(() => {
    if (!windowTheme) return;
    const vars = buildCssVars(windowTheme, alpha);
    applyThemeVars(vars);
    if (!previewing) saveThemeCache(vars, windowTheme.id);
  }, [windowTheme, alpha, previewing]);

  // 窓のテーマがまだ決まらない間 (設定の復元前・自作テーマの読み込み前) は、
  // 前回の窓のテーマの背景を出しておく。CSS 変数も起動時のキャッシュで前回の色になっている。
  const backdropTheme =
    windowTheme ?? view.catalog.find((theme) => theme.id === startupThemeId) ?? null;
  const backdropMotion = settings.backdropMotion;
  const backdropView = useMemo(
    () => selectBackdropView(backdropTheme, { backdropMotion }, activeAgentState),
    [backdropTheme, backdropMotion, activeAgentState],
  );

  return (
    <EventScope<ThemeEvent> links={links}>
      <ThemeViewContext.Provider value={view}>
        <BackdropViewContext.Provider value={backdropView}>
          <ThemeCatalogRefContext.Provider value={catalogRef}>
            {children}
          </ThemeCatalogRefContext.Provider>
        </BackdropViewContext.Provider>
      </ThemeViewContext.Provider>
    </EventScope>
  );
}
