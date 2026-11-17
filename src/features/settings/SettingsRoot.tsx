/**
 * 設定の Root。
 *
 * 設定そのものは永続化の対象で store が持ち続けるため、ここに Mediator の状態は
 * 無い。Root の役目は 2 つ:
 *
 *   1. 設定ダイアログへ現在値を View モデルとして配る
 *   2. 変更を受け取って store に反映する
 *
 * 背景の透過とテーマの色の反映は ThemeRoot が持つ（透過を掛けた背景の変数を
 * テーマの色と一緒に計算するため）。
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { EventScope, mediatorLink, type Link } from '../../architecture/chain';
import { useAppStore } from '../../store/appStore';
import type { Settings } from '../../types';
import type { SettingsEvent } from './events';

const SettingsViewContext = createContext<Settings | null>(null);

/** 設定の現在値。 */
export function useSettingsView(): Settings {
  const settings = useContext(SettingsViewContext);
  if (!settings) throw new Error('useSettingsView は SettingsRoot の内側でしか使えません。');
  return settings;
}

const traceLink: Link<SettingsEvent> = (event, next) => {
  if (import.meta.env.DEV) console.debug('[settings] event:', event.type);
  next(event);
};

export function SettingsRoot({ children }: { children: ReactNode }) {
  const settings = useAppStore((s) => s.settings);

  const links = useMemo<readonly Link<SettingsEvent>[]>(
    () => [
      traceLink,
      mediatorLink('settings/', (event) => {
        // 変わったぶんだけを重ねる。ダイアログを開いている間に外から変わった値を消さない。
        const current = useAppStore.getState().settings;
        useAppStore.getState().updateSettings({ ...current, ...event.patch });
      }),
    ],
    [],
  );

  return (
    <EventScope<SettingsEvent> links={links}>
      <SettingsViewContext.Provider value={settings}>{children}</SettingsViewContext.Provider>
    </EventScope>
  );
}
