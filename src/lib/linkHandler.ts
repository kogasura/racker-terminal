import type { ILinkHandler } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { isAllowedUrl, isPlausibleFileUri } from './urlValidator';

/**
 * OSC 8 ハイパーリンクのハンドラ。
 *
 * xterm.js は linkHandler 未設定だと OSC 8 リンクのクリックで「強い警告文付きの
 * confirm ダイアログ」を出す既定動作になる。ここで受けて racker の流儀
 * (WebLinksAddon と同じ Ctrl+クリック) に揃える。
 *
 * Claude Code は端末がハイパーリンク対応 (FORCE_HYPERLINK=1、pty.rs 参照) だと、
 * 画像 (`[img] …`) やファイル参照を `file://` の OSC 8 リンクとして出力する。
 * これを開けるようにするのがこのハンドラの主目的。
 *
 * スキーム別の扱い:
 * - http/https: isAllowedUrl で検証してブラウザで開く (WebLinksAddon と同じ経路)
 * - file:      Rust の open_file_link へ。閲覧系拡張子 (画像/PDF/md 等) は
 *              既定アプリで開き、実行されうる拡張子 (.exe/.js/.py 等) は
 *              Explorer での場所表示に留める。最終判断は Rust 側 (file_link.rs)。
 * - その他:    無視 (javascript: 等の危険スキームはここで落ちる)
 *
 * Ctrl+クリック (Mac は Cmd+クリック) のみをトリガとする理由は WebLinksAddon 側
 * (terminalRegistry.ts の setupWebLinks) と同じ: プロンプト編集での単純クリックと
 * 誤発火させない。ターミナル出力は untrusted なので、修飾キーによる明示操作を
 * 開く条件にすること自体が防御の一部でもある。
 */
export function createLinkHandler(): ILinkHandler {
  return {
    // file: スキームを届かせるために必要。true にすると全スキームが activate に
    // 到達するようになるため、下の allowlist 検証が必須になる。
    allowNonHttpProtocols: true,

    activate(event: MouseEvent, uri: string): void {
      // 左クリック (button=0) + Ctrl/Cmd のみ受け付ける (WebLinksAddon と同条件)
      if (event.button !== 0) return;
      if (!event.ctrlKey && !event.metaKey) return;

      if (isAllowedUrl(uri)) {
        // PII (社内 URL / トークン付き URL) ログ漏洩を避けるため URL は出さない
        void openUrl(uri).catch((e) => {
          console.warn('[linkHandler] openUrl failed:', e);
        });
        return;
      }

      if (isPlausibleFileUri(uri)) {
        void invoke<string>('open_file_link', { uri }).catch((e) => {
          // ファイル名にも PII がありうるので URI は出さない
          console.warn('[linkHandler] open_file_link failed:', e);
        });
      }
      // それ以外のスキームは黙って無視 (untrusted 出力からの危険スキーム対策)
    },
  };
}
