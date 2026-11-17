/**
 * 状態 → View モデルの射影と、どのテーマを当てるかの判断。純関数。
 *
 * 設定ダイアログ・お気に入りダイアログの選択肢、ThemeRoot が窓に当てるテーマと背景、
 * 各タブのターミナルに当てるテーマは、すべてここで決める。
 */

import { BUILTIN_SCENES, sceneSvg } from '../../lib/backdrop/catalog';
import { contextLimitFor, type ClaudeTranscriptMeta } from '../../lib/claudeMeta';
import type { BackdropAgent } from '../../lib/theme/backdropDocument';
import { buildCatalog, resolveTheme } from '../../lib/theme/resolveTheme';
import type { ThemeAppearance, ThemeDefinition, ThemeSource } from '../../lib/theme/types';
import type { AgentState, Settings } from '../../types';
import type { ThemeFileError } from './events';
import type { ThemeState } from './machine';

/** 選択肢 1 件。 */
export interface ThemeOption {
  readonly id: string;
  readonly name: string;
  readonly source: ThemeSource;
  /** ライト向けかダーク向けか */
  readonly appearance: ThemeAppearance;
  /** 動く背景が付いているか */
  readonly hasBackdrop: boolean;
  /** ひとこと説明。組み込みの背景付きのテーマにだけある */
  readonly blurb?: string;
}

export interface ThemeViewModel {
  /** 選択肢。組み込みが先、ユーザーのテーマが後 */
  readonly options: ThemeOption[];
  /** 読み込めなかったテーマファイル（ファイル名と理由） */
  readonly errors: ThemeFileError[];
  /** ユーザーのテーマをまだ読み込み中か（起動直後・再読み込み中） */
  readonly loading: boolean;
  /** テーマの定義一覧。ID からテーマを引くのに使う */
  readonly catalog: ThemeDefinition[];
}

/** シーンの id → ひとこと説明。 */
const SCENE_BLURBS: ReadonlyMap<string, string> = new Map(
  BUILTIN_SCENES.map((scene) => [scene.id, scene.blurb]),
);

function toOption(theme: ThemeDefinition): ThemeOption {
  const { id, name, source, appearance, backdrop } = theme;
  const blurb = backdrop?.kind === 'builtin' ? SCENE_BLURBS.get(backdrop.sceneId) : undefined;
  return {
    id,
    name,
    source,
    appearance,
    hasBackdrop: backdrop !== undefined,
    ...(blurb === undefined ? {} : { blurb }),
  };
}

export function selectThemeView(state: ThemeState): ThemeViewModel {
  // idle でもキャッシュ済みのテーマはカタログに入れる (起動直後のちらつき対策)
  const catalog = buildCatalog([...state.themes]);
  return {
    options: catalog.map(toOption),
    errors: state.status === 'idle' ? [] : [...state.errors],
    loading: state.status !== 'loaded',
    catalog,
  };
}

/**
 * アプリの設定のテーマ。
 *
 * 読み込みが終わる前に、選んでいる ID がカタログに無ければ null（＝まだ当てない）。
 * 起動直後は自作テーマがまだ読めていないだけなので、ここで Tokyo Night に
 * フォールバックすると、起動時のキャッシュで当てた色が一瞬 Tokyo Night に戻ってしまう。
 * 読み込み後も見つからなければ、そのときは Tokyo Night にフォールバックする。
 */
export function selectAppTheme(view: ThemeViewModel, themeId: string): ThemeDefinition | null {
  if (view.loading && !view.catalog.some((theme) => theme.id === themeId)) return null;
  return resolveTheme(view.catalog, themeId);
}

/** 窓に当てるテーマを決めるための ID。 */
export interface WindowThemeIds {
  /** 設定ダイアログで試しに表示しているテーマ。試していなければ null */
  readonly previewThemeId: string | null;
  /** アクティブなタブの上書き (Tab.themeId)。タブが無い・上書きが無ければ undefined */
  readonly tabThemeId: string | undefined;
  /** アプリの設定のテーマ */
  readonly appThemeId: string;
}

/**
 * 窓全体（画面の枠・背景・すりガラス）に当てるテーマ。
 *
 * 試しに表示しているテーマ → アクティブなタブの上書き → アプリの設定 → Tokyo Night の順。
 * 画面に見えるターミナルはアクティブなタブだけなので、窓もそのタブのテーマに揃える。
 *
 * 読み込みが終わる前に、使いたい ID がカタログに無ければ null（＝まだ当てない）。
 * 理由は selectAppTheme と同じ（自作テーマがまだ読めていないだけかもしれない）。
 */
