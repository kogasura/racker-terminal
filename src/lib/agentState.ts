import type { AgentState } from '../types';

/**
 * 画面出力からエージェント状態を推測する **フォールバック** 実装。
 *
 * ⚠️ 通常は `claudeSessions.ts` が Claude Code のセッションファイルから
 * 公式の status を読み取り、そちらが優先される（store の `setTabAgentState` が
 * `agentStateFromSession` を見て画面判定を弾く）。
 * ここは **セッションファイルが読めないとき専用**の推測経路:
 * - Claude Code のバージョンが古い / 形式が変わった
 * - セッションとタブの照合に失敗した（同一 cwd に複数タブ等）
 *
 * 画面の英語文言に依存するため、公式 status が取れる環境ではこちらを使わない。
 *
 * 設計方針（herdr の screen-manifest 方式に準拠）:
 * - 状態の判定権限は本モジュールに一本化する（"one status authority"）。
 *   terminalRegistry はスナップショットと BEL フラグを渡すだけで、判定には関与しない。
 * - 画面の**下部バッファのスナップショット**だけを見る。scrollback 全体を走査しない。
 *   過去に流れた文字列（例: Claude が説明文として書いた "Do you want to ..."）を
 *   誤検出しないための制約であり、パフォーマンス上の都合ではない。
 * - blocked の判定は意図的に厳格にする。曖昧なら blocked にしない。
 *   誤検出した blocked は「応答しなければ止まったまま」に見えるため、
 *   取りこぼしより誤検出のほうが害が大きい。
 */

/**
 * スナップショットとして読み取る画面下部の行数。
 *
 * Claude Code の権限確認 UI は罫線ボックスで最大 10 行程度、
 * 実行中インジケータは最下部 1〜3 行に出る。24 行あれば
 * ウィンドウが小さくても両方を確実に含められる。
 */
export const SNAPSHOT_LINES = 24;

/**
 * 出力が止まってから状態を確定するまでの待ち時間 (ms)。
 *
 * Claude Code の TUI は 1 回の描画を複数の書き込みに分割するため、
 * 書き込みの直後に評価すると描画途中の画面を読んでしまう。
 * 出力が途切れてからこの時間だけ待って「落ち着いた画面」を評価する。
 *
 * 短すぎると描画途中を拾って状態がちらつき、長すぎると通知が遅れる。
 */
export const AGENT_SETTLE_MS = 700;

/**
 * 「実行中」を示す確実なマーカー。
 *
 * Claude Code は処理中のあいだ最下部に
 * `✳ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)` のような行を出し続ける。
 * この文字列は中断方法の案内であり、実行中にしか現れない。
 *
 * 出力の途切れ（トークン生成待ちで数秒無音になる）に影響されないため、
 * 出力アクティビティのタイマーより信頼できる working の根拠になる。
 */
const WORKING_MARKER = /esc to interrupt/i;

/**
 * 「ユーザーへの問いかけ」を示す文言。blocked 判定の必要条件その 1。
 *
 * Claude Code の承認 UI は文言のバリエーションがある:
 * - "Do you want to proceed?"
 * - "Do you want to make this edit to foo.ts?"
 * - "Do you trust the files in this folder?"
 * - "Would you like to proceed?" (Plan モードの承認)
 */
const BLOCKED_QUESTION = /(?:Do you want to|Do you trust|Would you like to)/i;

/**
 * 選択肢リストの 1 番目と 2 番目。blocked 判定の必要条件その 2。
 *
 * 承認 UI は必ず番号付きの選択肢を伴う:
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for ...
 *     3. No, and tell Claude what to do differently
 *
 * 罫線 (`│`) や選択カーソル (`❯`) が前置されるため行頭アンカーは使えない。
 * 「数字の直前が数字以外」という条件で、小数点 (例: `v1.2.3`) の誤マッチを避ける。
 */
const BLOCKED_CHOICE_1 = /(?:^|[^\d.])1\.\s+\S/m;
const BLOCKED_CHOICE_2 = /(?:^|[^\d.])2\.\s+\S/m;

/**
 * xterm の Terminal から必要な部分だけを抜き出した構造的部分型。
 *
 * 実物の Terminal を import せず、テストからプレーンオブジェクトを渡せるようにする。
 * （xterm の Terminal は DOM を要求するため、単体テストで実体化したくない）
 */
export interface SnapshotSource {
  rows: number;
  buffer: {
    active: {
      baseY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/**
 * 画面下部 `lines` 行分のテキストスナップショットを取得する。
 *
 * `baseY` はビューポート先頭の scrollback 内オフセットなので、
 * `baseY + rows` が「現在画面に見えている最終行の次」を指す。
 * つまり scrollback に流れた履歴ではなく **いま見えている内容**だけを読む。
 *
 * @param term - xterm の Terminal（または同じ形の部分型）
 * @param lines - 読み取る行数。既定は SNAPSHOT_LINES
 */
export function readBottomSnapshot(term: SnapshotSource, lines = SNAPSHOT_LINES): string {
  const buf = term.buffer.active;
  const end = buf.baseY + term.rows;
  // 下限を baseY でクランプする。lines が画面の高さを超えても scrollback には遡らない。
  // （0 でクランプすると履歴に流れた過去の承認 UI を拾ってしまう）
  const start = Math.max(buf.baseY, end - lines);

  const out: string[] = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    // getLine は範囲外や未確保の行に undefined を返す。空行として扱わずスキップする。
    if (line) out.push(line.translateToString(true));
  }
  return out.join('\n');
}

/**
 * スナップショットが Claude Code の承認 / 質問 UI を映しているかを判定する。
 *
 * 「問いかけの文言」と「番号付き選択肢の 1 と 2」の**両方**が揃ったときだけ true を返す。
 * 片方だけでは true にしない:
 * - 質問文だけ → Claude が地の文で "Do you want to ..." と書いただけの可能性がある
 * - 選択肢だけ → 手順や箇条書きの "1. ..." "2. ..." と区別できない
 */
export function isBlockedSnapshot(snapshot: string): boolean {
  if (!BLOCKED_QUESTION.test(snapshot)) return false;
  return BLOCKED_CHOICE_1.test(snapshot) && BLOCKED_CHOICE_2.test(snapshot);
}

/**
 * スナップショットと BEL の有無からエージェント状態を確定する。
 *
 * 判定順序（先に一致したものが勝つ）:
 * 1. **blocked** — 応答待ちで止まっている。ユーザーが最も知りたい状態なので最優先。
 *    Claude は承認プロンプトと同時に BEL も鳴らすため、done より先に評価しないと
 *    「完了」と誤表示されてしまう。
 * 2. **working** — 実行中マーカーが出ている。
 * 3. **done** — BEL を受け取っており、かつ実行中でも応答待ちでもない = 処理が終わった。
 * 4. **idle** — 上記のいずれでもない。
 *
 * @param snapshot - readBottomSnapshot の戻り値
 * @param bellPending - 前回の状態確定以降に BEL (\x07) を受信していれば true
 */
export function classifyAgentState(snapshot: string, bellPending: boolean): AgentState {
  if (isBlockedSnapshot(snapshot)) return 'blocked';
  if (WORKING_MARKER.test(snapshot)) return 'working';
  if (bellPending) return 'done';
  return 'idle';
}
