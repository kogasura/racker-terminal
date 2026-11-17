/**
 * ターミナルの手入れをする Root。
 *
 * 画面に何かを出すわけではなく、開いているターミナルのランタイムに対して
 * 定期的な世話をする。ユーザー操作が起点ではないので裁定するものがなく、
 * Mediator の状態もイベントも持たない。updater や claudeStatus の Root が
 * 自分のポーリングを抱えているのと同じ位置づけ。
 *
 * 以前は App.tsx に 3 つの useEffect として並んでいた。App から見ると
 * 「なぜここにあるのか」が分からない副作用だったので、対象ごとにまとめた。
 *
 * テーマのカタログを使うため、ThemeRoot の内側に置く。
 */

import { useEffect, type ReactNode } from 'react';
import {
  getAllRuntimeEntries,
  getAllRuntimes,
  getRuntimeScreen,
  getRuntimeScreenIfDirty,
  recycleTextureAtlas,
} from '../../lib/terminalRegistry';
import { pruneScrollback, saveScrollback } from '../../lib/scrollback';
import type { ThemeDefinition } from '../../lib/theme/types';
import { useAppStore } from '../../store/appStore';
import type { AppState } from '../../types';
import { useThemeView } from '../theme/ThemeRoot';
import { resolveRuntimeThemes } from '../theme/viewModel';

/** スクロールバックの保存間隔。「直前の作業が見える」ことが目的なので粗くてよい。 */
const SAVE_INTERVAL_MS = 30_000;

/** グリフアトラスを作り直す間隔。 */
const RECYCLE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 設定が変わったら全タブの xterm オプションに反映する。
 *
 * subscribeWithSelector middleware は導入せず、前回値比較で settings の
 * 参照変化のみに反応させる。
 */
function useApplySettingsToRuntimes(): void {
  useEffect(() => {
    let prev = useAppStore.getState().settings;
    return useAppStore.subscribe((state) => {
      if (state.settings === prev) return;
      prev = state.settings;
      for (const r of getAllRuntimes()) r.applySettings(state.settings);
    });
  }, []);
}

/**
 * テーマを全タブのターミナルに配る。
 *
 * アプリのテーマ (settings.theme)・カタログ (自作テーマの読み込み)・タブごとの
 * 上書き (tab.themeId) のどれかが変わったら、各タブのテーマを解決し直して渡す。
 * 変わっていないタブは runtime 側の applyTerminalTheme が何もしないので、
 * タブの状態が変わるたびに回しても描画のコストはかからない。
 * 透明度の変化は applySettings 側が、いま当てているテーマの背景色で反映する。
 */
function useApplyThemeToRuntimes(catalog: readonly ThemeDefinition[]): void {
  useEffect(() => {
    const apply = (state: AppState) => {
      const plan = resolveRuntimeThemes(
        getAllRuntimeEntries(),
        state.tabs,
        catalog,
        state.settings.theme,
      );
      for (const [runtime, theme] of plan) runtime.applyTerminalTheme(theme);
    };

    // カタログが変わった (自作テーマを読み込んだ) ときはここで配り直す
    apply(useAppStore.getState());

    let prevSettings = useAppStore.getState().settings;
    let prevTabs = useAppStore.getState().tabs;
    return useAppStore.subscribe((state) => {
      if (state.settings === prevSettings && state.tabs === prevTabs) return;
      prevSettings = state.settings;
      prevTabs = state.tabs;
      apply(state);
    });
  }, [catalog]);
}

/**
 * WebGL のグリフキャッシュ (TextureAtlas) を定期的に作り直す。
 *
 * アトラスは全タブで共有されており、外からクリアすると他タブの頂点バッファが
 * 古い座標を指したままになって文字が化ける。クリアではなく sleep/wake で
 * renderer ごと作り直し、アトラスを解放・再生成する
 * (なぜそうするかの詳細は terminalRegistry の recycleTextureAtlas を参照)。
 *
 * 作り直しは 1 回あたり数十 ms メインスレッドを止める。10 分に一度なので均せば
 * 無視できるが、出力の最中に当たるとフレーム落ちが見えるのでアイドル時間へ寄せる。
 * timeout は付けない: 付けると「出力が続いていてアイドルが来ない」= いちばん
 * 避けたい状況で必ず割り込んでしまう。アイドルが来なければその回は見送り、
 * 次の周期で改めて予約する。
 */
function useRecycleTextureAtlas(): void {
  useEffect(() => {
    let idleId: number | null = null;

    const id = setInterval(() => {
      if (idleId !== null) return; // 前回の予約がまだ捌けていない
      idleId = requestIdleCallback(() => {
        idleId = null;
        recycleTextureAtlas(useAppStore.getState().activeTabId);
      });
    }, RECYCLE_INTERVAL_MS);

    return () => {
      clearInterval(id);
      if (idleId !== null) cancelIdleCallback(idleId);
    };
  }, []);
}

/**
 * タブの画面内容を定期的に保存する。
 *
 * PTY のスクロールバックはプロセスと一蓮托生なので、再起動すると中身が失われる。
 * 定期的にシリアライズして保存しておき、復元時に書き戻す (TerminalPane 側)。
 */
function useSaveScrollback(): void {
  useEffect(() => {
    // 定期保存の対象は「前回の保存以降に出力があったタブ」だけにする。
    // serialize は 1 タブあたり数 ms かかるため、全タブを同期で回すとタブ数に比例して
    // UI スレッドが止まる。出力が無いタブは内容が変わっておらず、保存し直しても
    // ファイルの中身は同じなので丸ごと飛ばしてよい。
    const saveDirtyTabs = () => {
      for (const tabId of Object.keys(useAppStore.getState().tabs)) {
        const content = getRuntimeScreenIfDirty(tabId);
        if (content !== null) void saveScrollback(tabId, content);
      }
    };

    // dirty 判定を通さない全タブ保存。cleanup 用。
    //
    // 注意: これは「終了時の保険」にはなっていない。ウィンドウを閉じる経路に
    // close-requested / beforeunload のフックが無く、プロセスがそのまま落ちるため、
    // 本番でこの cleanup が走るのは実質 dev の HMR だけ。実際の保存粒度は
    // 30 秒間隔がすべて。
    const saveAll = () => {
      for (const tabId of Object.keys(useAppStore.getState().tabs)) {
        const content = getRuntimeScreen(tabId);
        if (content !== null) void saveScrollback(tabId, content);
      }
    };

    // 起動時に、もう存在しないタブの保存ファイルを掃除する
    // (クラッシュ等で削除できなかったぶんが残り続けるため)
    const pruneOnce = () => {
      void pruneScrollback(Object.keys(useAppStore.getState().tabs));
    };
    if (useAppStore.persist.hasHydrated()) pruneOnce();
    else useAppStore.persist.onFinishHydration(pruneOnce);

    const id = setInterval(saveDirtyTabs, SAVE_INTERVAL_MS);
    return () => {
      clearInterval(id);
      // ここだけは dirty を無視して全タブ保存する (dirty は「返した＝保存した」と
      // みなして落とすため)。ただし上記のとおり本番ではまず走らない。
      saveAll();
    };
  }, []);
}

export function TerminalUpkeepRoot({ children }: { children: ReactNode }) {
  const { catalog } = useThemeView();
  useApplySettingsToRuntimes();
  useApplyThemeToRuntimes(catalog);
  useRecycleTextureAtlas();
  useSaveScrollback();
  return <>{children}</>;
}
