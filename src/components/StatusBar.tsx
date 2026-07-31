import { useAppStore } from '../store/appStore';
import {
  contextLimitFor,
  shortModelName,
  formatTokens,
  formatPercent,
  formatResetAt,
  severityOf,
  hasAnythingToShow,
  type ClaudeTranscriptMeta,
  type ClaudeUsageLimits,
} from '../lib/claudeMeta';

/**
 * 画面下部のステータスバー。
 *
 * Claude Code を起動しているタブについて、**いま何で動いているか**を常時 1 行で見せる:
 * 使用中のモデル・reasoning effort・コンテキストの消費量、それにプランの利用量。
 *
 * どれも Claude Code の画面内では `/status` や `/usage` を打たないと分からず、
 * 打てば会話の流れが途切れる。racker はタブの外側にいるので、
 * 会話を邪魔せずに出せる。
 *
 * 表示するものが何も無いときは **バーごと消す**（空の帯を残さない）。
 */

/** コンテキスト消費量。バーと数値で「あとどれくらい入るか」を示す。 */
function ContextMeter({ meta }: { meta: ClaudeTranscriptMeta }) {
  const tokens = meta.contextTokens;
  if (tokens === undefined) return null;

  const limit = contextLimitFor(meta.model, tokens);
  const percent = Math.min(100, (tokens / limit) * 100);
  const severity = severityOf(percent);

  return (
    <span
      className={`status-bar__context status-bar__context--${severity}`}
      title={`コンテキスト ${tokens.toLocaleString()} / ${limit.toLocaleString()} トークン`}
    >
      <span className="status-bar__bar">
        <span className="status-bar__bar-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="status-bar__context-text">
        {formatTokens(tokens)} / {formatTokens(limit)} ({formatPercent(percent)})
      </span>
    </span>
  );
}

/** プラン利用量 1 枠ぶん。リセット時刻は幅を食うので tooltip に回す。 */
function UsageChip({
  label,
  percent,
  resetsAt,
}: {
  label: string;
  percent: number | undefined;
  resetsAt: string | undefined;
}) {
  if (percent === undefined) return null;

  const reset = formatResetAt(resetsAt);
  const tooltip = reset === undefined
    ? `${label} の使用量 ${formatPercent(percent)}`
    : `${label} の使用量 ${formatPercent(percent)}（${reset} にリセット）`;

  return (
    <span className={`status-bar__usage status-bar__usage--${severityOf(percent)}`} title={tooltip}>
      {label} {formatPercent(percent)}
    </span>
  );
}

/** アクティブタブで動いている Claude の情報（左側）。 */
function ClaudeSection({ meta }: { meta: ClaudeTranscriptMeta }) {
  const model = shortModelName(meta.model);

  return (
    <>
      {model !== undefined && <span className="status-bar__model">{model}</span>}
      {meta.effort !== undefined && (
        <span className="status-bar__effort" title={`reasoning effort: ${meta.effort}`}>
          {meta.effort}
        </span>
      )}
      <ContextMeter meta={meta} />
    </>
  );
}

/** プランの利用量（右側）。タブに依らずアカウント単位の情報。 */
function UsageSection({ usage }: { usage: ClaudeUsageLimits }) {
  return (
    <>
      <UsageChip label="5h" percent={usage.fiveHourPercent} resetsAt={usage.fiveHourResetsAt} />
      <UsageChip label="週" percent={usage.sevenDayPercent} resetsAt={usage.sevenDayResetsAt} />
    </>
  );
}

export function StatusBar() {
  // 未設定は有効として扱う（notificationsEnabled と同じ扱い）
  const enabled = useAppStore((s) => s.settings.statusBarEnabled !== false);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const claudeMeta = useAppStore((s) => s.claudeMeta);
  const usage = useAppStore((s) => s.claudeUsage);

  if (!enabled) return null;

  // ポーリングの往復中にタブが切り替わったとき、前のタブの値を出さない
  const meta = claudeMeta?.tabId === activeTabId ? claudeMeta.meta : null;
  // 出すものが何も無ければ帯ごと消す（空の 1 行を残さない）
  if (!hasAnythingToShow(meta, usage)) return null;

  return (
    <div className="status-bar">
      {meta !== null && <ClaudeSection meta={meta} />}
      <span className="status-bar__spacer" />
      {usage !== null && <UsageSection usage={usage} />}
    </div>
  );
}
