import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { reflectSessions } from './ClaudeSessionsRoot';
import type { ClaudeSession } from '../../lib/claudeSessions';
import { planClaudeLaunch } from '../../lib/claudeLaunch';
import { useAppStore } from '../../store/appStore';

const RECORDED = 'aab34766-6f27-4fce-ba6d-3c77f2dbcfab';
const MANUAL = '7df4caf0-ba89-4e46-883d-2f4c45cfa556';
const CWD = 'C:\\Users\\me\\dev\\racker-terminal';
/** タブの PTY が起動した時刻（時計を固定して決める） */
const LIVE_SINCE = 1_795_569_285_000;
/** 打ち直した claude が始まった時刻（PTY 起動の 9 分後） */
const RELAUNCHED_AT = LIVE_SINCE + 540_000;

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
  vi.useFakeTimers();
  vi.setSystemTime(LIVE_SINCE);
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

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 起動時の `--resume RECORDED` が失敗したあと、同じタブで自分で claude を打ち直した状態を作る。
 * PTY は LIVE_SINCE に起動し、時計は打ち直した直後まで進めておく。
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
  vi.setSystemTime(RELAUNCHED_AT + 1_000);
  const session: ClaudeSession = {
    sessionId: MANUAL,
    cwd: CWD,
    status: 'busy',
    startedAt: RELAUNCHED_AT,
    updatedAt: RELAUNCHED_AT,
  };
  return { tabId, session };
}

/** ClaudeSessionsRoot の巡回 1 回ぶんを、本体と同じ関数で通す。 */
function pollOnce(sessions: ClaudeSession[], known = new Set<string>()) {
  return reflectSessions(sessions, [], known, () => false);
}

describe('reflectSessions — --resume が失敗して打ち直した Claude タブ', () => {
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

  it('乗り換えたあとの巡回では問い合わせず、タブも書き換えない（I/O と再レンダーを増やさない）', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);
    const known = new Set<string>();

    await pollOnce([session], known);
    const afterFirst = useAppStore.getState().tabs[tabId];
    await pollOnce([session], known);
    await pollOnce([session], known);

    expect(transcriptCalls()).toBe(1);
    expect(useAppStore.getState().tabs[tabId]).toBe(afterFirst);
  });

  it('PTY の起動と同時刻に始まった claude も、タブの中で始まったものとして扱う', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);

    await pollOnce([{ ...session, startedAt: LIVE_SINCE }]);

    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(MANUAL);
  });

  it('記録した会話のログが残っていれば乗り換えない（--resume で戻れるほうを優先する）', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(true);

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

  it('ログの有無を調べられなければ乗り換えず、次の巡回で問い合わせ直す', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(null);
    const known = new Set<string>();

    await pollOnce([session], known);
    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(RECORDED);

    // 一時的に調べられなかっただけなら、次に分かった時点で直る
    transcriptExistsReturns(false);
    await pollOnce([session], known);
    expect(useAppStore.getState().tabs[tabId].claudeSessionId).toBe(MANUAL);
  });

  it('タブを開く前から別の場所で動いていた claude には乗り換えない', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);

    await pollOnce([{ ...session, startedAt: LIVE_SINCE - 60_000 }]);

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

  it('問い合わせのあいだに巡回が止められたら、何も反映しない', async () => {
    const { tabId, session } = relaunchedTabScenario();
    transcriptExistsReturns(false);
    const before = useAppStore.getState().tabs[tabId];

    const result = await reflectSessions([session], [], new Set(), () => true);

    expect(result).toBeNull();
    expect(useAppStore.getState().tabs[tabId]).toBe(before);
  });
});
