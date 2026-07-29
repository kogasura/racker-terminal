import { useState, useMemo, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useShallow } from 'zustand/shallow';
import type { Favorite } from '../types';
import {
  buildProfileTemplates,
  findTemplate,
  isWslShell,
  buildWslArgs,
  parseWslArgs,
  isStandardWslArgs,
} from '../lib/profileTemplates';
import { useAppStore } from '../store/appStore';

interface FavoriteDialogProps {
  mode: 'add' | 'edit';
  /** edit モードのとき既存値で prefill する */
  initial?: Favorite;
  onSubmit: (data: Omit<Favorite, 'id'>) => void;
  onClose: () => void;
}

/**
 * args テキストをパースする純関数。
 * 1 行 1 件の形式を受け取り、引数配列を返す。
 * 空行・前後空白のみの行はスキップされる。
 * テスト容易性のため export する。
 */
export function parseArgsText(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * env テキストをパースする純関数。
 * 1 行 1 件の "KEY=VALUE" 形式を受け取り、env オブジェクトとエラーリストを返す。
 * KEY は POSIX 慣例 [A-Za-z_][A-Za-z0-9_]* に準拠していること。
 * テスト容易性のため export する。
 */
export function parseEnvText(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      errors.push(`L${i + 1}: '=' が見つかりません`);
      return;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // F-S3: POSIX env 慣例: [A-Za-z_][A-Za-z0-9_]*
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`L${i + 1}: KEY が無効 (${key})`);
      return;
    }
    env[key] = value;
  });
  return { env, errors };
}

