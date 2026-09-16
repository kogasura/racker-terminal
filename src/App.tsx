import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from './store/appStore';
import { useEmit } from './architecture/chain';
import type { ClaudeStatusEvent } from './features/claudeStatus/events';
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
  shouldPollTranscript,
  type ClaudeTranscriptMeta,
} from './lib/claudeMeta';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { DragDropProvider } from './components/DragDropProvider';
import { TitleBar } from './components/TitleBar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import { StatusBar } from './components/StatusBar';
import { useFileDropToTerminal } from './hooks/useFileDropToTerminal';
import { FileDropOverlay } from './components/FileDropOverlay';
import './styles/variables.css';
import './styles/title-bar.css';
import './styles/dropdown-menu.css';
import './styles/update-dialog.css';
import './styles/status-bar.css';

/**
 * アクティブタブで動いている Claude の会話ログを読み、モデル / effort /
 * コンテキスト量を返す。ステータスバーへ渡すのは呼び出し側。
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
export async function readActiveTranscript(
  session: ClaudeSession | undefined,
): Promise<ClaudeTranscriptMeta | null> {
  // セッションが紐づかない (claude を起動していない・終了した) なら表示を消す
  if (session?.sessionId === undefined) return null;
  return getTranscriptMeta(session.sessionId, session.cwd, session.distro);
}

/**
 * この巡回でアクティブタブの会話ログを読み直してよいか。
 *
 * readActiveTranscript は「セッションが紐づかない = null (表示を消す)」を返すため、
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

  // 会話ログを読めた結果をステータスバーへ流す。巡回は長命な effect の中で回るので、
  // 最新の emit を ref 越しに読む (依存に入れると巡回ごと張り直しになる)。
  const emit = useEmit<ClaudeStatusEvent>();
  const emitRef = useRef(emit);
  emitRef.current = emit;

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

    /**
     * アクティブタブの会話ログを読んでステータスバーへ流す。
     *
     * セッションの巡回より頻度を落とす: モデルや effort はめったに変わらず、
     * WSL タブでは 9P 越しのファイル読み取りになるため。
     *
     * **この巡回で見に行っていないタブでは読み直さない。** WSL を間引いた tick では
     * WSL タブのセッションが一覧に出ないため、そのまま呼ぶと「セッションが無い」と
     * 判断して表示を消してしまい、モデル / コンテキスト表示が数秒ごとに消える
     * （applyClaudeSessions 側の covered と同じ理屈）。
     */
    const pollTranscript = async (
      currentTick: number,
      activeTabId: string | null,
      covered: ReadonlySet<string>,
      matches: Map<string, ClaudeSession>,
    ) => {
      if (activeTabId === null) return;
      if (!shouldPollTranscript(currentTick)) return;
      if (cancelled || !canReadTranscript(activeTabId, covered, matches)) return;

      const meta = await readActiveTranscript(matches.get(activeTabId));
      if (cancelled) return;
      emitRef.current({ type: 'claude-status/meta-observed', tabId: activeTabId, meta });
    };

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

      // ついでにアクティブタブの会話ログも読み、ステータスバーへ流す。
      await pollTranscript(currentTick, after.activeTabId, covered, matches);
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

  return (
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
  );
}

export default App;
