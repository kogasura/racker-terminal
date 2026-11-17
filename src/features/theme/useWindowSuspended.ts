/**
 * 窓が見えていない（最小化中・文書が hidden）かを返す。見えていない間は背景を止める。
 *
 * 「背景を動かす」の設定とは別の、その場の状態（設定値は変えない）。フォーカスが外れた
 * だけでは止めない（ほかの窓の後ろでも、見えている部分は動いていてほしいため）。
 */

import { useEffect, useState } from 'react';
import { subscribeWindowMinimized } from '../../lib/windowMinimized';

/** 文書が hidden か。 */
function isDocumentHidden(): boolean {
  return document.visibilityState === 'hidden';
}

/**
 * @param subscribe - 最小化の状態の購読。テストで差し替える
 */
export function useWindowSuspended(
  subscribe: typeof subscribeWindowMinimized = subscribeWindowMinimized,
): boolean {
  const [minimized, setMinimized] = useState(false);
  const [hidden, setHidden] = useState(isDocumentHidden);

  useEffect(() => subscribe(setMinimized), [subscribe]);

  useEffect(() => {
    const update = () => setHidden(isDocumentHidden());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  return minimized || hidden;
}
