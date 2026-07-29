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

/** env オブジェクトを "KEY=VALUE" の行テキストに戻す。 */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** 空文字（前後空白のみを含む）は undefined に落とす。 */
function orUndefined(s: string): string | undefined {
  return s.trim() || undefined;
}

/**
 * WSL 専用フィールドの初期状態を復元する。
 * 編集モードで既存の WSL お気に入りを開いたときは args から distro / dir を取り出す。
 */
function initialWslState(f: Partial<Favorite>) {
  const standard = isWslShell(f.shell) && isStandardWslArgs(f.args);
  const parsed = parseWslArgs(f.args);
  return {
    wslDistro: standard ? parsed.distro : '',
    wslCwd: standard ? parsed.dir : '',
    // 既存 WSL お気に入りの args が標準形でない (`--` 等を含む) 場合のみ手動引数モードで開く。
    wslManual: isWslShell(f.shell) && !isStandardWslArgs(f.args),
  };
}

/** テキスト入力欄の初期値。 */
function initialTextFields(f: Partial<Favorite>) {
  return {
    title: f.title ?? '',
    shell: f.shell ?? '',
    cwd: f.cwd ?? '',
    argsText: f.args?.join('\n') ?? '',
    envText: envToText(f.env),
    defaultTabTitle: f.defaultTabTitle ?? '',
  };
}

/** チェックボックスの初期値。 */
function initialFlags(f: Partial<Favorite>) {
  return {
    launchClaude: f.launchClaude ?? false,
    bypassPermissions: f.bypassPermissions ?? false,
  };
}

/** 編集モードの初期値から、フォームの初期 state をまとめて作る。 */
function initialFormState(initial: Favorite | undefined) {
  const f: Partial<Favorite> = initial ?? {};
  return { ...initialTextFields(f), ...initialFlags(f), ...initialWslState(f) };
}

/** ダイアログの見出しと説明文。 */
function dialogTexts(mode: 'add' | 'edit') {
  return mode === 'add'
    ? {
        title: 'お気に入りを追加',
        description: 'shell・cwd・環境変数を指定して新しいお気に入りを登録します。',
      }
    : { title: 'お気に入りを編集', description: 'お気に入りの設定を編集します。' };
}

/**
 * args / cwd を決める。
 * - WSL かつ専用フィールド使用時は distro + 作業ディレクトリから args を組み立て、
 *   Windows 側 cwd は送らない (WSL の着地点は `--cd` が決めるため)。
 * - それ以外 (WSL 手動引数モード含む) は従来どおり args テキスト / cwd 欄を使う。
 */
function resolveArgsAndCwd(p: {
  isWsl: boolean;
  wslManual: boolean;
  wslDistro: string;
  wslDistros: string[];
  wslCwd: string;
  argsText: string;
  cwd: string;
}): { args: string[]; cwd: string | undefined } {
  if (p.isWsl && !p.wslManual) {
    return {
      args: buildWslArgs(p.wslDistro || p.wslDistros[0] || '', p.wslCwd),
      cwd: undefined,
    };
  }
  return { args: parseArgsText(p.argsText), cwd: orUndefined(p.cwd) };
}

/** 入力値から保存する Favorite を組み立てる。空の項目は undefined に落とす。 */
function buildFavorite(p: {
  title: string;
  shell: string;
  cwd: string | undefined;
  args: string[];
  env: Record<string, string>;
  defaultTabTitle: string;
  launchClaude: boolean;
  bypassPermissions: boolean;
}): Omit<Favorite, 'id'> {
  return {
    title: p.title.trim(),
    shell: orUndefined(p.shell),
    cwd: p.cwd,
    args: p.args.length > 0 ? p.args : undefined,
    env: Object.keys(p.env).length > 0 ? p.env : undefined,
    defaultTabTitle: orUndefined(p.defaultTabTitle),
    launchClaude: p.launchClaude || undefined,
    // 権限バイパスは Claude 自動起動が前提。launchClaude OFF のときは保存しない。
    bypassPermissions: (p.launchClaude && p.bypassPermissions) || undefined,
  };
}

/** 実際に使われる distro。未選択ならインストール済みの先頭を既定として扱う。 */
function pickDistro(wslDistro: string, wslDistros: string[]): string {
  return wslDistro || wslDistros[0] || '';
}

