/**
 * 裁定を通ったタブ操作コマンドを実際に適用する層。
 *
 * タブのデータはまだ store が持っているため、ここが store への唯一の接点になります。
 * View からは store が見えず、Mediator も store を知らない — この 1 ファイルだけが
 * 両者を繋いでいます。データを Mediator 側へ移すときも、書き換えるのはここだけです。
 */

import { nextNewGroupTitle } from '../../lib/dndResolve';
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
