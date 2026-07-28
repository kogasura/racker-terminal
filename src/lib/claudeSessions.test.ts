import { describe, it, expect } from 'vitest';
import {
  agentStateFromStatus,
  isShellStatus,
  normalizeCwd,
  tabCwdForMatch,
  matchSessionsToTabs,
  nextAgentStateFromSession,
  collectWslDistros,
  type ClaudeSession,
} from './claudeSessions';

describe('agentStateFromStatus', () => {
  it('1: waiting → blocked（応答待ち）', () => {
    expect(agentStateFromStatus('waiting')).toBe('blocked');
  });

  it('2: busy → working', () => {
    expect(agentStateFromStatus('busy')).toBe('working');
  });

  it('3: shell → working（コマンド実行中も「動いている」として統合する）', () => {
    expect(agentStateFromStatus('shell')).toBe('working');
  });

  it('4: idle → idle', () => {
    expect(agentStateFromStatus('idle')).toBe('idle');
  });

  it('5: 未知の値は undefined（画面判定へフォールバックさせる）', () => {
    expect(agentStateFromStatus('brand-new-status')).toBeUndefined();
    expect(agentStateFromStatus(undefined)).toBeUndefined();
  });

  it('6: done は status からは決まらない（Claude 側に存在しないため）', () => {
    const states = ['waiting', 'busy', 'shell', 'idle'].map(agentStateFromStatus);
    expect(states).not.toContain('done');
  });
});

describe('isShellStatus', () => {
  it('7: shell のときだけ true', () => {
    expect(isShellStatus('shell')).toBe(true);
    expect(isShellStatus('busy')).toBe(false);
    expect(isShellStatus(undefined)).toBe(false);
  });
});

describe('nextAgentStateFromSession', () => {
  it('26: working / blocked はそのまま反映される', () => {
    expect(nextAgentStateFromSession('idle', 'busy', false)).toBe('working');
    expect(nextAgentStateFromSession('working', 'waiting', false)).toBe('blocked');
    expect(nextAgentStateFromSession('idle', 'shell', false)).toBe('working');
  });

  it('27: working → idle の遷移は done になる（処理が完了した）', () => {
    expect(nextAgentStateFromSession('working', 'idle', false)).toBe('done');
  });

  it('28: done は idle が続いても維持される（見るまで消さない）', () => {
    expect(nextAgentStateFromSession('done', 'idle', false)).toBe('done');
  });

  it('29: アクティブタブでは done にせず idle にする', () => {
    expect(nextAgentStateFromSession('working', 'idle', true)).toBe('idle');
    expect(nextAgentStateFromSession('done', 'idle', true)).toBe('idle');
  });

  it('30: blocked → idle は done にしない（ダイアログのキャンセル等で誤検出しないため）', () => {
    expect(nextAgentStateFromSession('blocked', 'idle', false)).toBe('idle');
  });

  it('31: idle が続いても done にはならない', () => {
    expect(nextAgentStateFromSession('idle', 'idle', false)).toBe('idle');
    expect(nextAgentStateFromSession(undefined, 'idle', false)).toBe('idle');
  });

  it('32: 未知の status では前の状態を保つ（勝手に消さない）', () => {
    expect(nextAgentStateFromSession('working', 'brand-new', false)).toBe('working');
    expect(nextAgentStateFromSession('blocked', undefined, false)).toBe('blocked');
  });
});