/** distro の入力欄。インストール済みが検出できていれば select、なければ自由入力。 */
function DistroInput({
  distroOptions,
  effectiveDistro,
  wslDistro,
  setWslDistro,
}: {
  distroOptions: string[];
  effectiveDistro: string;
  wslDistro: string;
  setWslDistro: (v: string) => void;
}) {
  if (distroOptions.length === 0) {
    return (
      <input
        className="dialog-input"
        value={wslDistro}
        onChange={(e) => setWslDistro(e.target.value)}
        placeholder="(例: Ubuntu-22.04)"
      />
    );
  }
  return (
    <select
      className="dialog-input"
      value={effectiveDistro}
      onChange={(e) => setWslDistro(e.target.value)}
    >
      {distroOptions.map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </select>
  );
}

/**
 * 簡易フォームへ戻す導線。
 * 「distro/--cd だけの標準形」のときだけ出す。`--` 等を含む手動コマンドを
 * 簡易フォームで黙って失わないため (レビュー C1)。
 */
function BackToWslFormLink({
  isWsl,
  argsText,
  onClick,
}: {
  isWsl: boolean;
  argsText: string;
  onClick: () => void;
}) {
  if (!isWsl || !isStandardWslArgs(parseArgsText(argsText))) return null;
  return (
    <>
      <br />
      <button type="button" className="dialog-link-btn" onClick={onClick}>
        WSL 簡易フォームに戻す
      </button>
    </>
  );
}

/** F-S3: env パースエラー表示。 */
function EnvErrorMessage({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <div className="dialog-error" role="alert">
      {error}
    </div>
  );
}

export function FavoriteDialog({ mode, initial, onSubmit, onClose }: FavoriteDialogProps) {
  const wslDistros = useAppStore(useShallow((s) => s.wslDistros));
  const templates = useMemo(() => buildProfileTemplates(wslDistros), [wslDistros]);

  // 初期値の導出。useState の初期値としてしか使わないので毎レンダー作り直す必要はない。
  const init = useMemo(() => initialFormState(initial), [initial]);

  const [title, setTitle] = useState(init.title);
  const [shell, setShell] = useState(init.shell);
  const [cwd, setCwd] = useState(init.cwd);
  const [argsText, setArgsText] = useState(init.argsText);

  // WSL 専用フィールド: distro と作業ディレクトリ (Linux パス) を args の代わりに編集する。
  const [wslDistro, setWslDistro] = useState(init.wslDistro);
  const [wslCwd, setWslCwd] = useState(init.wslCwd);
  const [wslManual, setWslManual] = useState(init.wslManual);

  const [envText, setEnvText] = useState(init.envText);
  const [defaultTabTitle, setDefaultTabTitle] = useState(init.defaultTabTitle);
  const [launchClaude, setLaunchClaude] = useState(init.launchClaude);
  const [bypassPermissions, setBypassPermissions] = useState(init.bypassPermissions);
  // F-S3: env パースエラー表示用 state
  const [envError, setEnvError] = useState<string | null>(null);

  // 現在の shell が WSL かどうか。WSL のときは distro / 作業ディレクトリの専用フィールドを出す。
  const isWsl = isWslShell(shell);
  const effectiveDistro = pickDistro(wslDistro, wslDistros);
  const texts = dialogTexts(mode);
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

    const { args, cwd: cwdOut } = resolveArgsAndCwd({
      isWsl,
      wslManual,
      wslDistro,
      wslDistros,
      wslCwd,
      argsText,
      cwd,
    });

    // F-S3: env のパース（不正 KEY はエラーとして form を弾く）
    const { env, errors } = parseEnvText(envText);

    if (errors.length > 0) {
      setEnvError(errors.join('\n'));
      return;
    }
    setEnvError(null);

    onSubmit(
      buildFavorite({
        title,
        shell,
        cwd: cwdOut,
        args,
        env,
        defaultTabTitle,
        launchClaude,
        bypassPermissions,
      }),
    );
  }

  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">
            {texts.title}
          </Dialog.Title>
          {/* F-M5: a11y 対応 — Dialog.Description を追加 */}
          <Dialog.Description className="dialog-description">
            {texts.description}
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
                  <DistroInput
                    distroOptions={distroOptions}
                    effectiveDistro={effectiveDistro}
                    wslDistro={wslDistro}
                    setWslDistro={setWslDistro}
                  />
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
                    <code>-d {effectiveDistro || '<distro>'} --cd {wslCwd.trim() || '~'}</code>{' '}
                    を自動構築します（<code>-d</code> / <code>--cd</code> の手書きは不要）。
                  </small>
                </label>

                <div className="dialog-field">
                  <button
                    type="button"
                    className="dialog-link-btn"
                    onClick={() => {
                      // 手動モードへ: 現在の distro/dir を args テキストに展開してから切り替える
                      setArgsText(buildWslArgs(effectiveDistro, wslCwd).join('\n'));
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
                    <BackToWslFormLink
                      isWsl={isWsl}
                      argsText={argsText}
                      onClick={() => {
                        // WSL フォームへ戻す: 現在の args から distro/dir を復元
                        const { distro, dir } = parseWslArgs(parseArgsText(argsText));
                        setWslDistro(distro);
                        setWslCwd(dir);
                        setWslManual(false);
                      }}
                    />
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
              <EnvErrorMessage error={envError} />
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
