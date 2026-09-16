/**
 * 設定の Root。
 *
 * 設定そのものは永続化の対象で store が持ち続けるため、ここに Mediator の状態は
 * 無い。Root の役目は 2 つ:
 *
 *   1. 設定ダイアログへ現在値を View モデルとして配る
 *   2. 変更を受け取って store に反映し、画面全体に効く設定 (背景の透過) を適用する
 *
 * 透過の反映は以前 App.tsx の useEffect だった。設定に属する副作用なので、
 * 設定の Root が持つほうが探しやすい。
 */

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
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

/** 背景の透過。CSS で rgba() を動的に制御するために CSS 変数へ流す。 */
function applyTransparency(transparency: number | undefined): void {
  document.documentElement.style.setProperty('--bg-alpha', (transparency ?? 1.0).toString());
}

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

  useEffect(() => {
    applyTransparency(settings.transparency);
  }, [settings.transparency]);

  return (
    <EventScope<SettingsEvent> links={links}>
      <SettingsViewContext.Provider value={settings}>{children}</SettingsViewContext.Provider>
    </EventScope>
  );
}
