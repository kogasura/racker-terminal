import { useState, useEffect, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { getVersion } from '@tauri-apps/api/app';
import { useEmit } from '../architecture/chain';
import { useSettingsView } from '../features/settings/SettingsRoot';
import type { SettingsEvent } from '../features/settings/events';
import { useThemeView } from '../features/theme/ThemeRoot';
import type { ThemeEvent } from '../features/theme/events';
import type { ThemeOption } from '../features/theme/viewModel';
import { useUpdaterView } from '../features/updater/UpdaterRoot';
import { UpdateSettingsSectionView } from '../features/updater/views/UpdateSettingsSectionView';
import type { Settings } from '../types';
import { groupThemeOptions, isMissingTheme } from './ThemeOptionGroups';

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

/** 数値系フィールドの差分。F-M2: clamp してから比較する。 */
function numericSettingsPatch(draft: Settings, settings: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};

  const fontSize = clamp(draft.fontSize, FONT_MIN, FONT_MAX, 14);
  if (fontSize !== settings.fontSize) patch.fontSize = fontSize;

  const scrollback = clamp(draft.scrollback, SCROLLBACK_MIN, SCROLLBACK_MAX, 1000);
  if (scrollback !== settings.scrollback) patch.scrollback = scrollback;

  const transparency = clamp(draft.transparency ?? 1.0, TRANSPARENCY_MIN, TRANSPARENCY_MAX, 1.0);
  if (transparency !== (settings.transparency ?? 1.0)) patch.transparency = transparency;

  return patch;
}

/**
 * 入力中の draft と現在の settings を比べ、変更のあったフィールドだけの patch を作る。
 *
 * F-S3 案B: patch ベースで diff のみ updateSettings に渡すことで lost update を解消する。
 */
export function buildSettingsPatch(draft: Settings, settings: Settings): Partial<Settings> {
  const patch = numericSettingsPatch(draft, settings);

  if (draft.theme !== settings.theme) patch.theme = draft.theme;

  if (draft.fontFamily !== settings.fontFamily) patch.fontFamily = draft.fontFamily;

  // 未設定 (undefined) は有効扱いなので、比較も「false かどうか」で揃える
  const notificationsEnabled = draft.notificationsEnabled !== false;
  if (notificationsEnabled !== (settings.notificationsEnabled !== false)) {
    patch.notificationsEnabled = notificationsEnabled;
  }

  const statusBarEnabled = draft.statusBarEnabled !== false;
  if (statusBarEnabled !== (settings.statusBarEnabled !== false)) {
    patch.statusBarEnabled = statusBarEnabled;
  }

  const gpuAcceleration = draft.gpuAcceleration !== false;
  if (gpuAcceleration !== (settings.gpuAcceleration !== false)) {
    patch.gpuAcceleration = gpuAcceleration;
  }

  const backdropMotion = draft.backdropMotion !== false;
  if (backdropMotion !== (settings.backdropMotion !== false)) {
    patch.backdropMotion = backdropMotion;
  }

  return patch;
}

/** テーマのカード 1 枚。名前・ライト / ダーク・ひとこと説明を出す。 */
function ThemeCard({
  option,
  selected,
  onSelect,
}: {
  option: ThemeOption;
  selected: boolean;
  onSelect: (themeId: string) => void;
}) {
  const appearance = option.appearance === 'light' ? 'ライト' : 'ダーク';
  // 組み込みの背景付きはグループ名で分かるので、自分のテーマのときだけ背景の有無を添える
  const backdrop = option.source === 'user' && option.hasBackdrop ? '・動く背景' : '';
  return (
    <button
      type="button"
      className={selected ? 'theme-card theme-card--selected' : 'theme-card'}
      aria-pressed={selected}
      onClick={() => onSelect(option.id)}
    >
      <span className="theme-card__head">
        <span className="theme-card__name">{option.name}</span>
        <span className="theme-card__meta">
          {appearance}
          {backdrop}
        </span>
      </span>
      {option.blurb !== undefined && <span className="theme-card__blurb">{option.blurb}</span>}
    </button>
  );
}

/**
 * テーマのカードの一覧。「配色だけ」「動く背景（ダーク）」「動く背景（ライト）」
 * 「自分のテーマ」の 4 グループ（自分のテーマが無ければ 3 つ）。Passive View。
 */
