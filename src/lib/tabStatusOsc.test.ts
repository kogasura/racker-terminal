import { describe, it, expect } from 'vitest';
import {
  parseTabStatusOsc,
  agentStateFromTabStatus,
  isTabStatusCleared,
} from './tabStatusOsc';

describe('parseTabStatusOsc', () => {
  it('1: key=value;key=value 形式をパースする', () => {
    const p = parseTabStatusOsc('indicator=#ff9500;status=Working…;status-color=#ff9500');
    expect(p).toEqual({
      indicator: '#ff9500',
      status: 'Working…',
      statusColor: '#ff9500',
    });
  });

  it('2: エスケープされた ; は区切りではなく値の一部として扱う', () => {
    const p = parseTabStatusOsc('status=a\\;b');
    expect(p.status).toBe('a;b');
  });

  it('3: エスケープされた \\ を元に戻す', () => {
    const p = parseTabStatusOsc('status=a\\\\b');
    expect(p.status).toBe('a\\b');
  });

  it('4: 未知のキーは無視する（将来キーが増えても壊れない）', () => {
    const p = parseTabStatusOsc('indicator=#ff9500;brand-new-key=xyz');
    expect(p.indicator).toBe('#ff9500');
    expect(Object.keys(p)).toEqual(['indicator']);
  });

  it('5: = を含まない断片は無視する', () => {
    expect(parseTabStatusOsc('garbage;status=Idle').status).toBe('Idle');
  });

  it('6: 空の値も保持する（解除の合図として使うため）', () => {
    const p = parseTabStatusOsc('indicator=;status=');
    expect(p.indicator).toBe('');
    expect(p.status).toBe('');
  });

  it('7: 空文字列は空のオブジェクト', () => {
    expect(parseTabStatusOsc('')).toEqual({});
  });
});

describe('agentStateFromTabStatus', () => {
  it('8: インジケータ色から状態を判定する', () => {
    expect(agentStateFromTabStatus({ indicator: '#5f87ff' })).toBe('blocked');
    expect(agentStateFromTabStatus({ indicator: '#ff9500' })).toBe('working');
    expect(agentStateFromTabStatus({ indicator: '#00d75f' })).toBe('idle');
  });

  it('9: 色は大文字でも判定できる', () => {
    expect(agentStateFromTabStatus({ indicator: '#FF9500' })).toBe('working');
  });

  it('10: 色が優先される（ラベルは表示用で将来変わりうるため）', () => {
    const p = { indicator: '#5f87ff', status: 'Working…' };
    expect(agentStateFromTabStatus(p)).toBe('blocked');
  });

  it('11: 色が未知ならラベルで補う', () => {
    expect(agentStateFromTabStatus({ indicator: '#123456', status: 'Waiting' })).toBe('blocked');
    expect(agentStateFromTabStatus({ status: 'Working…' })).toBe('working');
    expect(agentStateFromTabStatus({ status: 'Idle' })).toBe('idle');
  });

  it('12: どちらからも決められなければ undefined（状態を勝手に消さない）', () => {
    expect(agentStateFromTabStatus({})).toBeUndefined();
    expect(agentStateFromTabStatus({ indicator: '#123456' })).toBeUndefined();
    expect(agentStateFromTabStatus({ status: '' })).toBeUndefined();
  });

  it('13: done は OSC からは決まらない（Claude 側に対応する状態がない）', () => {
    const states = ['#00d75f', '#ff9500', '#5f87ff'].map((c) =>
      agentStateFromTabStatus({ indicator: c }),
    );
    expect(states).not.toContain('done');
  });
});

describe('isTabStatusCleared', () => {
  it('14: 空の値が来たら解除とみなす（終了時に working が残らないように）', () => {
    expect(isTabStatusCleared(parseTabStatusOsc('indicator=;status='))).toBe(true);
  });

  it('15: 値が入っていれば解除ではない', () => {
    expect(isTabStatusCleared(parseTabStatusOsc('indicator=#ff9500;status=Working…'))).toBe(false);
  });

  it('16: そもそもキーが来ていないときは解除ではない', () => {
    expect(isTabStatusCleared({})).toBe(false);
    expect(isTabStatusCleared(parseTabStatusOsc('status-color=#ff9500'))).toBe(false);
  });
});