describe('collectWslDistros', () => {
  it('33: -d の次の値を distro として集める', () => {
    const tabs = [
      { args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me'] },
      { args: ['-d', 'Debian'] },
    ];
    expect(collectWslDistros(tabs).sort()).toEqual(['Debian', 'Ubuntu-22.04']);
  });

  it('34: 重複は 1 つにまとめる', () => {
    const tabs = [{ args: ['-d', 'Ubuntu-22.04'] }, { args: ['-d', 'Ubuntu-22.04'] }];
    expect(collectWslDistros(tabs)).toEqual(['Ubuntu-22.04']);
  });

  it('35: WSL タブが無ければ空（停止中の WSL を起こさないため重要）', () => {
    expect(collectWslDistros([{ args: ['-NoLogo'] }, {}])).toEqual([]);
  });

  it('36: -d が末尾で値が無いときは無視する', () => {
    expect(collectWslDistros([{ args: ['-d'] }])).toEqual([]);
  });
});

describe('normalizeCwd', () => {
  it('8: Windows パスは区切りを統一し小文字化する', () => {
    expect(normalizeCwd('C:\\Users\\Me\\Dev')).toBe('c:/users/me/dev');
  });

  it('9: Windows パスの大小差は同一視される', () => {
    expect(normalizeCwd('C:\\Users\\Me')).toBe(normalizeCwd('c:/users/me'));
  });

  it('10: Linux パスは大小を区別する（別ディレクトリを同一視しないため）', () => {
    expect(normalizeCwd('/home/me/Dev')).toBe('/home/me/Dev');
    expect(normalizeCwd('/home/me/Dev')).not.toBe(normalizeCwd('/home/me/dev'));
  });

  it('11: 末尾の区切りは落とす', () => {
    expect(normalizeCwd('/home/me/dev/')).toBe('/home/me/dev');
    expect(normalizeCwd('C:\\Users\\Me\\')).toBe('c:/users/me');
  });

  it('12: undefined / 空文字は null（照合対象から外す）', () => {
    expect(normalizeCwd(undefined)).toBeNull();
    expect(normalizeCwd('')).toBeNull();
    expect(normalizeCwd('   ')).toBeNull();
  });
});

describe('tabCwdForMatch', () => {
  it('13: WSL タブは --cd の Linux パスを優先する', () => {
    const tab = {
      id: 't1',
      cwd: 'C:\\Users\\me',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/dev'],
    };
    expect(tabCwdForMatch(tab)).toBe('/home/me/dev');
  });

  it('14: --cd が ~ のときは解決できないので cwd に戻る', () => {
    const tab = { id: 't1', cwd: 'C:\\Users\\me', args: ['--cd', '~'] };
    expect(tabCwdForMatch(tab)).toBe('c:/users/me');
  });

  it('15: --cd が無ければ cwd を使う', () => {
    expect(tabCwdForMatch({ id: 't1', cwd: 'C:\\dev' })).toBe('c:/dev');
  });

  it('16: cwd も引数も無ければ null', () => {
    expect(tabCwdForMatch({ id: 't1' })).toBeNull();
  });
});

describe('matchSessionsToTabs', () => {
  const sessionA: ClaudeSession = {
    pid: 1,
    sessionId: 'sess-a',
    cwd: 'C:\\dev\\alpha',
    status: 'busy',
    startedAt: 100,
  };
  const sessionB: ClaudeSession = {
    pid: 2,
    sessionId: 'sess-b',
    cwd: 'C:\\dev\\beta',
    status: 'idle',
    startedAt: 200,
  };

  it('17: セッション ID が一致するタブへ結びつける', () => {
    const tabs = [{ id: 't1', claudeSessionId: 'sess-b' }];

    const m = matchSessionsToTabs([sessionA, sessionB], tabs);

    expect(m.get('t1')).toBe(sessionB);
  });

  it('18: ID 一致は cwd より優先される（同じ cwd でも取り違えない）', () => {
    // 2 タブとも cwd が同じだが、t2 は ID を持っている
    const tabs = [
      { id: 't1', cwd: 'C:\\dev\\alpha' },
      { id: 't2', cwd: 'C:\\dev\\alpha', claudeSessionId: 'sess-a' },
    ];

    const m = matchSessionsToTabs([sessionA], tabs);

    expect(m.get('t2')).toBe(sessionA);
    expect(m.has('t1')).toBe(false);
  });

  it('19: 手動起動タブ（ID なし）は cwd 一致で結びつける', () => {
    const tabs = [{ id: 't1', cwd: 'C:\\dev\\beta' }];

    const m = matchSessionsToTabs([sessionA, sessionB], tabs);

    expect(m.get('t1')).toBe(sessionB);
  });

  it('20: cwd の大小差があっても Windows パスなら結びつく', () => {
    const tabs = [{ id: 't1', cwd: 'c:/DEV/Alpha' }];

    const m = matchSessionsToTabs([sessionA], tabs);

    expect(m.get('t1')).toBe(sessionA);
  });

  it('21: 同じ cwd に複数タブがあるとき 1 セッションは 1 タブにだけ割り当てる', () => {
    const tabs = [
      { id: 't1', cwd: 'C:\\dev\\alpha' },
      { id: 't2', cwd: 'C:\\dev\\alpha' },
    ];

    const m = matchSessionsToTabs([sessionA], tabs);

    expect(m.size).toBe(1);
  });

  it('22: cwd を持たないセッションは割り当てない', () => {
    const noCwd: ClaudeSession = { pid: 9, sessionId: 'sess-x', status: 'busy' };
    const tabs = [{ id: 't1' }];

    expect(matchSessionsToTabs([noCwd], tabs).size).toBe(0);
  });

  it('23: WSL タブは --cd の Linux パスでセッションと結びつく', () => {
    const wslSession: ClaudeSession = {
      pid: 3,
      sessionId: 'sess-w',
      cwd: '/home/me/dev/app',
      status: 'waiting',
      distro: 'Ubuntu-22.04',
      startedAt: 300,
    };
    const tabs = [{ id: 't1', args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/dev/app'] }];

    const m = matchSessionsToTabs([wslSession], tabs);

    expect(m.get('t1')).toBe(wslSession);
  });

  it('24: 該当なしのときは空', () => {
    const tabs = [{ id: 't1', cwd: 'C:\\dev\\other' }];
    expect(matchSessionsToTabs([sessionA], tabs).size).toBe(0);
  });

  it('25: 開始が早いセッションから順に割り当てる', () => {
    // 同じ cwd に 2 セッション、タブも 2 つ。早い方が先に埋まる
    const older: ClaudeSession = { pid: 1, sessionId: 's-old', cwd: 'C:\\dev\\x', startedAt: 10 };
    const newer: ClaudeSession = { pid: 2, sessionId: 's-new', cwd: 'C:\\dev\\x', startedAt: 20 };
    const tabs = [
      { id: 't1', cwd: 'C:\\dev\\x' },
      { id: 't2', cwd: 'C:\\dev\\x' },
    ];

    const m = matchSessionsToTabs([newer, older], tabs);

    expect(m.get('t1')).toBe(older);
    expect(m.get('t2')).toBe(newer);
  });
});
