import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Favorite } from '../types';

interface FavoriteDialogProps {
  mode: 'add' | 'edit';
  /** edit モードのとき既存値で prefill する */
  initial?: Favorite;
  onSubmit: (data: Omit<Favorite, 'id'>) => void;
  onClose: () => void;
}

export function FavoriteDialog({ mode, initial, onSubmit, onClose }: FavoriteDialogProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [shell, setShell] = useState(initial?.shell ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [envText, setEnvText] = useState(
    initial?.env
      ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n')
      : '',
  );
  const [defaultTabTitle, setDefaultTabTitle] = useState(initial?.defaultTabTitle ?? '');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;  // title 必須

    // env のパース: "KEY=VALUE" を 1 行ずつ
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key) env[key] = value;
    }

    onSubmit({
      title: title.trim(),
      shell: shell.trim() || undefined,
      cwd: cwd.trim() || undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      defaultTabTitle: defaultTabTitle.trim() || undefined,
    });
  }

  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">
            {mode === 'add' ? 'お気に入りを追加' : 'お気に入りを編集'}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="dialog-form">
            <label className="dialog-field">
              <span className="dialog-label">
                タイトル <span className="dialog-required">*</span>
              </span>
              <input
                className="dialog-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                autoFocus
                placeholder="お気に入り名"
              />
            </label>

            <label className="dialog-field">
              <span className="dialog-label">
                Shell (例: <code>wsl.exe</code>, <code>pwsh.exe</code>, <code>cmd.exe</code>)
              </span>
              <input
                className="dialog-input"
                value={shell}
                onChange={(e) => setShell(e.target.value)}
                placeholder="(空 = nushell デフォルト)"
              />
            </label>

            <label className="dialog-field">
              <span className="dialog-label">
                CWD (例: <code>C:\Users\foo\projects</code>)
              </span>
              <input
                className="dialog-input"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="(空 = ホーム)"
              />
            </label>

            <label className="dialog-field">
              <span className="dialog-label">
                環境変数 (1 行 1 件、<code>KEY=VALUE</code> 形式)
              </span>
              <textarea
                className="dialog-textarea"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                rows={4}
                placeholder={"例:\nPATH=C:\\custom\\bin;%PATH%\nNODE_ENV=development"}
              />
            </label>

            <label className="dialog-field">
              <span className="dialog-label">
                タブ名のデフォルト (お気に入りタイトルと別にしたい場合)
              </span>
              <input
                className="dialog-input"
                value={defaultTabTitle}
                onChange={(e) => setDefaultTabTitle(e.target.value)}
                placeholder="(空 = タイトルを使用)"
              />
            </label>

            <div className="dialog-actions">
              <button type="button" className="dialog-btn dialog-btn--cancel" onClick={onClose}>
                キャンセル
              </button>
              <button type="submit" className="dialog-btn dialog-btn--submit">
                {mode === 'add' ? '追加' : '保存'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
