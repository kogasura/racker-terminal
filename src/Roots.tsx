/**
 * アプリ全体の Root 構成。
 *
 * 機能ごとの Root をここでまとめて敷き、**`App` を含むすべてのコンポーネントを
 * その配下に置く**。`App` 自身も副作用の中からイベントを流す (会話ログを読めたら
 * ステータスバーへ渡す、など) ため、Root の内側に居る必要がある。
 *
 * Root どうしの順序は問わない。各 Root は自分宛ての接頭辞のイベントだけを取り、
 * 残りを上へ流すので、どう重ねても他機能のイベントを飲み込まない
 * (`architecture/chain.ts` の `mediatorLink` を参照)。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { BootstrapRoot } from './features/bootstrap/BootstrapRoot';
import { ClaudeSessionsRoot } from './features/claudeSessions/ClaudeSessionsRoot';
import { ClaudeStatusRoot } from './features/claudeStatus/ClaudeStatusRoot';
import { LaunchRoot } from './features/launch/LaunchRoot';
import { NotificationsRoot } from './features/notifications/NotificationsRoot';
import { PrStatusRoot } from './features/prStatus/PrStatusRoot';
import { SettingsRoot } from './features/settings/SettingsRoot';
import { TerminalUpkeepRoot } from './features/terminalUpkeep/TerminalUpkeepRoot';
import { TabsRoot } from './features/tabs/TabsRoot';
import { UpdaterRoot } from './features/updater/UpdaterRoot';
import { useAppStore } from './store/appStore';

export function Roots({ children }: { children: ReactNode }) {
  // persist の hydration 完了。updater の初回チェックはこれを待ってから走らせる
  // (復元前に走らせると、まだ何も無い状態で更新ダイアログだけが出ることがある)。
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    return useAppStore.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  return (
    <UpdaterRoot ready={hydrated}>
      <SettingsRoot>
        <TabsRoot>
          <ClaudeStatusRoot>
            <ClaudeSessionsRoot>
              <TerminalUpkeepRoot>
                <PrStatusRoot>
                  <NotificationsRoot>
                    <BootstrapRoot>
                      <LaunchRoot>{children}</LaunchRoot>
                    </BootstrapRoot>
                  </NotificationsRoot>
                </PrStatusRoot>
              </TerminalUpkeepRoot>
            </ClaudeSessionsRoot>
          </ClaudeStatusRoot>
        </TabsRoot>
      </SettingsRoot>
    </UpdaterRoot>
  );
}
