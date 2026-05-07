/**
 * URL バリデータ。
 *
 * ターミナル出力は untrusted なので、Ctrl+クリックで開く URL を
 * http: / https: のみに制限する。javascript:/file:/data: 等の危険スキームを弾くことで
 * ターミナル経由の XSS / ローカルファイル開示を防ぐ。
 */

// C0 制御文字 (U+0000-U+001F) + DEL (U+007F) + C1 制御文字 (U+0080-U+009F)
// sanitizeOscTitle (terminalRegistry.ts) と同じ範囲を使い OSC 系の制御文字防御と整合させる
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

// Bidi 上書き文字: U+200E/F (LRM/RLM), U+202A-E (LRE/RLE/PDF/LRO/RLO),
// U+2066-2069 (LRI/RLI/FSI/PDI)。表示上の URL 偽装攻撃 (ホスト名の RLO 反転等) を弾く
const BIDI_OVERRIDE_RE = /[‎‏‪-‮⁦-⁩]/;

// 一般的な URL 上限を超えるものを reject (UTF-16 code unit 数で計測。
// 国際化ドメイン等の極端なケースは想定しない)
const MAX_URL_LENGTH = 2048;

/**
 * 入力文字列が安全に開ける URL かどうかを検証する。
 *
 * 条件:
 * 1. 長さが 1〜2048 文字 (UTF-16 code unit) の範囲
 * 2. C0/C1 制御文字 (U+0000-U+001F, U+007F-U+009F) を含まない
 * 3. Bidi 上書き文字 (U+200E/F, U+202A-E, U+2066-9) を含まない
 * 4. `new URL(input)` でパース成功
 * 5. protocol が `http:` または `https:` のみ
 */
export function isAllowedUrl(input: string): boolean {
  // 長さチェック
  if (input.length < 1 || input.length > MAX_URL_LENGTH) return false;

  // 制御文字チェック (xterm 側でも除去されるが二重防御)
  if (CONTROL_CHAR_RE.test(input)) return false;

  // Bidi 上書き文字チェック (URL 偽装攻撃の防御)
  if (BIDI_OVERRIDE_RE.test(input)) return false;

  // URL パース検証
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }

  // スキーム allowlist: http: と https: のみ許可
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
