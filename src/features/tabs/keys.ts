/**
 * キーイベント → タブ操作コマンドの読み替え。純粋関数。
 *
 * ここには「どのキーが何のコマンドか」しか書きません。実行してよいかどうかは
 * Mediator の裁定で、`preventDefault` を呼ぶかどうかは呼び出し側 (View) の都合です。
 * 分離しておくと、キーボードも DOM も無しで対応表をテストできます。
 */

import type { TabsIntent } from './events';

/**
 * `e.code` が使えないときに `e.key` へ落ちるための判定。
 *
 * Aqua Voice のような支援ソフトが合成した KeyboardEvent は `e.code` が空文字列に
 * なることがある (物理スキャンコードを伴わない)。通常の物理キーボードでは
 * 従来どおり `e.code` を優先する (CapsLock / AZERTY 等のレイアウト非依存のため)。
 */
export type CodeIs = (code: string, key: string) => boolean;

export function makeCodeIs(e: KeyboardEvent): CodeIs {
  return (code, key) => e.code === code || (e.code === '' && e.key.toLowerCase() === key);
}

/**
 * Ctrl+Shift+1..9 のお気に入り index (0..8) を取り出す。該当しなければ null。
 * `e.code` は `Digit1`..`Digit9` / `Numpad1`..`Numpad9` を許容する。
 */
export function favoriteIndexFromKey(e: KeyboardEvent): number | null {
  if (!e.shiftKey) return null;
  // 合成キー (e.code 空) では e.key の数字にフォールバックする
  const m =
    e.code.match(/^(?:Digit|Numpad)([1-9])$/) ?? (e.code === '' ? e.key.match(/^([1-9])$/) : null);
  if (!m) return null;
  return parseInt(m[1], 10) - 1; // 1-9 → 0-8
}

/**
 * キーとコマンドの対応表。
 *
 * **先頭から順に評価し、最初に match したものだけを採用する**ので並び順に意味がある
 * (Ctrl+Shift+T を Ctrl+T より先に置く)。
 */
const KEY_COMMANDS: readonly {
  readonly match: (e: KeyboardEvent, codeIs: CodeIs) => boolean;
  readonly command: (e: KeyboardEvent) => TabsIntent | null;
}[] = [
  {
    // Ctrl+Shift+W: アクティブタブを閉じる
    // e.code ('KeyW') を使うことで CapsLock / AZERTY 等の非 ASCII レイアウトでも
    // 物理 W キーの位置を正確に判定できる (e.key は 'w'/'W'/'z' 等レイアウト依存)
    match: (e, codeIs) => e.shiftKey && codeIs('KeyW', 'w'),
    command: () => ({ type: 'tabs/close-active-requested' }),
  },
  {
    // Ctrl+Tab / Ctrl+Shift+Tab: 次 / 前のタブへ移動
    // e.code ('Tab') で物理 Tab キーを判定する (IME 中は e.key === 'Process' になる場合がある)
    match: (_e, codeIs) => codeIs('Tab', 'tab'),
    command: (e) => ({
      type: 'tabs/navigate-requested',
      direction: e.shiftKey ? 'prev' : 'next',
    }),
  },
  {
    // Ctrl+Shift+T: 閉じたタブを復元 (Ctrl+T より先に判定すること)
    match: (e, codeIs) => e.shiftKey && codeIs('KeyT', 't'),
    command: () => ({ type: 'tabs/restore-requested' }),
  },
  {
    // Ctrl+T: 既定タブを開く
    match: (e, codeIs) => !e.shiftKey && codeIs('KeyT', 't'),
    command: () => ({ type: 'tabs/spawn-default-requested' }),
  },
  {
    // Ctrl+Shift+1..9: お気に入り index 0..8 を開く
    match: (e) => favoriteIndexFromKey(e) !== null,
    command: (e) => {
      const index = favoriteIndexFromKey(e);
      return index === null ? null : { type: 'tabs/spawn-favorite-requested', index };
    },
  },
];

/**
 * Ctrl 系キーをタブ操作コマンドに読み替える。該当しなければ null。
 *
 * 呼び出し側は Ctrl (または Meta) が押されていることを確認済みである前提。
 */
export function tabCommandForKey(e: KeyboardEvent): TabsIntent | null {
  const codeIs = makeCodeIs(e);
  const entry = KEY_COMMANDS.find((c) => c.match(e, codeIs));
  return entry ? entry.command(e) : null;
}
