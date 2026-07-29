import type { AgentState } from '../types';

/**
 * Claude Code が端末へ送る **OSC 21337 (TAB_STATUS)** の解釈。
 *
 * Claude Code は端末のタブへ状態を表示させるためのシーケンスを持っている:
 *
 * ```
 * ESC ] 21337 ; indicator=#ff9500;status=Working…;status-color=#ff9500 ST
 * ```
 *
 * これが受け取れると、`claudeSessions.ts` のファイルポーリングより確実になる。
 * とくに **WSL では PTY を流れてくるぶん確実**で、`\\wsl.localhost` 経由の
 * パス解決に依存しない。
 *
 * ⚠️ 現時点では Claude Code 側の feature gate と `showStatusInTerminalTab` 設定の
 * 両方が有効でないと送信されない。受信側を用意しておくことで、
 * 有効になった環境では自動的に精度が上がる、という位置づけ。
 */

/** OSC 21337 のペイロードをパースした結果。 */
export interface TabStatusPayload {
  /** インジケータ色 (`#rrggbb`)。状態を色で表す */
  indicator?: string;
  /** 表示用ラベル (`Idle` / `Working…` / `Waiting`) */
  status?: string;
  /** ラベルの色 (`#rrggbb`) */
  statusColor?: string;
}

/**
 * `key=value;key=value` 形式のペイロードをパースする。
 *
 * 値の中の `;` は `\;`、`\` は `\\` にエスケープされている
 * （Claude Code 側が `replaceAll` で施している）ので、それを戻す。
 *
 * 未知のキーは無視する。値が空 (`status=`) の場合は「解除」の意味なので
 * undefined ではなく空文字として保持し、呼び出し側が状態のクリアと判断できるようにする。
 */
export function parseTabStatusOsc(data: string): TabStatusPayload {
  const out: TabStatusPayload = {};

  // エスケープを考慮して `;` で分割する。`\;` は区切りではない。
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of data) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'indicator') out.indicator = value;
    else if (key === 'status') out.status = value;
    else if (key === 'status-color') out.statusColor = value;
  }

  return out;
}

/**
 * Claude Code がインジケータに使う色 → 状態の対応。
 *
 * 実装上の定義値:
 * - idle:    `rgb(0,215,95)`   = `#00d75f`
 * - busy:    `rgb(255,149,0)`  = `#ff9500`
 * - waiting: `rgb(95,135,255)` = `#5f87ff`
 */
const INDICATOR_TO_STATE: Record<string, AgentState> = {
  '#00d75f': 'idle',
  '#ff9500': 'working',
  '#5f87ff': 'blocked',
};

/**
 * 表示ラベル → 状態の対応。色が読めないときの手がかりとして使う。
 * ラベルは `Idle` / `Working…` / `Waiting`（末尾は三点リーダ U+2026）。
 */
const LABEL_TO_STATE: [RegExp, AgentState][] = [
  [/^waiting/i, 'blocked'],
  [/^working/i, 'working'],
  [/^idle/i, 'idle'],
];

/**
 * OSC のペイロードから状態を判定する。
 *
 * **色を先に見る**。ラベルは表示用の文言なので将来変わりうるが、
 * 色は状態ごとの定数として定義されているぶん安定している。
 * 色が未知ならラベルで補う。
 *
 * どちらからも決められないときは undefined を返し、呼び出し側は
 * 状態を更新しない（勝手に消さない）。
 */
export function agentStateFromTabStatus(payload: TabStatusPayload): AgentState | undefined {
  const indicator = payload.indicator?.trim().toLowerCase();
  if (indicator !== undefined && indicator.length > 0) {
    const byColor = INDICATOR_TO_STATE[indicator];
    if (byColor !== undefined) return byColor;
  }

  const label = payload.status?.trim();
  if (label !== undefined && label.length > 0) {
    for (const [pattern, state] of LABEL_TO_STATE) {
      if (pattern.test(label)) return state;
    }
  }

  return undefined;
}

/**
 * ペイロードが「状態の解除」を意味するかを判定する。
 *
 * Claude Code は終了時に空の値を送って表示を消す。
 * このとき状態を保持し続けると、終了済みのタブが working のまま残ってしまう。
 */
export function isTabStatusCleared(payload: TabStatusPayload): boolean {
  const hasIndicator = (payload.indicator ?? '').length > 0;
  const hasStatus = (payload.status ?? '').length > 0;
  // キー自体は来ているのに中身が空 = 解除
  const mentioned = payload.indicator !== undefined || payload.status !== undefined;
  return mentioned && !hasIndicator && !hasStatus;
}
