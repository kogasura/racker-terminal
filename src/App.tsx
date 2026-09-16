import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useAppStore } from './store/appStore';
import {
  getAllRuntimes,
  recycleTextureAtlas,
  getRuntimeScreen,
  getRuntimeScreenIfDirty,
} from './lib/terminalRegistry';
import { saveScrollback, pruneScrollback } from './lib/scrollback';
import { listWslDistros } from './lib/wsl';
import {
  listClaudeSessions,
  matchSessionsToTabs,
  freshSessions,
  adoptableTabIds,
  coveredTabIds,
  collectWslDistros,
  shouldPollWsl,
  type ClaudeSession,
} from './lib/claudeSessions';
import {
  getTranscriptMeta,
  getUsageLimits,
  shouldPollTranscript,
  shouldFetchUsage,
} from './lib/claudeMeta';
import { shouldNotify, notifyAgentState } from './lib/notifications';
import { getPrStatus, groupTabsByCwd, shouldPollPr } from './lib/prStatus';
import { getTabDisplayTitle, type AgentState, type Tab, type Settings } from './types';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { DragDropProvider } from './components/DragDropProvider';
import { TitleBar } from './components/TitleBar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import { StatusBar } from './components/StatusBar';
import { UpdaterRoot } from './features/updater/UpdaterRoot';
import { TabsRoot } from './features/tabs/TabsRoot';
import { useFileDropToTerminal } from './hooks/useFileDropToTerminal';
import { FileDropOverlay } from './components/FileDropOverlay';
import './styles/variables.css';
import './styles/title-bar.css';
import './styles/dropdown-menu.css';
import './styles/update-dialog.css';
import './styles/status-bar.css';

/** 通知判定に必要な store の断片。 */
interface NotifyState {
  tabs: Record<string, Tab>;
  settings: Settings;
  activeTabId: string | null;
}

/**
 * agentState が変わったタブについて、必要なら通知を出す。
 * prevStates は呼び出し側が持つ「直前の状態」の控えで、ここで最新値に更新する。
 *
 * テストのため export している（App 本体は描画を伴うので直接は回しにくい）。
 */
export function notifyChangedTabs(
  state: NotifyState,
  prevStates: Map<string, AgentState | undefined>,
): void {
  for (const [id, tab] of Object.entries(state.tabs)) {
    const prev = prevStates.get(id);
    if (prev === tab.agentState) continue;
    prevStates.set(id, tab.agentState);

    // 設定は通知の直前に読む。effect を張り直さずに ON/OFF を反映するため。
    if (state.settings.notificationsEnabled === false) continue;

    const kind = shouldNotify(prev, tab.agentState, id === state.activeTabId);
    if (kind !== null) {
      void notifyAgentState(kind, getTabDisplayTitle(tab), tab.waitingFor);
    }
  }
}

/**
 * 閉じられたタブを控えから外す。
 * タブ ID が再利用されることはないが、長時間の運用で Map が単調増加するのを防ぐ。
 *
 * テストのため export している。
 */
export function pruneClosedTabs(
  prevStates: Map<string, AgentState | undefined>,
  tabs: Record<string, Tab>,
): void {
  if (prevStates.size <= Object.keys(tabs).length) return;
  for (const id of prevStates.keys()) {
    if (!(id in tabs)) prevStates.delete(id);
  }
}

/**
 * アクティブタブで動いている Claude の会話ログを読み、モデル / effort /
 * コンテキスト量をステータスバーへ反映する。
 *
 * アクティブタブぶんしか読まない。会話ログは 50MB を超えることがあり、
 * 全タブぶんを数秒ごとに読むのは割に合わない（見えていないタブの
 * モデル名を知っても使い道がない）。
 *
 * セッションが紐づかないタブ（claude を起動していない・終了した）では
 * null を渡して表示を消す。
 *
 * テストのため export している。
 */
export async function refreshActiveTranscript(
  activeTabId: string | null,
  session: ClaudeSession | undefined,
): Promise<void> {
  if (activeTabId === null) return;

  if (session?.sessionId === undefined) {
    useAppStore.getState().setClaudeMeta(activeTabId, null);
    return;
  }
  const meta = await getTranscriptMeta(session.sessionId, session.cwd, session.distro);
  useAppStore.getState().setClaudeMeta(activeTabId, meta);
}

/**
 * この巡回でアクティブタブの会話ログを読み直してよいか。
 *
 * refreshActiveTranscript は「セッションが紐づかない = 表示を消す」まで担うため、
 * **見に行っていない範囲のタブに対して呼ぶと、見えている情報を消してしまう**。
 * WSL を間引いた tick では WSL タブのセッションが一覧に出ないので、
 * ステータスバーの表示が数秒ごとに点滅することになる。
 *
 * タブが 1 枚も無いとき (null) は「消す」処理そのものが要るので通す。
 */
