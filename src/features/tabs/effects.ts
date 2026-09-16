/**
 * 裁定を通ったタブ操作コマンドを実際に適用する層。
 *
 * タブのデータはまだ store が持っているため、ここが store への唯一の接点になります。
 * View からは store が見えず、Mediator も store を知らない — この 1 ファイルだけが
 * 両者を繋いでいます。データを Mediator 側へ移すときも、書き換えるのはここだけです。
 */

import { nextNewGroupTitle } from '../../lib/dndResolve';
import { getTabDisplayTitle } from '../../types';
import { selectNextTabId, selectPrevTabId, useAppStore } from '../../store/appStore';
import type { TabsEvent } from './events';
import type { TabsEffect } from './machine';

export interface EffectDeps {
  /** store の現在値を取る。テストでは差し替える。 */
  getState: typeof useAppStore.getState;
}

const defaultDeps: EffectDeps = { getState: useAppStore.getState };

/** store の現在値。effect ハンドラが使う分だけを型で示す。 */
type StoreState = ReturnType<typeof useAppStore.getState>;

/** 効果 1 種類につき 1 つのハンドラ。 */
type EffectHandler<K extends TabsEffect['kind']> = (
  state: StoreState,
  effect: Extract<TabsEffect, { kind: K }>,
) => void;

type HandlerMap = { [K in TabsEffect['kind']]: EffectHandler<K> };

const handlers: HandlerMap = {
  'close-active': (state) => {
    // アクティブタブが無ければ何もしない
    if (state.activeTabId) state.removeTab(state.activeTabId);
  },

  navigate: (state, effect) => {
    const nextId = effect.direction === 'prev' ? selectPrevTabId(state) : selectNextTabId(state);
    // 端で行き先が無ければ何もしない
    if (nextId) state.navigateToTab(nextId);
  },

  restore: (state) => state.restoreLastClosedTab(),

  'spawn-default': (state) => state.spawnDefaultOrNew(),

  'spawn-favorite': (state, effect) => state.spawnFavoriteByIndex(effect.index),

  'create-tab': (state) => {
    // グループが 1 つも無い起動直後は何もしない (タブバー自体が出ていない)
    if (state.activeGroupId) state.createTab(state.activeGroupId);
  },

  'activate-tab': (state, effect) => state.setActiveTab(effect.tabId),

  'close-tab': (state, effect) => state.removeTab(effect.tabId),

  'start-editing': (state, effect) => state.startEditing(effect.tabId),

  'rename-tab': (state, effect) => state.updateTabTitle(effect.tabId, effect.title),

  'duplicate-tab': (state, effect) => state.duplicateTab(effect.tabId),

  'favorite-tab': (state, effect) => {
    const tab = state.tabs[effect.tabId];
    if (!tab) return;
    // 元タブの shell / cwd / args / env / userTitle を引き継いでお気に入りに登録する。
    // launchClaude / bypassPermissions も引き継ぐ: ここが抜けていたため、
    // Claude タブを「お気に入りに追加」すると自動起動しないお気に入りになっていた。
    state.addFavorite({
      title: getTabDisplayTitle(tab),
      shell: tab.shell,
      cwd: tab.cwd,
      args: tab.args, // クローンは addFavorite 内部で行う
      env: tab.env,
      launchClaude: tab.launchClaude || undefined,
      // 権限バイパスは Claude 自動起動が前提。FavoriteDialog の保存と同じ正規化を行う
      bypassPermissions: (tab.launchClaude && tab.bypassPermissions) || undefined,
    });
  },

  'clear-claude-session': (state, effect) => state.clearClaudeSession(effect.tabId),

  // 移動先の末尾に置く。moveTab 側が toIndex をクランプする
  'move-tab': (state, effect) =>
    state.moveTab(effect.tabId, effect.toGroupId, Number.MAX_SAFE_INTEGER),

  'move-tab-to-new-group': (state, effect) => {
    // サイドバー下部の「+ 新規グループに追加」drop エリアと同じ操作
    const groupId = state.createGroup(nextNewGroupTitle(state.groups));
    state.moveTab(effect.tabId, groupId, 0);
  },

  'activate-group': (state, effect) => state.setActiveGroup(effect.groupId),

  'start-editing-group': (state, effect) => state.startEditing(effect.groupId),

  'rename-group': (state, effect) => state.updateGroupTitle(effect.groupId, effect.title),

  'close-group': (state, effect) => state.removeGroup(effect.groupId),

  'create-tab-in-group': (state, effect) => state.createTab(effect.groupId),

  'spawn-favorite-by-id': (state, effect) => state.spawnFavorite(effect.favoriteId),

  'remove-favorite': (state, effect) => state.removeFavorite(effect.favoriteId),

  'toggle-default-favorite': (state, effect) => {
    // 既定なら解除、そうでなければ設定
    const isDefault = state.settings.defaultFavoriteId === effect.favoriteId;
    state.setDefaultFavorite(isDefault ? null : effect.favoriteId);
  },

  'add-favorite': (state, effect) => {
    state.addFavorite(effect.favorite);
  },

  'update-favorite': (state, effect) => state.updateFavorite(effect.favoriteId, effect.favorite),

  'create-group': (state) => {
    // 連番の付け直しはここで決める。削除 → 追加で番号が崩れないようにするため、
    // 既存タイトルの最大値を見る必要がある (nextNewGroupTitle)。
    const id = state.createGroup(nextNewGroupTitle(state.groups));
    // 作ったグループをそのまま選択する。選択が前のグループに残っていると、
    // 直後の Ctrl+T やタイトルバーの + が古いグループにタブを作ってしまう。
    state.setActiveGroup(id);
  },
};

export function createEffectRunner(deps: EffectDeps = defaultDeps) {
  // コマンドはどれも store のアクションを 1 回呼ぶだけで、マシンへ返す結果はない。
  // (成功 / 失敗という概念が無く、対象が無ければ store 側が no-op になる)
  return function run(effect: TabsEffect, _send: (event: TabsEvent) => void): void {
    const handler = handlers[effect.kind] as EffectHandler<TabsEffect['kind']>;
    handler(deps.getState(), effect);
  };
}
