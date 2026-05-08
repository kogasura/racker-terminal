import { useEffect, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useAppStore } from '../store/appStore';
import { getRuntime } from '../lib/terminalRegistry';
import { formatDroppedPaths } from '../lib/dragDropPath';

export function useFileDropToTerminal(): { isDragging: boolean } {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onDragDropEvent((event) => {
          const payload = event.payload;
          switch (payload.type) {
            case 'enter':
            case 'over':
              setIsDragging(true);
              break;
            case 'leave':
              setIsDragging(false);
              break;
            case 'drop':
              setIsDragging(false);
              handleDrop(payload.paths);
              break;
          }
        });
        if (cancelled) {
          // useEffect cleanup が await 中に走った場合は即時 unlisten
          fn();
        } else {
          unlisten = fn;
        }
      } catch (e) {
        console.error('[useFileDropToTerminal] onDragDropEvent failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { isDragging };
}

function handleDrop(paths: string[]): void {
  if (paths.length === 0) return;
  const state = useAppStore.getState();
  const activeTabId = state.activeTabId;
  if (!activeTabId) return;
  const tab = state.tabs[activeTabId];
  if (!tab) return;
  const isWsl = tab.shell === 'wsl.exe';
  const formatted = formatDroppedPaths(paths, isWsl);
  if (!formatted) return;
  const runtime = getRuntime(activeTabId);
  if (!runtime) return;
  runtime.writeInput(formatted);
}
