import { invoke } from '@tauri-apps/api/core';

/**
 * Claude タブの「いまの状態」を表示するための情報を組み立てる。
 *
 * 2 系統の情報を扱う:
 *
 * 1. **transcript 由来** (`ClaudeTranscriptMeta`) — 使用中のモデル・effort・
 *    コンテキスト消費量。Claude Code の会話ログの末尾から Rust 側が読む
 * 2. **プラン利用量** (`ClaudeUsageLimits`) — 5 時間ウィンドウと週次の使用率。
 *    Rust 側が Claude の OAuth トークンで API から取る
 *
 * ⚠️ どちらも公式にドキュメント化された経路ではないため、
 * **取れないことを常に許容する**。値が無ければその要素を出さないだけにする
 * (claudeSessions.ts と同じ方針)。
 */

/** Rust の `get_claude_transcript_meta` が返す情報。全フィールドが欠けうる。 */
export interface ClaudeTranscriptMeta {
  /** `'claude-opus-5'` 等の生のモデル ID */
  model?: string;
  /** `'low'` | `'medium'` | `'high'` | `'xhigh'` （将来増えうるため string 型） */
  effort?: string;
  /** いまのコンテキスト長 (トークン) */
  contextTokens?: number;
  /** その応答の timestamp (ISO8601) */
  timestamp?: string;
}

/** Rust の `get_claude_usage` が返すプラン利用量。 */
export interface ClaudeUsageLimits {
  /** 5 時間ウィンドウの使用率 (0〜100) */
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  /** 週次の使用率 (0〜100) */
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
}

/** 200k コンテキストのモデル (Haiku 4.5、Opus / Sonnet 4.5 以前) の上限。 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** 1M コンテキストのモデル (Opus / Sonnet 4.6 以降、Haiku 5 以降、Fable / Mythos) の上限。 */
export const LARGE_CONTEXT_LIMIT = 1_000_000;

/**
 * モデル ID からファミリーとバージョンを取り出す。
 *
 * `claude-opus-5-5` / `claude-opus-4-20250514` / `us.anthropic.claude-sonnet-4-6-v1`
 * / `claude-opus-5-5[1m]` のような表記ゆれを吸収するため、先頭固定にせず
 * `claude-<family>-<major>[-<minor>]` を探す。minor は 1〜2 桁に限る
 * (8 桁の日付サフィックスを minor と読み違えないため)。
 */
