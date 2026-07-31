import { describe, it, expect } from 'vitest';
import {
  contextLimitFor,
  shortModelName,
  formatTokens,
  formatPercent,
  severityOf,
  formatResetAt,
  hasAnythingToShow,
  shouldFetchUsage,
  shouldPollTranscript,
  DEFAULT_CONTEXT_LIMIT,
  LARGE_CONTEXT_LIMIT,
} from './claudeMeta';

describe('contextLimitFor', () => {
  it('1: 既定は 200k', () => {
    expect(contextLimitFor('claude-opus-5', 50_000)).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it('2: 実測が 200k を超えたら 1M 版とみなす（transcript に上限が書かれていないため）', () => {
    expect(contextLimitFor('claude-opus-5', 250_000)).toBe(LARGE_CONTEXT_LIMIT);
  });

  it('3: モデル ID に 1m があれば実測を待たずに 1M 扱いにする', () => {
    expect(contextLimitFor('claude-opus-5[1m]', 10_000)).toBe(LARGE_CONTEXT_LIMIT);
  });

  it('4: モデル・トークンが未取得でも既定値を返す', () => {
    expect(contextLimitFor(undefined, undefined)).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});

describe('shortModelName', () => {
  it('5: claude- 接頭辞を落としてファミリー名とバージョンに分ける', () => {
    expect(shortModelName('claude-opus-5')).toBe('Opus 5');
    expect(shortModelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(shortModelName('claude-fable-5')).toBe('Fable 5');
  });

  it('6: 区切りの - は . に寄せる（4-5 は 4.5 であって 4 と 5 ではない）', () => {
    expect(shortModelName('claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('7: 末尾の日付サフィックスは落とす', () => {
    expect(shortModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('8: 想定外の形は加工せず返す（見慣れない文字列で異変に気付けるように）', () => {
    expect(shortModelName('<synthetic>')).toBe('<synthetic>');
  });

  it('9: 未取得・空文字は undefined', () => {
    expect(shortModelName(undefined)).toBeUndefined();
    expect(shortModelName('')).toBeUndefined();
  });
});

describe('formatTokens', () => {
  it('10: 1000 未満はそのまま', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('11: 10k 未満は小数第 1 位を残す', () => {
    expect(formatTokens(8_400)).toBe('8.4k');
  });

  it('12: 10k 以上は k 単位で丸める', () => {
    expect(formatTokens(55_002)).toBe('55k');
    expect(formatTokens(199_500)).toBe('200k');
  });

  it('13: 100 万以上は M 単位', () => {
    expect(formatTokens(1_240_000)).toBe('1.2M');
  });
});

describe('formatPercent / severityOf', () => {
  it('14: 小数は落とす', () => {
    expect(formatPercent(13)).toBe('13%');
    expect(formatPercent(22.4)).toBe('22%');
  });

  it('15: 75% 未満は normal', () => {
    expect(severityOf(0)).toBe('normal');
    expect(severityOf(74.9)).toBe('normal');
  });

  it('16: 75% 以上で warn、90% 以上で critical', () => {
    expect(severityOf(75)).toBe('warn');
    expect(severityOf(89)).toBe('warn');
    expect(severityOf(90)).toBe('critical');
    expect(severityOf(100)).toBe('critical');
  });
});

describe('formatResetAt', () => {
  const now = new Date(2026, 6, 31, 12, 0, 0); // 2026-07-31 12:00 ローカル

  it('17: 同じ日なら時刻だけ', () => {
    const reset = new Date(2026, 6, 31, 16, 5, 0).toISOString();

    expect(formatResetAt(reset, now)).toBe('16:05');
  });

  it('18: 日をまたぐなら日付を添える', () => {
    const reset = new Date(2026, 7, 6, 9, 0, 0).toISOString();

    expect(formatResetAt(reset, now)).toBe('8/6 09:00');
  });

  it('19: 未取得・パースできない値は undefined（表示から落とす）', () => {
    expect(formatResetAt(undefined, now)).toBeUndefined();
    expect(formatResetAt('not a date', now)).toBeUndefined();
  });
});

describe('shouldFetchUsage', () => {
  it('20: 初回は無条件に引く（起動直後の空表示を避ける）', () => {
    expect(shouldFetchUsage(false, false, 0)).toBe(true);
  });

  it('21: 裏に回っているあいだは引かない', () => {
    expect(shouldFetchUsage(false, true, 10 * 60_000)).toBe(false);
  });

  it('22: 前面でも最小間隔を空ける（ウィンドウを行き来するだけで叩かない）', () => {
    expect(shouldFetchUsage(true, true, 30_000, 60_000)).toBe(false);
    expect(shouldFetchUsage(true, true, 60_000, 60_000)).toBe(true);
  });
});

describe('hasAnythingToShow', () => {
  it('23: 何も取れていなければ false（空の帯を残さない）', () => {
    expect(hasAnythingToShow(null, null)).toBe(false);
  });

  it('24: 全フィールドが欠けた meta だけでは false（形式変更で空になった場合）', () => {
    expect(hasAnythingToShow({}, null)).toBe(false);
  });

  it('25: モデルだけ・利用量だけでも true', () => {
    expect(hasAnythingToShow({ model: 'claude-opus-5' }, null)).toBe(true);
    expect(hasAnythingToShow(null, { fiveHourPercent: 13 })).toBe(true);
    expect(hasAnythingToShow(null, { sevenDayPercent: 22 })).toBe(true);
  });

  it('26: 利用率が空の usage は表示対象にしない', () => {
    expect(hasAnythingToShow(null, { fiveHourResetsAt: '2026-08-06T00:00:00Z' })).toBe(false);
  });
});

describe('shouldPollTranscript', () => {
  it('27: 初回は必ず読む（起動直後の空白を避ける）', () => {
    expect(shouldPollTranscript(0)).toBe(true);
  });

  it('28: everyN 回に 1 回だけ読む', () => {
    expect(shouldPollTranscript(1, 3)).toBe(false);
    expect(shouldPollTranscript(2, 3)).toBe(false);
    expect(shouldPollTranscript(3, 3)).toBe(true);
  });

  it('29: everyN が 1 以下なら常に読む', () => {
    expect(shouldPollTranscript(7, 1)).toBe(true);
    expect(shouldPollTranscript(7, 0)).toBe(true);
  });
});
