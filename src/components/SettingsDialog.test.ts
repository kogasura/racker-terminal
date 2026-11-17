import { describe, it, expect } from 'vitest';
import { buildSettingsPatch } from './SettingsDialog';
import type { Settings } from '../types';

const base: Settings = {
  theme: 'tokyo-night',
  fontFamily: 'monospace',
  fontSize: 14,
  scrollback: 1000,
  transparency: 1.0,
};

describe('buildSettingsPatch', () => {
  it('何も変えていなければ空の patch を返す', () => {
    expect(buildSettingsPatch({ ...base }, base)).toEqual({});
  });

  it('テーマを変えたら patch に theme を入れる', () => {
    expect(buildSettingsPatch({ ...base, theme: 'dracula' }, base)).toEqual({ theme: 'dracula' });
  });

  it('自作テーマ (user:<stem>) の ID もそのまま入れる', () => {
    expect(buildSettingsPatch({ ...base, theme: 'user:sunset' }, base)).toEqual({
      theme: 'user:sunset',
    });
  });

  it('カタログに無い ID のままでも、変えていなければ patch に入れない (値を保持する)', () => {
    const settings = { ...base, theme: 'user:deleted' };
    expect(buildSettingsPatch({ ...settings }, settings)).toEqual({});
  });

  it('テーマと他の項目を同時に変えたら、両方入れる', () => {
    expect(buildSettingsPatch({ ...base, theme: 'nord', fontSize: 16 }, base)).toEqual({
      theme: 'nord',
      fontSize: 16,
    });
  });

  describe('背景を動かす (backdropMotion)', () => {
    it('オフにしたら patch に false を入れる', () => {
      expect(buildSettingsPatch({ ...base, backdropMotion: false }, base)).toEqual({
        backdropMotion: false,
      });
    });

    it('オフからオンに戻したら patch に true を入れる', () => {
      const settings = { ...base, backdropMotion: false };
      expect(buildSettingsPatch({ ...settings, backdropMotion: true }, settings)).toEqual({
        backdropMotion: true,
      });
    });

    it('変えていなければ入れない', () => {
      const off = { ...base, backdropMotion: false };
      expect(buildSettingsPatch({ ...off }, off)).toEqual({});
      const on = { ...base, backdropMotion: true };
      expect(buildSettingsPatch({ ...on }, on)).toEqual({});
    });

    it('未設定 (undefined) はオンとして比べる (true にしても変化なし)', () => {
      expect(buildSettingsPatch({ ...base, backdropMotion: true }, base)).toEqual({});
      expect(buildSettingsPatch({ ...base }, { ...base, backdropMotion: true })).toEqual({});
    });
  });
});