export function selectWindowTheme(
  view: ThemeViewModel,
  ids: WindowThemeIds,
): ThemeDefinition | null {
  const preview = view.catalog.find((theme) => theme.id === ids.previewThemeId);
  if (preview) return preview;
  if (view.loading) {
    const wanted = ids.tabThemeId ?? ids.appThemeId;
    if (!view.catalog.some((theme) => theme.id === wanted)) return null;
  }
  return resolveTabTheme(view.catalog, ids.tabThemeId, ids.appThemeId);
}

/**
 * タブのターミナルに当てるテーマ。
 * タブの上書き (themeId) がカタログにあればそれ。無い (未指定・ファイルを消した) ときは
 * アプリの設定のテーマに従い、それも見つからなければ Tokyo Night。
 */
export function resolveTabTheme(
  catalog: readonly ThemeDefinition[],
  tabThemeId: string | undefined,
  appThemeId: string,
): ThemeDefinition {
  const override = catalog.find((theme) => theme.id === tabThemeId);
  return override ?? resolveTheme(catalog, appThemeId);
}

/**
 * 開いている各ターミナルに当てるテーマを決める。
 * runtime はあるのにタブが無い (閉じている途中など) ときは、アプリの設定のテーマにする。
 * @param entries - tabId と runtime の組 (terminalRegistry の getAllRuntimeEntries)
 * @param tabs - いまのタブ。tabId で引き、上書き (themeId) を見る
 */
export function resolveRuntimeThemes<R>(
  entries: readonly (readonly [string, R])[],
  tabs: Readonly<Record<string, { readonly themeId?: string } | undefined>>,
  catalog: readonly ThemeDefinition[],
  appThemeId: string,
): [R, ThemeDefinition][] {
  return entries.map(([tabId, runtime]) => [
    runtime,
    resolveTabTheme(catalog, tabs[tabId]?.themeId, appThemeId),
  ]);
}

// ─── 動く背景 ────────────────────────────────────────────────────────────────

/** 窓の背景（BackdropLayer）に渡す View モデル。 */
export interface BackdropViewModel {
  /** 描く SVG。背景の無いテーマ（配色だけ）では null で、何も描かない */
  readonly svg: string | null;
  /** アニメーションを止めるか（「背景を動かす」がオフ） */
  readonly paused: boolean;
  /** アクティブなタブのエージェントの状態。SVG のルートの data-agent になる */
  readonly agent: BackdropAgent;
}

/** テーマの背景の SVG。組み込みはシーンの ID から作り、自作はファイルの中身。無ければ null。 */
export function selectBackdropSvg(theme: ThemeDefinition | null): string | null {
  const backdrop = theme?.backdrop;
  if (backdrop === undefined) return null;
  if (backdrop.kind === 'user') return backdrop.svg;
  return sceneSvg(backdrop.sceneId) ?? null;
}

/** 背景を止めるか。未設定は「動かす」として扱う。 */
export function isBackdropPaused(settings: Pick<Settings, 'backdropMotion'>): boolean {
  return settings.backdropMotion === false;
}

/**
 * タブのエージェントの状態を、背景に渡す 3 つの値に写す。
 * 完了 (done) は「もう動いていない」ので idle と同じに扱う。未検出も idle。
 */
export function toBackdropAgent(state: AgentState | undefined): BackdropAgent {
  if (state === 'working' || state === 'blocked') return state;
  return 'idle';
}

export function selectBackdropView(
  theme: ThemeDefinition | null,
  settings: Pick<Settings, 'backdropMotion'>,
  agentState: AgentState | undefined,
): BackdropViewModel {
  return {
    svg: selectBackdropSvg(theme),
    paused: isBackdropPaused(settings),
    agent: toBackdropAgent(agentState),
  };
}

/**
 * アクティブなタブのコンテキストの使用率（0〜1）。背景の `--rk-context` になる。
 * ステータスバーと同じく、上限はモデルから決める（contextLimitFor）。
 * Claude の情報が無い（Claude タブでない・ステータスバーが無効）ときは 0。
 */
export function backdropContext(meta: ClaudeTranscriptMeta | null): number {
  const tokens = meta?.contextTokens;
  if (meta === null || tokens === undefined) return 0;
  const limit = contextLimitFor(meta.model, tokens);
  if (!(limit > 0)) return 0;
  return Math.min(1, Math.max(0, tokens / limit));
}
