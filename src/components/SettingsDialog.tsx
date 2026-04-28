import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/appStore';
import type { Settings } from '../types';

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [draft, setDraft] = useState<Settings>(settings);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateSettings(draft);
    onClose();
  }

  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">Settings</Dialog.Title>
          <Dialog.Description className="dialog-description">
            フォント・スクロールバック・透明度を変更します。
          </Dialog.Description>
          <form onSubmit={handleSubmit} className="dialog-form">
            <label className="dialog-field">
              <span className="dialog-label">フォントサイズ (px)</span>
              <input
                className="dialog-input"
                type="number"
                min="8"
                max="48"
                value={draft.fontSize}
                onChange={(e) =>
                  setDraft({ ...draft, fontSize: parseFloat(e.target.value) || 14 })
                }
              />
            </label>

            <label className="dialog-field">
              <span className="dialog-label">フォントファミリ</span>
              <input
                className="dialog-input"
                type="text"
                value={draft.fontFamily}
                onChange={(e) => setDraft({ ...draft, fontFamily: e.target.value })}
                placeholder="例: 'MonaspiceNe NF', 'Cascadia Code', monospace"
              />
            </label>

            <label className="dialog-field">
              <span className="dialog-label">スクロールバック (行数)</span>
              <input
                className="dialog-input"
                type="number"
                min="100"
                max="100000"
                step="100"
                value={draft.scrollback}
                onChange={(e) =>
                  setDraft({ ...draft, scrollback: parseInt(e.target.value, 10) || 1000 })
                }
              />
            </label>

            <div className="dialog-field">
              <span className="dialog-label">
                背景透明度 (0.7〜1.0) — {(draft.transparency ?? 1.0).toFixed(2)}
              </span>
              <input
                className="settings-range"
                type="range"
                min="0.7"
                max="1"
                step="0.05"
                value={draft.transparency ?? 1.0}
                onChange={(e) =>
                  setDraft({ ...draft, transparency: parseFloat(e.target.value) })
                }
              />
              <small className="dialog-hint">
                透明度は frameless window モードでのみ有効です。
              </small>
            </div>

            <div className="dialog-actions">
              <button type="button" className="dialog-btn dialog-btn--cancel" onClick={onClose}>
                キャンセル
              </button>
              <button type="submit" className="dialog-btn dialog-btn--submit">
                保存
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
