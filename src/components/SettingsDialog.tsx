import { useState, useEffect, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore } from '../store/appStore';
import type { Settings } from '../types';

type ManualCheckResult = 'none' | 'no-update' | 'found' | 'error';

interface SettingsDialogProps {
  onClose: () => void;
}

// F-M2: 入力値クランプ用定数
const FONT_MIN = 8;
const FONT_MAX = 48;
const SCROLLBACK_MIN = 100;
const SCROLLBACK_MAX = 100000;
const TRANSPARENCY_MIN = 0.7;
const TRANSPARENCY_MAX = 1.0;

/**
 * 数値を [min, max] にクランプする純関数。
 * NaN / Infinity / -Infinity は fallback を返す。
 * F-M2: コピペや IME 経由の範囲外値を防止する。
 */
function clamp(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updatePhase = useAppStore((s) => s.updatePhase);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const runUpdateCheck = useAppStore((s) => s.runUpdateCheck);
  const openUpdateDialog = useAppStore((s) => s.openUpdateDialog);

  const [draft, setDraft] = useState<Settings>(settings);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [manualCheckResult, setManualCheckResult] = useState<ManualCheckResult>('none');

  // Tauri アプリのバージョンを取得 (Cargo.toml の version)。
  // Tauri 環境外 (vite dev / テスト) では失敗するため、catch でフォールバックする。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await getVersion();
        if (!cancelled) setAppVersion(v);
      } catch (e) {
        console.warn('[settings] getVersion failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // F-S3: ダイアログを開いている間に外部から settings が変わった場合の lost update を防ぐ。
  // 案B: patch ベースで diff のみ送るため、draft stale は submit 時に解決する。
  // settings の参照変化を監視して draft を同期する（案A 相当の安全網として追加）。
  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // F-S3 案B: patch ベースで diff のみ updateSettings に渡す（lost update 解消）
    // F-M2: 各フィールドを clamp してから比較する
    const patch: Partial<Settings> = {};

    const sanitizedFontSize = clamp(draft.fontSize, FONT_MIN, FONT_MAX, 14);
    if (sanitizedFontSize !== settings.fontSize) patch.fontSize = sanitizedFontSize;

    if (draft.fontFamily !== settings.fontFamily) patch.fontFamily = draft.fontFamily;

    const sanitizedScrollback = clamp(draft.scrollback, SCROLLBACK_MIN, SCROLLBACK_MAX, 1000);
    if (sanitizedScrollback !== settings.scrollback) patch.scrollback = sanitizedScrollback;

    const sanitizedTransparency = clamp(
      draft.transparency ?? 1.0,
      TRANSPARENCY_MIN,
      TRANSPARENCY_MAX,
      1.0,
    );
    if (sanitizedTransparency !== (settings.transparency ?? 1.0)) {
      patch.transparency = sanitizedTransparency;
    }

    if (Object.keys(patch).length > 0) {
      updateSettings({ ...settings, ...patch });
    }

    onClose();
  }

  async function handleCheckUpdate() {
    // 既に DL 完了済み → 既存の UpdateDialog を開いてユーザーに再起動を促す
    if (updatePhase === 'ready' || updatePhase === 'error') {
      openUpdateDialog();
      onClose();
      return;
    }

    // チェック中 / DL 中 / インストール中は no-op (ボタン側で disabled にもしている)
    if (updatePhase !== 'idle') return;

    setManualCheckResult('none');
    try {
      await runUpdateCheck();
    } catch (e) {
      console.warn('[settings] runUpdateCheck failed:', e);
      setManualCheckResult('error');
      return;
    }

    // runUpdateCheck 後、updateInfo が入っていれば更新あり (DL 中 or ready)
    const after = useAppStore.getState();
    if (after.updateInfo) {
      setManualCheckResult('found');
    } else {
      setManualCheckResult('no-update');
    }
  }

  // updater スライスの状態からボタンの表示を決める
  const isChecking = updatePhase === 'checking';
  const isDownloading = updatePhase === 'downloading';
  const isInstalling = updatePhase === 'installing';
  const checkBtnLabel = (() => {
    if (isChecking) return '確認中…';
    if (isDownloading) return 'ダウンロード中…';
    if (isInstalling) return 'インストール中…';
    if (updatePhase === 'ready') return '再起動して適用';
    if (updatePhase === 'error') return 'エラー詳細を表示';
    return 'アップデートを確認';
  })();
  const checkBtnDisabled = isChecking || isDownloading || isInstalling;

  function renderCheckResultMessage() {
    if (updatePhase === 'ready' && updateInfo) {
      return (
        <small className="dialog-hint">
          v{updateInfo.version} の準備ができています。
        </small>
      );
    }
    if (manualCheckResult === 'no-update') {
      return <small className="dialog-hint">最新バージョンです。</small>;
    }
    if (manualCheckResult === 'found' && updateInfo) {
      return (
        <small className="dialog-hint">
          v{updateInfo.version} が見つかりました。ダウンロード後にお知らせします。
        </small>
      );
    }
    if (manualCheckResult === 'error') {
      return <small className="dialog-hint">確認に失敗しました。ネットワークを確認してください。</small>;
    }
    return null;
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

            <div className="dialog-field">
              <span className="dialog-label">バージョン情報</span>
              <div className="settings-version-row">
                <span className="settings-version-text">
                  現在のバージョン: {appVersion ?? '—'}
                </span>
                <button
                  type="button"
                  className="dialog-btn dialog-btn--cancel"
                  onClick={() => void handleCheckUpdate()}
                  disabled={checkBtnDisabled}
                >
                  {checkBtnLabel}
                </button>
              </div>
              {renderCheckResultMessage()}
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
