import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { resolveRelaunchedTabs } from './ClaudeSessionsRoot';
import {
  adoptableTabIds,
  matchSessionsToTabs,
  type ClaudeSession,
} from '../../lib/claudeSessions';
import { planClaudeLaunch } from '../../lib/claudeLaunch';
import { useAppStore } from '../../store/appStore';

const RECORDED = 'aab34766-6f27-4fce-ba6d-3c77f2dbcfab';
const MANUAL = '7df4caf0-ba89-4e46-883d-2f4c45cfa556';
const CWD = 'C:\\Users\\me\\dev\\racker-terminal';

/** invoke のうち claude_transcript_exists だけに答える。 */
function transcriptExistsReturns(value: boolean | null): void {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'claude_transcript_exists') return value;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

function transcriptCalls(): number {
  return vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'claude_transcript_exists').length;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useAppStore.setState({
    groups: [],
    tabs: {},
    favorites: [],
    activeTabId: null,
    activeGroupId: null,
    lastActiveTabByGroup: {},
    editingId: null,
    closedTabs: [],
  });
});

/**
 * 起動時の `--resume RECORDED` が失敗したあと、同じタブで自分で claude を打ち直した状態を作る。
 * 返すのは巡回 1 回ぶんの材料。
 */
function relaunchedTabScenario() {
  const g = useAppStore.getState().createGroup('G');
  const tabId = useAppStore.getState().createTab(g, {
    launchClaude: true,
    claudeSessionId: RECORDED,
    cwd: CWD,
    shell: 'nu',
  });
  useAppStore.getState().setTabStatus(tabId, 'live', 'pty-1');
  const liveSince = useAppStore.getState().tabs[tabId].liveSince!;
  const session: ClaudeSession = {
    sessionId: MANUAL,
    cwd: CWD,
    status: 'busy',
    startedAt: liveSince + 540_000,
  };
  return { tabId, session };
}

/** ClaudeSessionsRoot の巡回 1 回ぶん（照合 → 乗り換え判定 → 反映）を通す。 */
async function pollOnce(sessions: ClaudeSession[], known = new Set<string>()) {
  const tabs = Object.values(useAppStore.getState().tabs);
  const forMatch = tabs.map((t) => ({
    id: t.id, cwd: t.cwd, args: t.args, claudeSessionId: t.claudeSessionId, shell: t.shell,
  }));
  const matches = matchSessionsToTabs(sessions, forMatch);
  const adoptable = adoptableTabIds(sessions, forMatch, matches);
  const relaunched = await resolveRelaunchedTabs(tabs, matches, adoptable, known);
  useAppStore.getState().applyClaudeSessions(matches, { adoptable, relaunched });
}

describe('resolveRelaunchedTabs — --resume が失敗して打ち直した Claude タブ', () => {
  it('記録した会話のログが無ければ、いま動いている会話へ乗り換え、次の起動でそれを resume する', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);

    await pollOnce([session]);

    const tab = useAppStore.getState().tabs[tabId];
    expect(tab.claudeSessionId).toBe(MANUAL);
    // 再起動したときに開く会話（修正前は RECORDED を開こうとして失敗していた）
    expect(planClaudeLaunch(tab, { now: Date.now() })).toEqual({
      kind: 'resume', sessionId: MANUAL, bypass: false,
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('claude_transcript_exists', {
      sessionId: RECORDED, cwd: CWD, distro: undefined,
    });
  });

  it('記録した会話のログが残っていれば乗り換えない（--resume で戻れるほうを優先する）', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(true);

    await pollOnce([session]);

    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(RECORDED);
  });

  it('ログの有無を調べられなければ乗り換えない', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(null);

    await pollOnce([session]);

    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(RECORDED);
  });

  it('ログがあると分かった ID は次の巡回から問い合わせ直さない', async () => {
    const { session } = relaunchedTabScenario();
    transcriptExistsReturns(true);
    const known = new Set<string>();

    await pollOnce([session], known);
    await pollOnce([session], known);

    expect(transcriptCalls()).toBe(1);
  });

  it('タブを開く前から別の場所で動いていた claude には乗り換えない', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);
    const liveSince = useAppStore.getState().tabs[tabId].liveSince!;

    await pollOnce([{ ...session, startedAt: liveSince - 60_000 }]);

    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(RECORDED);
    expect(transcriptCalls()).toBe(0);
  });

  it('同じフォルダに claude が 2 つ動いている（1 対 1 でない）なら乗り換えない', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);
    const other = { ...session, sessionId: '11111111-2222-4333-8444-555555555555' };

    await pollOnce([session, other]);

    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(RECORDED);
    expect(transcriptCalls()).toBe(0);
  });

  it('記録した会話そのものが動いているタブは何も問い合わせない（通常の Claude タブ）', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);

    await pollOnce([{ ...session, sessionId: RECORDED }]);

    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(RECORDED);
    expect(transcriptCalls()).toBe(0);
  });
});
