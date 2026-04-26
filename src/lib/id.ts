import { nanoid } from 'nanoid';

/**
 * Frontend で発行する ID（Tab / Group / Favorite / editingId など）。
 * crypto.randomUUID() が使える環境ではそれを使い、使えない場合は nanoid() をフォールバック。
 * Tauri WebView2 は通常 crypto.randomUUID をサポートするが、古い Win10 環境での保険。
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // セキュアコンテキスト要件で失敗する場合もフォールバック
    }
  }
  return nanoid();
}
