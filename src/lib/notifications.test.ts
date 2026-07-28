import { describe, it, expect, vi } from 'vitest';
import { shouldNotify, notificationBody, notificationTitle } from './notifications';

// Tauri プラグインは jsdom では動かないため、モジュールごとモックする。
// ここでテストするのは「いつ・何を通知するか」の判断であり、送信そのものではない。
vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
}));

describe('shouldNotify', () => {
  it('1: 非アクティブタブが blocked になったら通知する', () => {
    expect(shouldNotify('working', 'blocked', false)).toBe('blocked');
  });

  it('2: 非アクティブタブが done になったら通知する', () => {
    expect(shouldNotify('working', 'done', false)).toBe('done');
  });

  it('3: アクティブタブは通知しない（見えているものを知らせる意味がない）', () => {
    expect(shouldNotify('working', 'blocked', true)).toBeNull();
    expect(shouldNotify('working', 'done', true)).toBeNull();
  });

  it('4: 状態が変わっていなければ通知しない（blocked のまま鳴り続けさせない）', () => {
    expect(shouldNotify('blocked', 'blocked', false)).toBeNull();
    expect(shouldNotify('done', 'done', false)).toBeNull();
  });

  it('5: working / idle への遷移は通知しない', () => {
    expect(shouldNotify('idle', 'working', false)).toBeNull();
    expect(shouldNotify('done', 'idle', false)).toBeNull();
  });

  it('6: 未検出から blocked への遷移も通知する（起動直後に応答待ちを見つけた場合）', () => {
    expect(shouldNotify(undefined, 'blocked', false)).toBe('blocked');
  });

  it('7: 状態が消えた（undefined になった）ときは通知しない', () => {
    expect(shouldNotify('blocked', undefined, false)).toBeNull();
  });
});

describe('notificationTitle', () => {
  it('8: 種類ごとに異なるタイトルを返す', () => {
    expect(notificationTitle('blocked')).toBe('Claude が応答待ちです');
    expect(notificationTitle('done')).toBe('Claude の処理が完了しました');
  });
});

describe('notificationBody', () => {
  it('9: どのタブの話かが分かるようタブ名を含める', () => {
    expect(notificationBody('blocked', 'racker-terminal')).toContain('racker-terminal');
    expect(notificationBody('done', 'linkc-mobile')).toContain('linkc-mobile');
  });

  it('10: 応答待ちの理由があれば添える', () => {
    expect(notificationBody('blocked', 'my-tab', 'input needed')).toBe(
      'my-tab が応答を待っています（input needed）',
    );
  });

  it('11: 理由が無ければ理由なしの文面になる', () => {
    expect(notificationBody('blocked', 'my-tab')).toBe('my-tab が応答を待っています');
  });

  it('12: 完了通知では理由を使わない', () => {
    expect(notificationBody('done', 'my-tab', 'input needed')).toBe(
      'my-tab の処理が完了しました',
    );
  });
});
