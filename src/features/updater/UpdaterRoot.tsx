/**
 * updater 機能の Root。
 *
 * この機能に属する Passive View はすべてこの配下に置かれ、次の 3 つだけを Root が持つ:
 *
 *   1. Mediator (ステートマシン) の生成と保持
 *   2. イベントチェーンの組み立て — 終端が Mediator への送出になる
 *   3. 状態 → View モデルの射影を子へ配る
 *
 * View は状態も store も知らない。Root から降ってくる View モデルを描き、
 * 起きたことを `useEmit` で上へ流すだけ。
 *
 * バッジはタイトルバーの中、設定セクションは設定ダイアログの中に出るため、
 * この Root は DOM の親子ではなく **コンテキストの親** として機能する。
 * アプリ全体の Root (App.tsx) が最上位でこれを敷き、離れた場所の View が
 * `useUpdaterView()` で View モデルを受け取る。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { EventScope, mediatorLink, type Link } from '../../architecture/chain';
import { createMachine, type Machine } from '../../architecture/machine';
import { takeFailedUpdateAttempt } from '../../lib/updater';
import { createEffectRunner, type EffectDeps } from './effects';
import type { UpdaterEvent } from './events';
import { initialState, transition, type UpdaterEffect, type UpdaterState } from './machine';
import {
  selectBadge,
  selectDialog,
  selectFailureNotice,
  selectSettingsSection,
  type BadgeViewModel,
  type DialogViewModel,
  type FailureNoticeViewModel,
  type SettingsSectionViewModel,
} from './viewModel';
import { UpdateDialogView } from './views/UpdateDialogView';
import { UpdateFailureNoticeView } from './views/UpdateFailureNoticeView';

/** 起動しっぱなしの運用でも更新に気付けるよう、1 時間ごとに確認する。 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdaterViewModels {
  readonly badge: BadgeViewModel;
  readonly dialog: DialogViewModel;
  readonly failureNotice: FailureNoticeViewModel;
  readonly settingsSection: SettingsSectionViewModel;
}

const UpdaterViewContext = createContext<UpdaterViewModels | null>(null);

/**
 * 離れた場所にある Passive View (タイトルバーのバッジ、設定セクション) が
 * View モデルを受け取るための口。
 */
export function useUpdaterView(): UpdaterViewModels {
  const vm = useContext(UpdaterViewContext);
  if (!vm) throw new Error('useUpdaterView は UpdaterRoot の内側でしか使えません。');
  return vm;
}

/**
 * 開発時に、どのイベントがチェーンを通ったかを追えるようにするリンク。
 * 何も消費せずそのまま上へ流す。
 */
const traceLink: Link<UpdaterEvent> = (event, next) => {
  if (import.meta.env.DEV) console.debug('[updater] event:', event.type);
  next(event);
};

export interface UpdaterRootProps {
  readonly children: ReactNode;
  /**
   * 起動時の初期化を始めてよいか。persist の hydration 完了を待つために使う。
   * false の間はチェックを走らせない。
   */
  readonly ready: boolean;
  /** テスト用の差し替え。 */
  readonly deps?: EffectDeps;
}

export function UpdaterRoot({ children, ready, deps }: UpdaterRootProps) {
  // マシンは 1 度だけ作る。effects は自分の中に待機ハンドルを持つので、
  // 作り直すと DL 済みのハンドルを失う。
  const machineRef = useRef<Machine<UpdaterState, UpdaterEvent> | null>(null);
  if (!machineRef.current) {
    const run = createEffectRunner(deps);
    machineRef.current = createMachine<UpdaterState, UpdaterEvent, UpdaterEffect>({
      initial: initialState,
      transition,
      run,
    });
  }
  const machine = machineRef.current;

  const state = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);

  // updater 宛てのイベントだけを Mediator に渡し、他機能のイベントは上へ流す。
  // (終端を乗っ取ると Root を入れ子にできなくなる)
  const links = useMemo<readonly Link<UpdaterEvent>[]>(
    () => [traceLink, mediatorLink('updater/', (event) => machine.send(event))],
    [machine],
  );

  // 起動時の確認と定期チェック。
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    // 前回「再起動して適用」したのにバージョンが変わっていないなら、更新は
    // 無言で失敗している。チェックより先に確かめて知らせる。
    void (async () => {
      const failure = await takeFailedUpdateAttempt();
      if (!cancelled && failure) {
        machine.send({ type: 'updater/previous-attempt-detected', failure });
      }
    })();

    const fire = () => {
      if (cancelled) return;
      // 重なっても Mediator が弾く (checking / downloading / installing では無視される)。
      machine.send({ type: 'updater/check-requested', manual: false });
    };

    fire();
    const intervalId = setInterval(fire, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [machine, ready]);

  const viewModels = useMemo<UpdaterViewModels>(
    () => ({
      badge: selectBadge(state),
      dialog: selectDialog(state),
      failureNotice: selectFailureNotice(state),
      settingsSection: selectSettingsSection(state),
    }),
    [state],
  );

  return (
    <EventScope<UpdaterEvent> links={links}>
      <UpdaterViewContext.Provider value={viewModels}>
        {children}
        {/* この機能が自前で置く View。離れた場所の View は useUpdaterView で受け取る。 */}
        <UpdateFailureNoticeView vm={viewModels.failureNotice} />
        <UpdateDialogView vm={viewModels.dialog} />
      </UpdaterViewContext.Provider>
    </EventScope>
  );
}
