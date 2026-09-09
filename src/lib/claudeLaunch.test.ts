import { describe, it, expect } from 'vitest';
import {
  planClaudeLaunch,
  MANUAL_RESUME_MAX_AGE_MS,
  type ClaudeLaunchTab,
} from './claudeLaunch';

/** 実データと同じ UUID 形式のセッション ID。isSessionId を通る形にしておく
 *  （UUID でない ID はシェルへ渡す前に捨てられるため、ダミーでも形を合わせる）。 */
const SESS = '3f359448-17ed-4b3c-add4-5d85007efc91';
const ISSUED = '9c1f2b7a-0d44-4e21-9b8e-6a1f5c30d2e7';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * 「Windows 側で手動 claude を使い、直前まで生きていた」タブを組み立てる。
 * 各テストは崩したい条件だけを上書きする。
 */
function manualTab(overrides: Partial<ClaudeLaunchTab> = {}): ClaudeLaunchTab {
  return {
    claudeSessionId: SESS,
    claudeSessionCwd: 'C:\\dev\\racker-terminal',
    claudeSessionLive: true,
    claudeSeenAt: NOW - 60_000,
    cwd: 'C:\\dev\\racker-terminal',
    ...overrides,
  };
}

describe('planClaudeLaunch — launchClaude=true の Claude タブ（従来どおり）', () => {
  it('1: セッション ID があれば resume し、bypassPermissions を引き継ぐ', () => {
    const plan = planClaudeLaunch(
      { launchClaude: true, claudeSessionId: ISSUED, bypassPermissions: true },
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'resume', sessionId: ISSUED, bypass: true });
  });

  it('2: bypassPermissions が未設定なら bypass=false', () => {
    const plan = planClaudeLaunch({ launchClaude: true, claudeSessionId: ISSUED }, { now: NOW });
    expect(plan).toEqual({ kind: 'resume', sessionId: ISSUED, bypass: false });
  });

  it('3: セッション ID が無ければ new（UUID の発番は呼び出し側の責務）', () => {
    const plan = planClaudeLaunch({ launchClaude: true }, { now: NOW });
    expect(plan).toEqual({ kind: 'new' });
  });

  it('4: 手動タブ向けのゲート（live / 鮮度 / 階層一致）は適用しない', () => {
    // live=false・4 ヶ月前の観測・階層も食い違う、という手動タブなら全部落ちる条件でも
    // launchClaude=true なら従来どおり resume する（ユーザーが明示した Claude タブのため）。
    const plan = planClaudeLaunch(
      {
        launchClaude: true,
        claudeSessionId: ISSUED,
        claudeSessionLive: false,
        claudeSeenAt: NOW - 120 * DAY,
        claudeSessionCwd: 'C:\\somewhere\\else',
        cwd: 'C:\\dev\\racker-terminal',
      },
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'resume', sessionId: ISSUED, bypass: false });
  });
});