export function FavoriteDialog({ mode, initial, onSubmit, onClose }: FavoriteDialogProps) {
  const wslDistros = useAppStore(useShallow((s) => s.wslDistros));
  const templates = useMemo(() => buildProfileTemplates(wslDistros), [wslDistros]);

  const [title, setTitle] = useState(initial?.title ?? '');
  const [shell, setShell] = useState(initial?.shell ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [argsText, setArgsText] = useState(initial?.args?.join('\n') ?? '');

  // WSL 専用フィールド: distro と作業ディレクトリ (Linux パス) を args の代わりに編集する。
  // 編集モードで既存の WSL お気に入りを開いたときは args から distro / dir を復元する。
  const initialWslStandard = isWslShell(initial?.shell) && isStandardWslArgs(initial?.args);
  const initialWslParsed = parseWslArgs(initial?.args);
  const [wslDistro, setWslDistro] = useState(initialWslStandard ? initialWslParsed.distro : '');
  const [wslCwd, setWslCwd] = useState(initialWslStandard ? initialWslParsed.dir : '');
  // 既存 WSL お気に入りの args が標準形でない (`--` 等を含む) 場合のみ手動引数モードで開く。
  const [wslManual, setWslManual] = useState(
    isWslShell(initial?.shell) && !isStandardWslArgs(initial?.args),
  );
  const [envText, setEnvText] = useState(
    initial?.env
      ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n')
      : '',
  );
  const [defaultTabTitle, setDefaultTabTitle] = useState(initial?.defaultTabTitle ?? '');
  const [launchClaude, setLaunchClaude] = useState(initial?.launchClaude ?? false);
  const [bypassPermissions, setBypassPermissions] = useState(initial?.bypassPermissions ?? false);
  // F-S3: env パースエラー表示用 state
  const [envError, setEnvError] = useState<string | null>(null);

  // 現在の shell が WSL かどうか。WSL のときは distro / 作業ディレクトリの専用フィールドを出す。
  const isWsl = isWslShell(shell);
  // distro ドロップダウンの選択肢 (インストール済 distro + 現在値で未収載のもの)。
  const distroOptions = useMemo(() => {
    const set = [...wslDistros];
    if (wslDistro && !set.includes(wslDistro)) set.unshift(wslDistro);
    return set;
  }, [wslDistros, wslDistro]);

  /** テンプレート選択時に shell・title・args を自動入力する (Phase 4 P-I で追加、P-K で動的化) */
  function applyTemplate(id: string) {
    const tpl = findTemplate(templates, id);
    if (!tpl) return;
    setShell(tpl.shell);
    // title は空のときのみ上書き (edit モードでカスタムタイトルを保護)
    if (!title.trim()) setTitle(tpl.title);
    // テンプレに args が定義されていれば常に上書き (ユーザー意図的選択)
    if (tpl.args) setArgsText(tpl.args.join('\n'));
    // WSL テンプレなら専用フィールド (distro / 作業dir) にも反映し、手動モードを解除する。
    if (isWslShell(tpl.shell)) {
      const { distro, dir } = parseWslArgs(tpl.args);
      setWslDistro(distro);
      setWslCwd(dir);
      setWslManual(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;  // title 必須

    // args / cwd の決定:
    // - WSL かつ専用フィールド使用時は distro + 作業ディレクトリから args を組み立て、
    //   Windows 側 cwd は送らない (WSL の着地点は `--cd` が決めるため)。
    // - それ以外 (WSL 手動引数モード含む) は従来どおり args テキスト / cwd 欄を使う。
    let args: string[];
    let cwdOut: string | undefined;
    if (isWsl && !wslManual) {
      args = buildWslArgs(wslDistro || wslDistros[0] || '', wslCwd);
      cwdOut = undefined;
    } else {
      args = parseArgsText(argsText);
      cwdOut = cwd.trim() || undefined;
    }

    // F-S3: env のパース（不正 KEY はエラーとして form を弾く）
    const { env, errors } = parseEnvText(envText);

    if (errors.length > 0) {
      setEnvError(errors.join('\n'));
      return;
    }
    setEnvError(null);

    onSubmit({
      title: title.trim(),
      shell: shell.trim() || undefined,
      cwd: cwdOut,
      args: args.length > 0 ? args : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      defaultTabTitle: defaultTabTitle.trim() || undefined,
      launchClaude: launchClaude || undefined,
      // 権限バイパスは Claude 自動起動が前提。launchClaude OFF のときは保存しない。
      bypassPermissions: (launchClaude && bypassPermissions) || undefined,
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
          {/* F-M5: a11y 対応 — Dialog.Description を追加 */}
          <Dialog.Description className="dialog-description">
            {mode === 'add'
              ? 'shell・cwd・環境変数を指定して新しいお気に入りを登録します。'
              : 'お気に入りの設定を編集します。'}
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="dialog-form">
            {/* Phase 4 P-I: テンプレート select — 選択すると title/shell を自動入力 */}
            <label className="dialog-field">
              <span className="dialog-label">テンプレート (任意)</span>
              <select
                className="dialog-input"
                value=""
                onChange={(e) => {
                  applyTemplate(e.target.value);
                  // 選択完了後 select 自体は (未選択) に戻す
                  e.target.value = '';
                }}
              >
                <option value="">(未選択 — 手動入力)</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.label}</option>
                ))}
              </select>
              <small className="dialog-hint">
                選択すると title・shell が自動入力されます (上書き編集可)。
              </small>
            </label>

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

            {isWsl && !wslManual ? (
              /* WSL 専用フィールド: distro と作業ディレクトリだけで OK (-d / --cd は内部で自動構築) */
              <>
                <label className="dialog-field">
                  <span className="dialog-label">WSL ディストリビューション</span>
                  {distroOptions.length > 0 ? (
                    <select
                      className="dialog-input"
                      value={wslDistro || wslDistros[0] || ''}
                      onChange={(e) => setWslDistro(e.target.value)}
                    >
                      {distroOptions.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="dialog-input"
                      value={wslDistro}
                      onChange={(e) => setWslDistro(e.target.value)}
                      placeholder="(例: Ubuntu-22.04)"
                    />
                  )}
                </label>

                <label className="dialog-field">
                  <span className="dialog-label">作業ディレクトリ (Linux パス)</span>
                  <input
                    className="dialog-input"
                    value={wslCwd}
                    onChange={(e) => setWslCwd(e.target.value)}
                    placeholder="(空 = ~) 例: ~/jdf-dev/uranus2/server"
                  />
                  <small className="dialog-hint">
                    distro と作業ディレクトリを選ぶだけで、起動引数{' '}
                    <code>-d {wslDistro || wslDistros[0] || '<distro>'} --cd {wslCwd.trim() || '~'}</code>{' '}
                    を自動構築します（<code>-d</code> / <code>--cd</code> の手書きは不要）。
                  </small>
                </label>

                <div className="dialog-field">
                  <button
                    type="button"
                    className="dialog-link-btn"
                    onClick={() => {
                      // 手動モードへ: 現在の distro/dir を args テキストに展開してから切り替える
                      setArgsText(buildWslArgs(wslDistro || wslDistros[0] || '', wslCwd).join('\n'));
                      setWslManual(true);
                    }}
                  >
                    引数を手動で指定する
                  </button>
                </div>
              </>
            ) : (
              <>
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
                  <span className="dialog-label">引数 (任意)</span>
                  <small className="dialog-hint">
                    shell の起動時に渡すコマンドライン引数を、<strong>1 行に 1 つずつ</strong>書きます。
                    ふだんターミナルでスペース区切りに打つ引数も、ここでは改行で 1 つずつ分けてください。
                  </small>
                  <textarea
                    className="dialog-textarea"
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    rows={3}
                    placeholder={"--cd\n~"}
                  />
                  <small className="dialog-hint">
                    例) WSL をホームディレクトリで起動したい場合、ターミナルでの{' '}
                    <code>wsl.exe --cd ~</code> は、ここでは <code>--cd</code> と <code>~</code> の
                    2 行に分けて書きます。<br />
                    ❌ <code>--cd ~</code> と 1 行にまとめると、全体が 1 つの引数とみなされ正しく動きません。
                    {/* 簡易フォームへ戻す導線は「distro/--cd だけの標準形」のときだけ出す。
                        `--` 等を含む手動コマンドを簡易フォームで黙って失わないため (レビュー C1)。 */}
                    {isWsl && isStandardWslArgs(parseArgsText(argsText)) && (
                      <>
                        <br />
                        <button
                          type="button"
                          className="dialog-link-btn"
                          onClick={() => {
                            // WSL フォームへ戻す: 現在の args から distro/dir を復元
                            const { distro, dir } = parseWslArgs(parseArgsText(argsText));
                            setWslDistro(distro);
                            setWslCwd(dir);
                            setWslManual(false);
                          }}
                        >
                          WSL 簡易フォームに戻す
                        </button>
                      </>
                    )}
                  </small>
                </label>
              </>
            )}

            <label className="dialog-field">
              <span className="dialog-label">
                環境変数 (1 行 1 件、<code>KEY=VALUE</code> 形式)
              </span>
              <small className="dialog-hint">
                ⚠️ env はローカルに平文保存されます。機密値 (API キー等) は入れないでください。
              </small>
              <textarea
                className="dialog-textarea"
                value={envText}
                onChange={(e) => {
                  setEnvText(e.target.value);
                  // テキスト変更時にエラーをクリアする（再 submit まで保留）
                  if (envError) setEnvError(null);
                }}
                rows={4}
                placeholder={"例:\nPATH=C:\\custom\\bin;%PATH%\nNODE_ENV=development"}
              />
              {/* F-S3: env パースエラー表示 */}
              {envError && (
                <div className="dialog-error" role="alert">
                  {envError}
                </div>
              )}
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

            <label className="dialog-field dialog-field--checkbox">
              <input
                type="checkbox"
                checked={launchClaude}
                onChange={(e) => setLaunchClaude(e.target.checked)}
              />
              <span className="dialog-label">Claude Code を自動起動する</span>
              <small className="dialog-hint">
                ON にすると、このお気に入りから開いたタブで <code>claude</code> を自動起動します。
                アプリ再起動でタブが復元される際は、前回の claude セッションを自動 resume します
                （<code>claude</code> が PATH にある環境が前提）。
              </small>
            </label>

            {launchClaude && (
              <label className="dialog-field dialog-field--checkbox dialog-field--indent">
                <input
                  type="checkbox"
                  checked={bypassPermissions}
                  onChange={(e) => setBypassPermissions(e.target.checked)}
                />
                <span className="dialog-label">権限プロンプトをバイパスする</span>
                <small className="dialog-hint">
                  ⚠️ ON にすると <code>claude --dangerously-skip-permissions</code> で起動し、
                  ファイル編集・コマンド実行などの確認をスキップします。信頼できる作業ディレクトリ専用に
                  してください。
                </small>
              </label>
            )}

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