function ThemeCardList({
  options,
  value,
  onSelect,
}: {
  options: readonly ThemeOption[];
  value: string;
  onSelect: (themeId: string) => void;
}) {
  return (
    <div className="theme-cards" role="group" aria-label="テーマ">
      {groupThemeOptions(options).map((group) => (
        <div key={group.key} className="theme-card-group" role="group" aria-label={group.label}>
          <span className="theme-card-group__label" aria-hidden="true">
            {group.label}
          </span>
          <div className="theme-card-grid">
            {group.options.map((o) => (
              <ThemeCard key={o.id} option={o} selected={o.id === value} onSelect={onSelect} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 設定ダイアログのテーマの節。Passive View。
 *
 * カードを押したテーマは draft に入れ、親が窓に試しに表示する。確定は保存時に
 * 他の設定と一緒に行う。フォルダ操作と再読み込みは theme 機能へイベントとして流すだけ。
 */
function ThemeSettingsSection({
  value,
  onChange,
  onCreateWithClaude,
}: {
  value: string;
  onChange: (themeId: string) => void;
  /**
   * 「Claude でテーマを作る」が押された。claude タブへ移るので、親が入力中の内容を
   * 保存してから claude タブを開くよう流し、設定ダイアログを閉じる。
   */
  onCreateWithClaude: () => void;
}) {
  const { options, errors } = useThemeView();
  const emit = useEmit<ThemeEvent>();

  // ダイアログを開いたときに themes フォルダを読み直す (手で置いたファイルを拾うため)。
  useEffect(() => {
    emit({ type: 'theme/reload-requested' });
    // 開いたときの 1 回だけでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dialog-field">
      <span className="dialog-label">テーマ</span>
      {isMissingTheme(options, value) && (
        <small className="dialog-hint">
          選んでいるテーマ（見つかりません: {value}）を読み込めません。ファイルを消したか、
          名前を変えた可能性があります。
        </small>
      )}
      <ThemeCardList options={options} value={value} onSelect={onChange} />
      <div className="settings-theme-actions">
        <button
          type="button"
          className="dialog-btn dialog-btn--cancel"
          onClick={() => emit({ type: 'theme/open-folder-requested' })}
        >
          フォルダを開く
        </button>
        <button
          type="button"
          className="dialog-btn dialog-btn--cancel"
          onClick={onCreateWithClaude}
        >
          Claude でテーマを作る
        </button>
        <button
          type="button"
          className="dialog-btn dialog-btn--cancel"
          onClick={() => emit({ type: 'theme/reload-requested' })}
        >
          再読み込み
        </button>
      </div>
      {errors.length > 0 && (
        <div className="dialog-error">
          読み込めなかったテーマ:
          <ul className="settings-theme-errors">
            {errors.map((e) => (
              <li key={e.fileName}>
                <code>{e.fileName}</code>: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      <small className="dialog-hint">
        カードを押すと窓に試しに表示し、「保存」で確定します（「キャンセル」で元に戻ります）。
        themes フォルダに JSON（背景は SVG）を置くか、Claude に頼んで作れます。
      </small>
    </div>
  );
}

/**
 * 背景透明度の欄。背景付きのテーマでは背景の絵が下地になるため使わない。
 * そのときはその旨を注記する。スライダーは無効にしない（お気に入りで配色だけのテーマを
 * 付けたタブでは効くため）。
 */
function TransparencyField({
  value,
  onChange,
  backdropSelected,
}: {
  value: number;
  onChange: (transparency: number) => void;
  backdropSelected: boolean;
}) {
  return (
    <div className="dialog-field">
      <span className="dialog-label">背景透明度 (0.7〜1.0) — {value.toFixed(2)}</span>
      <input
        className="settings-range"
        type="range"
        min="0.7"
        max="1"
        step="0.05"
        value={value}
        aria-label="背景透明度"
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <small className="dialog-hint">
        {backdropSelected
          ? '背景付きのテーマでは使いません（配色だけのテーマのタブでは効きます）。'
          : '透明度は frameless window モードでのみ有効です。'}
      </small>
    </div>
  );
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const settings = useSettingsView();
  const emit = useEmit<SettingsEvent>();
  const emitTheme = useEmit<ThemeEvent>();
  const { options: themeOptions } = useThemeView();
  // updater の表示は Root から View モデルとして降ってくる。
  const { settingsSection } = useUpdaterView();

  const [draft, setDraft] = useState<Settings>(settings);
  const [appVersion, setAppVersion] = useState<string | null>(null);

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

  // ダイアログが閉じる操作を経ずに外された場合も、試しに表示を残さない。
  useEffect(() => () => emitTheme({ type: 'theme/preview-ended' }), [emitTheme]);

  /** カードを押したテーマを draft に入れ、保存前に窓へ試しに表示する。 */
  function selectTheme(theme: string) {
    setDraft({ ...draft, theme });
    emitTheme({ type: 'theme/preview-requested', themeId: theme });
  }

  /**
   * ダイアログを閉じる。保存・キャンセル・Esc のどれでも、試しに表示をやめる。
   * 保存したときは設定のテーマが選んだものに変わっているので、窓はそのまま。
   * 保存しなかったときは、窓が元のテーマに戻る。
   */
  function close() {
    emitTheme({ type: 'theme/preview-ended' });
    onClose();
  }

  /** 入力中の内容のうち、変更のあったものだけを保存する。 */
  function saveDraft() {
    const patch = buildSettingsPatch(draft, settings);

    if (Object.keys(patch).length > 0) {
      emit({ type: 'settings/changed', patch });
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    saveDraft();
    close();
  }

  // claude タブへ移るときも、入力中の内容は捨てずに保存してから閉じる。
  function handleCreateWithClaude() {
    saveDraft();
    emitTheme({ type: 'theme/create-with-claude-requested' });
    close();
  }

  const backdropSelected = themeOptions.some((o) => o.id === draft.theme && o.hasBackdrop);

  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">Settings</Dialog.Title>
          <Dialog.Description className="dialog-description">
            テーマ・背景の動き・フォント・スクロールバック・透明度を変更します。
          </Dialog.Description>
          <form onSubmit={handleSubmit} className="dialog-form">
            <ThemeSettingsSection
              value={draft.theme}
              onChange={selectTheme}
              onCreateWithClaude={handleCreateWithClaude}
            />

            <label className="dialog-field dialog-field--checkbox">
              <input
                type="checkbox"
                checked={draft.backdropMotion !== false}
                onChange={(e) => setDraft({ ...draft, backdropMotion: e.target.checked })}
              />
              <span className="dialog-label">背景を動かす</span>
              <small className="dialog-hint">
                背景付きのテーマで、背景のアニメーションを動かします。切ると、その場で止まります。
                Windows の「アニメーション効果」をオフにしているときは、これに関わらず止まります。
              </small>
            </label>

            <label className="dialog-field">
              <span className="dialog-label">フォントサイズ (px)</span>
              <input
                className="dialog-input"
                type="number"
                min="8"
                max="48"
                // step を書かないと既定の 1 刻みになり、既定値 12.5 がフォームの検証で
                // 不正扱いになって「保存」が効かない（テーマも保存できない）。範囲は clamp が守る。
                step="any"
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

            <TransparencyField
              value={draft.transparency ?? 1.0}
              onChange={(transparency) => setDraft({ ...draft, transparency })}
              backdropSelected={backdropSelected}
            />

            <label className="dialog-field dialog-field--checkbox">
              <input
                type="checkbox"
                checked={draft.notificationsEnabled !== false}
                onChange={(e) =>
                  setDraft({ ...draft, notificationsEnabled: e.target.checked })
                }
              />
              <span className="dialog-label">Claude の応答待ち / 完了をデスクトップ通知する</span>
              <small className="dialog-hint">
                表示中でないタブの Claude が応答待ちになったとき、または処理を終えたときに
                Windows の通知を出します。いま開いているタブは通知しません。
              </small>
            </label>

            <label className="dialog-field dialog-field--checkbox">
              <input
                type="checkbox"
                checked={draft.statusBarEnabled !== false}
                onChange={(e) =>
                  setDraft({ ...draft, statusBarEnabled: e.target.checked })
                }
              />
              <span className="dialog-label">画面下部に Claude の状況を表示する</span>
              <small className="dialog-hint">
                表示中のタブで動いている Claude のモデル・effort・コンテキスト消費量と、
                プランの使用量（5 時間 / 週次）を 1 行で出します。
              </small>
            </label>

            <label className="dialog-field dialog-field--checkbox">
              <input
                type="checkbox"
                checked={draft.gpuAcceleration !== false}
                onChange={(e) =>
                  setDraft({ ...draft, gpuAcceleration: e.target.checked })
                }
              />
              <span className="dialog-label">GPU で描画する</span>
              <small className="dialog-hint">
                通常は ON のままで構いません。長時間使っていると
                <strong>文字が空白になったり別の字に化けたりする</strong>場合は、これを切ると直ります
                （化けているのは表示だけで、文字そのものは壊れていません）。
                切ると描画は CPU 側に切り替わります。背景透明度を 1.00 未満にしている間は
                この設定に関わらず GPU 描画は使いません。
              </small>
            </label>

            <UpdateSettingsSectionView
              vm={settingsSection}
              appVersion={appVersion}
              onLeaveForDialog={close}
            />

            <div className="dialog-actions">
              <button type="button" className="dialog-btn dialog-btn--cancel" onClick={close}>
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