function canReadTranscript(
  activeTabId: string | null,
  covered: ReadonlySet<string>,
  matches: ReadonlyMap<string, unknown>,
): boolean {
  if (activeTabId === null) return true;
  return covered.has(activeTabId) || matches.has(activeTabId);
}

function App() {
  const { isDragging } = useFileDropToTerminal();

  useEffect(() => {
    // persist の rehydrate 完了を待ってから自動初期化する。
    // 復元データがある場合は createGroup/createTab を呼ばない。
    // F-M6: StrictMode 二重 mount + persist hydrate タイミングで「グループはあるがタブ 0」
    //        のケースにも対応するよう条件を分岐させる。
    function initIfEmpty() {
      const { groups, tabs, createGroup, createTab } = useAppStore.getState();
      if (groups.length === 0) {
        // 全グループ空 → Default グループ作成 + タブ追加
        const groupId = createGroup('Default');
        createTab(groupId, { userTitle: 'Terminal' });
      } else if (Object.keys(tabs).length === 0) {
        // グループはあるがタブ 0 → 既存 groups[0] にタブ追加
        createTab(groups[0].id, { userTitle: 'Terminal' });
      }
    }

    // 既に hydrate 済みの場合（HMR 等）は即時チェック
    if (useAppStore.persist.hasHydrated()) {
      initIfEmpty();
      return;
    }

    // hydration 完了時に初期化する
    const unsub = useAppStore.persist.onFinishHydration(() => {
      initIfEmpty();
    });
    return unsub;
  }, []);

  // Settings が変化したとき全タブの xterm オプションをリアクティブに更新する。
  // subscribeWithSelector middleware は導入せず、前回値比較で settings の参照変化のみに反応させる。
  useEffect(() => {
    let prev = useAppStore.getState().settings;
    const unsub = useAppStore.subscribe((state) => {
      if (state.settings === prev) return;
      prev = state.settings;
      for (const r of getAllRuntimes()) r.applySettings(state.settings);
    });
    return unsub;
  }, []);

  // persist の hydration 完了。updater の初回チェックはこれを待ってから走らせる
  // (復元前に走らせると、まだ何も無い状態で更新ダイアログだけが出ることがある)。
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    const unsub = useAppStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, [hydrated]);

  // #5: WebGL のグリフキャッシュ (TextureAtlas) は全タブで共有されており、外からクリアすると
  // 他タブの頂点バッファが古い座標を指したままになって文字が化ける。クリアではなく
  // sleep/wake で renderer ごと作り直し、アトラスを解放・再生成する
  // （なぜそうするかの詳細は terminalRegistry の recycleTextureAtlas を参照）。
  //
  // 作り直しは 1 回あたり数十 ms メインスレッドを止める。10 分に一度なので均せば無視できるが、
  // 出力の最中に当たるとフレーム落ちが見えるのでアイドル時間へ寄せる。timeout は付けない:
  // 付けると「出力が続いていてアイドルが来ない」= いちばん避けたい状況で必ず割り込んでしまう。
  // アイドルが来なければその回は見送り、次の周期で改めて予約する。
  useEffect(() => {
    const RECYCLE_INTERVAL_MS = 10 * 60 * 1000; // 10 分
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

  // タブの画面内容を定期的に保存する。
  //
  // PTY のスクロールバックはプロセスと一蓮托生なので、再起動すると中身が失われる。
  // 定期的にシリアライズして保存しておき、復元時に書き戻す（TerminalPane 側）。
  //
  // 保存は「直前の作業が見える」ことが目的なので、間隔は粗くてよい。
  // 短くするとシリアライズのコストが毎回かかる。
  useEffect(() => {
    const SAVE_INTERVAL_MS = 30_000;

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
    // 上の 30 秒間隔がすべてで、それは変更前から変わらない。
    const saveAll = () => {
      for (const tabId of Object.keys(useAppStore.getState().tabs)) {
        const content = getRuntimeScreen(tabId);
        if (content !== null) void saveScrollback(tabId, content);
      }
    };

    // 起動時に、もう存在しないタブの保存ファイルを掃除する
    // （クラッシュ等で削除できなかったぶんが残り続けるため）
    const pruneOnce = () => {
      void pruneScrollback(Object.keys(useAppStore.getState().tabs));
    };
    if (useAppStore.persist.hasHydrated()) pruneOnce();
    else useAppStore.persist.onFinishHydration(pruneOnce);

    const id = setInterval(saveDirtyTabs, SAVE_INTERVAL_MS);
    return () => {
      clearInterval(id);
      // ここだけは dirty を無視して全タブ保存する（dirty は「返した＝保存した」と
      // みなして落とすため）。ただし上記のとおり本番ではまず走らない。
      saveAll();
    };
  }, []);

  // タブの作業ディレクトリに対応する GitHub PR の状態を定期的に引く。
  //
  // 「Claude に作らせた PR がマージされたか」がタブを見るだけで分かるようにする。
  // gh はネットワークを伴うので間隔は長め、かつ cwd 単位で 1 回だけ叩く。
  useEffect(() => {
    const POLL_INTERVAL_MS = 30_000;
    let cancelled = false;
    // 前回の実行が終わるまで次を出さない。gh が遅いときに要求が積み上がるのを防ぐ。
    let running = false;
    // ウィンドウが前面にあるか。裏に回っている間は引かない（shouldPollPr 参照）。
    // 初期値 true は「フォーカスイベントが来る前でも 1 回目は引く」ため。
    let focused = true;
    let hasEverPolled = false;
    let unlistenFocus: (() => void) | null = null;

    const tick = async () => {
      if (running) return;
      if (!shouldPollPr(focused, hasEverPolled)) return;
      running = true;
      hasEverPolled = true;
      try {
        const tabList = Object.values(useAppStore.getState().tabs);
        for (const [cwd, tabIds] of groupTabsByCwd(tabList)) {
          if (cancelled) return;
          const pr = await getPrStatus(cwd);
          if (cancelled) return;
          useAppStore.getState().applyPrStatus(tabIds, pr);
        }
      } finally {
        running = false;
      }
    };

    // フォーカスの変化を追う。裏に回っている間は引かず、戻ってきた時点で
    // すぐ引き直す（次の 30 秒を待たずにバッジを最新にするため）。
    void (async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onFocusChanged(({ payload }) => {
          const wasFocused = focused;
          focused = payload;
          if (!wasFocused && focused) void tick();
        });
        if (cancelled) fn();
        else unlistenFocus = fn;
      } catch (e) {
        // フォーカスを追えない環境では、従来どおり常に引く方へ倒す
        // （バッジが更新されないより、余分に引くほうがまし）
        console.warn('[App] onFocusChanged failed, PR polling stays always-on:', e);
        focused = true;
      }
    })();

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      unlistenFocus?.();
    };
  }, []);

  // Claude タブの状態変化をデスクトップ通知で知らせる。
  //
  // サイドバーのステータスドットは racker のウィンドウを見ていないと意味がない。
  // 別のアプリで作業している間に Claude が応答待ちで止まっていることに気付けるよう、
  // 応答待ち / 完了になった瞬間だけトーストを出す。
  useEffect(() => {
    // 直前の状態。差分が出たタブだけを通知対象にする。
    const prevStates = new Map<string, AgentState | undefined>();
    let initialized = false;

    const unsub = useAppStore.subscribe((state) => {
      // 初回は現在の状態を控えるだけにする。
      // 起動直後は全タブが「未検出 → 何か」の遷移に見えるため、
      // これをしないと復元したタブの数だけ通知が飛ぶ。
      if (!initialized) {
        for (const [id, tab] of Object.entries(state.tabs)) {
          prevStates.set(id, tab.agentState);
        }
        initialized = true;
        return;
      }

      notifyChangedTabs(state, prevStates);
      pruneClosedTabs(prevStates, state.tabs);
    });
    return unsub;
  }, []);

  // Claude Code のセッションファイルを定期的に読み、タブと突き合わせる。
  //
  // これにより (1) ユーザーが自分で `claude` と打ったタブのセッション ID を特定して
  // 再起動後の resume 対象にでき、(2) タブの状態を画面パターンの推測ではなく
  // Claude 自身が申告した status から決められる。
  //
  // ファイル読み取りが失敗する環境（Claude 未使用・形式変更）では null が返り、
  // 何も反映せずに従来どおり画面パターン判定へフォールバックする。
  // 「取得できて 0 件」（= claude が 1 つも動いていない）とは区別する必要がある。
  // 後者は「ユーザーが自分で /exit した」という観測であり、反映しないと
  // 再起動時に終了済みのセッションを復元してしまう。
  useEffect(() => {
    const POLL_INTERVAL_MS = 2000;
    let cancelled = false;
    // WSL 側を間引くための通し番号（shouldPollWsl 参照）
    let tickCount = 0;
    // 前回が終わるまで次を出さない。WSL 側は `\\wsl.localhost\` 越しで
    // 1 回に数秒かかることがあり、2 秒間隔だと要求が積み上がってしまう。
    let running = false;

    const pollOnce = async () => {
      const before = useAppStore.getState();
      const tabList = Object.values(before.tabs);
      // 実際に開いている WSL タブの distro だけを渡す。
      // 使っていない distro を渡すと、停止中の WSL をポーリングのたびに起こしてしまう。
      //
      // さらに、開いている distro であっても毎回は見に行かない。
      // `\\wsl.localhost\` へのアクセスは 9P 越しで高く、2 秒ごとに触ると
      // WSL が眠れなくなる。Windows 側だけ 2 秒、WSL 側は 10 秒に 1 回にする。
      const currentTick = tickCount;
      const wslPolled = shouldPollWsl(currentTick);
      const distros = wslPolled ? collectWslDistros(tabList) : [];
      tickCount += 1;

      const raw = await listClaudeSessions(distros);
      // 弾くのは取得失敗（null）だけで、0 件（= claude が 1 つも動いていない）は通す。
      // 0 件で早期 return すると「ユーザーが自分で /exit した」という、
      // 復元してよいかを決める最重要の観測を取りこぼす（claudeSessionLive が false に落ちない）。
      // 逆に失敗まで通すと、invoke が一度こけただけで全タブが「消えた」扱いになる。
      if (cancelled || raw === null) return;

      // 照合の **前に** 亡霊セッションを落とす。WSL では claude が強制終了しても
      // セッションファイルが消えず、数ヶ月前の死んだ json が残り続けるため、
      // ここで落とさないと状態ドットの表示も resume の対象も同じだけ引きずられる。
      const sessions = freshSessions(raw, Date.now());

      // await の前後で store が変化しうるので、照合には最新のタブ一覧を使う
      const after = useAppStore.getState();
      const tabsForMatch = Object.values(after.tabs).map((t) => ({
        id: t.id,
        cwd: t.cwd,
        args: t.args,
        claudeSessionId: t.claudeSessionId,
        // `-d` を書いていない WSL タブ（既定 distro）を Windows 側と混同しないために要る
        shell: t.shell,
      }));
      const matches = matchSessionsToTabs(sessions, tabsForMatch);
      // 表示（状態ドット）は従来どおり緩い cwd 一致のまま、
      // 復元の根拠になる書き込みだけを adoptable で絞る。
      // covered には「この巡回で実際に見に行った範囲」を渡す。WSL を間引いた tick では
      // distros が空になるので、見ていない WSL タブを「消えた」と誤判定せずに済む。
      const covered = coveredTabIds(tabsForMatch, distros);
      after.applyClaudeSessions(matches, {
        adoptable: adoptableTabIds(sessions, tabsForMatch, matches),
        covered,
      });

      // ついでにアクティブタブの会話ログも読む（セッション ID と cwd がここで揃うため）。
      // セッションの巡回より頻度を落とす: モデルや effort はめったに変わらず、
      // WSL タブでは 9P 越しのファイル読み取りになるため。
      //
      // **この巡回で見に行っていないタブでは読み直さない。** WSL を間引いた tick では
      // WSL タブのセッションが一覧に出ないため、そのまま呼ぶと「セッションが無い」と
      // 判断して claudeMeta を null にし、ステータスバーのモデル / コンテキスト表示が
      // 数秒ごとに消える（applyClaudeSessions 側の covered と同じ理屈）。
      if (shouldPollTranscript(currentTick) && !cancelled && canReadTranscript(after.activeTabId, covered, matches)) {
        const activeTabId = after.activeTabId;
        await refreshActiveTranscript(
          activeTabId,
          activeTabId === null ? undefined : matches.get(activeTabId),
        );
      }
    };

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await pollOnce();
      } finally {
        running = false;
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // プランの利用量（5 時間ウィンドウ / 週次）を定期的に引く。
  //
  // 「あと何割使えるか」を Claude Code の中で調べるには `/usage` を打つ必要があり、
  // そのたびに会話が中断する。racker はタブの外にいるので、黙って出しておける。
  //
  // Anthropic の API を叩くため、間隔は分単位で十分に長く取る（利用率は
  // 分単位でしか動かない）。裏に回っているあいだは引かず、前面に戻ったときは
  // 引き直すが、最小間隔を置く（ウィンドウを行き来するだけで叩き続けないため）。
  useEffect(() => {
    const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 分
    let cancelled = false;
    let running = false;
    // 初期値 true は「フォーカスイベントが来る前でも 1 回目は引く」ため（PR 取得と同じ）
    let focused = true;
    let hasEverPolled = false;
    let lastFetchedAt = 0;
    let unlistenFocus: (() => void) | null = null;

    const tick = async () => {
      if (running) return;
      if (!shouldFetchUsage(focused, hasEverPolled, Date.now() - lastFetchedAt)) return;
      running = true;
      hasEverPolled = true;
      try {
        const usage = await getUsageLimits();
        if (!cancelled) useAppStore.getState().setClaudeUsage(usage);
      } finally {
        lastFetchedAt = Date.now();
        running = false;
      }
    };

    // 前面に戻ってきたら引き直す。裏にいるあいだに使った分を反映するため
    // （別のウィンドウで動かしている Claude Code の消費もここに乗る）。
    void (async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onFocusChanged(({ payload }) => {
          const wasFocused = focused;
          focused = payload;
          if (!wasFocused && focused) void tick();
        });
        if (cancelled) fn();
        else unlistenFocus = fn;
      } catch (e) {
        // フォーカスを追えない環境では、5 分間隔の定期取得だけに任せる
        console.warn('[App] onFocusChanged failed, usage polling stays interval-only:', e);
        focused = true;
      }
    })();

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      unlistenFocus?.();
    };
  }, []);

  // App 起動時に WSL distro 一覧を取得して store に保存する。
  // Phase 4 P-K で追加。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const distros = await listWslDistros();
      if (!cancelled) {
        useAppStore.getState().setWslDistros(distros);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Windows Explorer「Racker Terminal で開く」からの起動フォルダを処理する。
  // - 初回起動: get_launch_path で argv のフォルダを取得して開く
  // - 起動済みへの再起動 (single-instance): open-path イベントで受け取って開く
  // いずれも spawnAtPath でタブを開くため、persist の rehydrate 完了を待ってから実行する
  // （hydrate 前に createTab するとフォルダタブが復元データで上書きされてしまうため）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const openPath = (path: unknown) => {
      if (typeof path === 'string' && path.trim().length > 0) {
        useAppStore.getState().spawnAtPath(path);
      }
    };

    const start = async () => {
      // 起動時 argv のフォルダを開く（通常起動や引数なしでは null が返る）
      try {
        const initial = await invoke<string | null>('get_launch_path');
        if (!cancelled) openPath(initial);
      } catch (e) {
        console.warn('[launch] get_launch_path failed:', e);
      }
      // 起動済みインスタンスへ転送される open-path イベントを購読する
      try {
        const off = await listen<string>('open-path', (event) => openPath(event.payload));
        if (cancelled) off();
        else unlisten = off;
      } catch (e) {
        console.warn('[launch] listen(open-path) failed:', e);
      }
    };

    if (useAppStore.persist.hasHydrated()) {
      void start();
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    }
    const unsub = useAppStore.persist.onFinishHydration(() => {
      void start();
    });
    return () => {
      cancelled = true;
      unsub();
      if (unlisten) unlisten();
    };
  }, []);

  // Settings の transparency を CSS 変数 --bg-alpha に反映する。
  // CSS で rgba() を動的に制御するために使用する。
  // Phase 4 P-B-2 で追加。
  useEffect(() => {
    // 初期値を即時反映
    const initialAlpha = useAppStore.getState().settings.transparency ?? 1.0;
    document.documentElement.style.setProperty('--bg-alpha', initialAlpha.toString());

    const unsub = useAppStore.subscribe((state) => {
      const t = state.settings.transparency ?? 1.0;
      document.documentElement.style.setProperty('--bg-alpha', t.toString());
    });
    return unsub;
  }, []);

  return (
    // updater 機能の Root。バッジ (タイトルバー内) と設定セクション (設定ダイアログ内) が
    // 離れた場所に出るため、両方を含む位置でコンテキストの親になる必要がある。
    <UpdaterRoot ready={hydrated}>
    <TabsRoot>
    <div className="app-root">
      <TitleBar />
      <div className="app-body">
        {/* D&D は Sidebar と TabBar をまたぐため、両方を包む位置に DndContext を置く
            (TabBar のタブをサイドバーのグループ行へドロップして移動できるようにする) */}
        <DragDropProvider>
          <Sidebar />
          <div className="main-column">
            <TabBar />
            <TerminalPaneContainer />
          </div>
        </DragDropProvider>
        <FileDropOverlay isDragging={isDragging} />
      </div>
      {/* サイドバーの下まで通す全幅の 1 行。出すものが無いときは自身で消える */}
      <StatusBar />
    </div>
    </TabsRoot>
    </UpdaterRoot>
  );
}

export default App;
