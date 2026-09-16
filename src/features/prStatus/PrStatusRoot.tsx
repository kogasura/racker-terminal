/**
 * タブの作業ディレクトリに対応する GitHub PR の状態を引く Root。
 *
 * 「Claude に作らせた PR がマージされたか」がタブを見るだけで分かるようにする。
 * gh はネットワークを伴うので間隔は長め、かつ cwd 単位で 1 回だけ叩く。
 *
 * 結果はタブに紐づく表示情報なので、いまは store の applyPrStatus へ流している
 * (バッジの描画は TabItem の View モデルが担当)。
 */

import { useEffect, type ReactNode } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getPrStatus, groupTabsByCwd, shouldPollPr } from '../../lib/prStatus';
import { useAppStore } from '../../store/appStore';

const POLL_INTERVAL_MS = 30_000;

export function PrStatusRoot({ children }: { children: ReactNode }) {
  useEffect(() => {
    let cancelled = false;
    // 前回の実行が終わるまで次を出さない。gh が遅いときに要求が積み上がるのを防ぐ。
    let running = false;
    // ウィンドウが前面にあるか。裏に回っている間は引かない (shouldPollPr 参照)。
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
    // すぐ引き直す (次の 30 秒を待たずにバッジを最新にするため)。
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
        // (バッジが更新されないより、余分に引くほうがまし)
        console.warn('[pr-status] onFocusChanged failed, polling stays always-on:', e);
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

  return <>{children}</>;
}