describe('planClaudeLaunch — 手動起動タブの復元', () => {
  it('5: live=true・鮮度 OK・階層一致なら resume する（new ではない）', () => {
    const plan = planClaudeLaunch(manualTab(), { now: NOW });
    // 自動起動 OFF のタブで新しい会話を勝手に始めてはいけないので、
    // 「new ではない」ことを明示的に固定する（新規 UUID 発番の誤爆防止）。
    expect(plan.kind).toBe('resume');
    expect(plan.kind).not.toBe('new');
    expect(plan).toEqual({ kind: 'resume', sessionId: SESS, bypass: false });
  });

  it('6: bypass は必ず false（--dangerously-skip-permissions は引き継がない）', () => {
    // 手動で打ったときにバイパスを付けていたかはセッションファイルに残らないため、
    // タブに bypassPermissions が立っていても推測で権限を緩めない。
    const plan = planClaudeLaunch(manualTab({ bypassPermissions: true }), { now: NOW });
    expect(plan).toEqual({ kind: 'resume', sessionId: SESS, bypass: false });
  });

  it('7: セッション ID が無ければ none（new には倒さない）', () => {
    const plan = planClaudeLaunch(manualTab({ claudeSessionId: undefined }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('8: live=false なら none（自分で /exit したタブは復活させない）', () => {
    const plan = planClaudeLaunch(manualTab({ claudeSessionLive: false }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('9: live が未設定なら none（一度も生存を観測していない）', () => {
    const plan = planClaudeLaunch(manualTab({ claudeSessionLive: undefined }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('10: 最後の観測が 8 日前なら none（記録が古すぎる）', () => {
    const plan = planClaudeLaunch(manualTab({ claudeSeenAt: NOW - 8 * DAY }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('11: claudeSeenAt が未設定なら none（いつの観測か分からない）', () => {
    const plan = planClaudeLaunch(manualTab({ claudeSeenAt: undefined }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('12: 鮮度のしきい値ちょうど（7 日前）はまだ復元する', () => {
    const plan = planClaudeLaunch(
      manualTab({ claudeSeenAt: NOW - MANUAL_RESUME_MAX_AGE_MS }),
      { now: NOW },
    );
    expect(plan.kind).toBe('resume');
  });

  it('13: maxAgeMs を渡すと既定より短いしきい値にできる', () => {
    const tab = manualTab({ claudeSeenAt: NOW - 2 * DAY });
    expect(planClaudeLaunch(tab, { now: NOW }).kind).toBe('resume');
    expect(planClaudeLaunch(tab, { now: NOW, maxAgeMs: DAY }).kind).toBe('none');
  });

  it('14: 記録した階層と今から開く階層が違えば none（claude を抜けてから cd したケース）', () => {
    // `claude --resume` は cwd が違っても成功し、前回の会話を新しいディレクトリに対して
    // 継続してしまう。別リポジトリで会話の続きが走る事故を、ここで構造的に止める。
    const plan = planClaudeLaunch(
      manualTab({ cwd: 'C:\\dev\\other-repo' }),
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'none' });
  });

  it('15: 階層が同じなら大文字小文字が違っても復元する（Windows パス）', () => {
    const plan = planClaudeLaunch(
      manualTab({ claudeSessionCwd: 'C:\\Dev\\Racker-Terminal\\' }),
      { now: NOW },
    );
    expect(plan.kind).toBe('resume');
  });

  it('16: claudeSessionCwd が未設定なら none（照合できないものを復元しない）', () => {
    const plan = planClaudeLaunch(manualTab({ claudeSessionCwd: undefined }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('17: distro が args の -d と違えば none（同じ Linux パスは distro をまたいで存在する）', () => {
    const plan = planClaudeLaunch(
      manualTab({
        shell: 'wsl.exe',
        args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/dev'],
        cwd: undefined,
        claudeSessionCwd: '/home/me/dev',
        claudeSessionDistro: 'Debian',
      }),
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'none' });
  });

  it('18: WSL タブの `--cd ~` はホームを解決して復元する（既定お気に入りの疎通）', () => {
    const plan = planClaudeLaunch(
      manualTab({
        shell: 'wsl.exe',
        args: ['-d', 'Ubuntu-22.04', '--cd', '~'],
        cwd: undefined,
        claudeSessionCwd: '/home/me',
        claudeSessionDistro: 'Ubuntu-22.04',
      }),
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'resume', sessionId: SESS, bypass: false });
  });

  it('19: WSL タブは Windows 側で観測した記録（distro 未設定）とは一致しない', () => {
    const plan = planClaudeLaunch(
      manualTab({
        shell: 'wsl.exe',
        args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/dev'],
        cwd: undefined,
        claudeSessionCwd: '/home/me/dev',
        claudeSessionDistro: undefined,
      }),
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'none' });
  });

  it('20: WSL の `--cd <絶対パス>` と distro が揃えば復元する', () => {
    const plan = planClaudeLaunch(
      manualTab({
        shell: 'wsl.exe',
        args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev/uranus2'],
        cwd: undefined,
        claudeSessionCwd: '/home/me/jdf-dev/uranus2',
        claudeSessionDistro: 'Ubuntu-22.04',
      }),
      { now: NOW },
    );
    expect(plan.kind).toBe('resume');
  });
});

describe('MANUAL_RESUME_MAX_AGE_MS', () => {
  it('21: 手動タブの記録は 7 日で失効する（セッション側の 3 日より緩い）', () => {
    expect(MANUAL_RESUME_MAX_AGE_MS).toBe(7 * DAY);
  });
});

describe('planClaudeLaunch — セッション ID の形（シェルへ渡す最後の関門）', () => {
  it('22: UUID の形をしていない ID では手動タブを復元しない', () => {
    // claudeSessions の入口でも捨てているが、永続化済みの古い値が残っていることがある。
    // `claude --resume <id>` は引用符なしで組み立てられるため、ここでも必ず確かめる。
    const plan = planClaudeLaunch(manualTab({ claudeSessionId: 'x; calc.exe' }), { now: NOW });
    expect(plan).toEqual({ kind: 'none' });
  });

  it('23: Claude タブで ID が壊れていたら new に倒す（claude は必ず立てる）', () => {
    // 自動起動 ON のタブは「claude で開く」とユーザーが明示しているので、
    // 壊れた ID を resume に流す代わりに新しい会話を発番し直す。
    const plan = planClaudeLaunch(
      { launchClaude: true, claudeSessionId: 'x; calc.exe' },
      { now: NOW },
    );
    expect(plan).toEqual({ kind: 'new' });
  });
});