function parseModel(model: string): { family: string; major: number; minor: number } | undefined {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (match === null) return undefined;
  return {
    family: match[1].toLowerCase(),
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/**
 * ファミリーごとに「1M が標準になった最初のバージョン」。
 * これ以上なら 1M、未満なら 200k。Fable / Mythos は最初から 1M。
 */
const FIRST_1M_VERSION: Record<string, number> = {
  opus: 4.6,
  sonnet: 4.6,
  haiku: 5,
  fable: 0,
  mythos: 0,
};

/** モデル ID から分かるコンテキスト上限。判別できなければ undefined。 */
function knownContextLimit(model: string): number | undefined {
  // `[1m]` は Claude Code が 1M 版を選んだときに付ける印。それ以外の判断より優先する
  if (/\[1m\]/i.test(model)) return LARGE_CONTEXT_LIMIT;
  // 旧命名 (`claude-3-5-sonnet-...`) は全部 200k
  if (/claude-3/i.test(model)) return DEFAULT_CONTEXT_LIMIT;

  const parsed = parseModel(model);
  if (parsed === undefined) return undefined;

  const version = parsed.major + parsed.minor / 10;
  return version >= FIRST_1M_VERSION[parsed.family] ? LARGE_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT;
}

/**
 * コンテキストの上限を決める。
 *
 * transcript には**上限そのものは書かれていない**ため、モデル ID から決める。
 * Opus / Sonnet 4.6 以降・Haiku 5 以降・Fable / Mythos は 1M が標準
 * (1M が既定かつ最大)、それより前のモデルは 200k。
 *
 * モデル ID から判別できない場合 (未取得・想定外の形) は 200k とし、
 * 実測がそれを超えたら 1M とみなす。どの場合でも実測が上限を超えたら
 * 1M に引き上げるので、「250k / 200k = 125%」のような破綻した表示にはならない。
 */
export function contextLimitFor(model: string | undefined, tokens: number | undefined): number {
  const known = model === undefined ? undefined : knownContextLimit(model);
  const limit = known ?? DEFAULT_CONTEXT_LIMIT;
  if (tokens !== undefined && tokens > limit) return LARGE_CONTEXT_LIMIT;
  return limit;
}

/**
 * モデル ID を短い表示名にする。
 *
 * `claude-opus-5` → `Opus 5` / `claude-haiku-4-5-20251001` → `Haiku 4.5`
 *
 * ステータスバーは 1 行しかないので、`claude-` の接頭辞と日付サフィックスは
 * 情報量に対して場所を取りすぎる。バージョンの区切りは `.` に寄せる
 * (`4-5` は「4.5」であって「4 と 5」ではない)。
 *
 * 想定外の形 (`<synthetic>` 等) は加工せずそのまま返す。捨てるより、
 * 見慣れない文字列が出たほうが「何かがおかしい」と気付ける。
 */
export function shortModelName(model: string | undefined): string | undefined {
  if (model === undefined || model.length === 0) return undefined;

  const withoutPrefix = model.replace(/^claude-/, '');
  // 末尾の日付 (20251001) はビルドの識別子で、ユーザーには意味がない
  const withoutDate = withoutPrefix.replace(/-\d{8}$/, '');

  const match = /^([a-z]+)-([\d-]+)$/i.exec(withoutDate);
  if (match === null) return withoutDate;

  const [, family, version] = match;
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  return `${label} ${version.replace(/-/g, '.')}`;
}

/**
 * トークン数を短く表す。`55_002` → `55k` / `1_240_000` → `1.2M` / `1_000_000` → `1M`
 *
 * 1000 未満はそのまま、10k 未満は小数第 1 位まで残す
 * (`8.4k` と `8k` では読み取れる情報が違う)。
 * M 単位で端数が無いときは `.0` を落とす (上限の `1M` が `1.0M` と出るのを避ける)。
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** 使用率の表示。小数は落とす (0.5% の差に意味はない)。 */
export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/**
 * 表示上の深刻度。色分けに使う。
 *
 * 閾値は「まだ余裕がある / そろそろ意識する / 詰まっている」の 3 段階。
 * コンテキストも利用量も同じ感覚で読めるよう、閾値を共通にしている。
 */
export type MeterSeverity = 'normal' | 'warn' | 'critical';

export function severityOf(percent: number): MeterSeverity {
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warn';
  return 'normal';
}

/**
 * リセット時刻を短く表す。
 *
 * 同じ日なら時刻だけ (`16:00`)、日をまたぐなら日付を添える (`8/6 09:00`)。
 * 「あと何時間で回復するか」がひと目で分かればよく、秒や年は要らない。
 *
 * パースできない文字列は undefined を返す (表示から落とす)。
 */
export function formatResetAt(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/**
 * 利用量を引き直すまでの最小間隔 (ms)。
 *
 * ウィンドウが前面に戻るたびに引き直すため、これが無いと
 * **ウィンドウを行き来するだけで API を叩き続ける**ことになる。
 * 利用率は分単位でしか動かないので、1 分空けても表示は実用上変わらない。
 */
export const USAGE_MIN_INTERVAL_MS = 60_000;

/**
 * いま利用量を取りに行くべきかを決める純関数。
 *
 * - 初回は無条件に引く（起動直後に表示が空のままになるのを避ける）
 * - 裏に回っているあいだは引かない（見ていない画面のために API を叩かない）
 * - 前回取得から `minIntervalMs` 経っていなければ引かない
 *
 * @param sinceLastMs - 前回取得からの経過 (ms)
 */
export function shouldFetchUsage(
  isFocused: boolean,
  hasEverFetched: boolean,
  sinceLastMs: number,
  minIntervalMs: number = USAGE_MIN_INTERVAL_MS,
): boolean {
  if (!hasEverFetched) return true;
  if (!isFocused) return false;
  return sinceLastMs >= minIntervalMs;
}

/**
 * ステータスバーに出せる情報がひとつでもあるか。
 *
 * 何も無いときは**バーごと消す**ために使う。空の帯が残っていると
 * 「表示すべき何かが壊れている」ように見えるうえ、ターミナルの高さを
 * 無意味に 1 行削ることになる。
 *
 * Claude Code の形式が変わってフィールドが全部 undefined になった場合にも、
 * ここで拾って消える。
 */
export function hasAnythingToShow(
  meta: ClaudeTranscriptMeta | null,
  usage: ClaudeUsageLimits | null,
): boolean {
  const hasMeta =
    meta !== null &&
    (meta.model !== undefined || meta.effort !== undefined || meta.contextTokens !== undefined);
  const hasUsage =
    usage !== null &&
    (usage.fiveHourPercent !== undefined || usage.sevenDayPercent !== undefined);
  return hasMeta || hasUsage;
}

/**
 * transcript を読みに行く頻度（Claude セッションのポーリング何回に 1 回か）。
 *
 * セッションの巡回は 2 秒ごとだが、こちらはそこまで細かく要らない。
 * モデルや effort は会話の途中でめったに変わらず、コンテキスト量も
 * 1 往復ごとにしか動かない。さらに WSL タブでは 9P 越しのファイル読み取りに
 * なるため、間引くほど停止中の WSL を起こさずに済む。
 */
export const TRANSCRIPT_POLL_EVERY_N_TICKS = 3;

/**
 * この tick で transcript を読むかを決める純関数。
 *
 * 初回 (tick 0) は必ず読む。起動直後にモデル表示が数秒空白になるのを避ける。
 */
export function shouldPollTranscript(
  tickCount: number,
  everyN: number = TRANSCRIPT_POLL_EVERY_N_TICKS,
): boolean {
  if (everyN <= 1) return true;
  return tickCount % everyN === 0;
}

/**
 * transcript から現在のモデル・effort・コンテキスト量を取得する。
 *
 * `cwd` は **Claude が申告した作業ディレクトリ**を渡すこと (タブの cwd ではない)。
 * ログの保存先はこの文字列から決まるため、表記が違うと引き当てられない。
 * `distro` は WSL 側のセッションのときだけ指定する。
 *
 * 失敗時は null（Claude Code の形式変更・ログ未生成・セッション未特定）。
 */
export async function getTranscriptMeta(
  sessionId: string,
  cwd: string | undefined,
  distro: string | undefined,
): Promise<ClaudeTranscriptMeta | null> {
  try {
    const meta = await invoke<ClaudeTranscriptMeta | null>('get_claude_transcript_meta', {
      sessionId,
      cwd,
      distro,
    });
    return meta ?? null;
  } catch (e) {
    console.warn('[claudeMeta] get_claude_transcript_meta failed:', e);
    return null;
  }
}

/**
 * プランの利用量 (5 時間 / 週次) を取得する。
 *
 * Anthropic の API を叩くので **数分に 1 回**まで。利用率は分単位でしか動かず、
 * 短い間隔で呼ぶ意味がない。
 *
 * 失敗時は null（未ログイン・オフライン・API の仕様変更）。
 */
export async function getUsageLimits(): Promise<ClaudeUsageLimits | null> {
  try {
    return (await invoke<ClaudeUsageLimits | null>('get_claude_usage')) ?? null;
  } catch (e) {
    console.warn('[claudeMeta] get_claude_usage failed:', e);
    return null;
  }
}
