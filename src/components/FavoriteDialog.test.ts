import { describe, it, expect } from 'vitest';
import { parseEnvText, parseArgsText } from './FavoriteDialog';

describe('parseArgsText', () => {
  it('1 行 1 件: 単一行を配列にする', () => {
    expect(parseArgsText('--cd')).toEqual(['--cd']);
  });

  it('複数行: 複数の引数を配列にする', () => {
    expect(parseArgsText('--cd\n~')).toEqual(['--cd', '~']);
  });

  it('空行スキップ: 空行は無視される', () => {
    expect(parseArgsText('--cd\n\n~\n')).toEqual(['--cd', '~']);
  });

  it('各行 trim: 前後のスペースを除去する', () => {
    expect(parseArgsText('  --login  \n  -i  ')).toEqual(['--login', '-i']);
  });

  it('全部空: 空文字列は空配列を返す', () => {
    expect(parseArgsText('')).toEqual([]);
  });

  it('改行のみ: 改行だけの入力は空配列を返す', () => {
    expect(parseArgsText('\n\n\n')).toEqual([]);
  });
});

describe('parseEnvText', () => {
  it('正常: KEY=VALUE を正しくパースする', () => {
    const { env, errors } = parseEnvText('FOO=bar');
    expect(errors).toHaveLength(0);
    expect(env).toEqual({ FOO: 'bar' });
  });

  it('正常: 複数行をパースする', () => {
    const { env, errors } = parseEnvText('FOO=bar\nBAZ=qux');
    expect(errors).toHaveLength(0);
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('正常: アンダースコアで始まる KEY を受け付ける', () => {
    const { env, errors } = parseEnvText('_MY_VAR=value');
    expect(errors).toHaveLength(0);
    expect(env).toEqual({ _MY_VAR: 'value' });
  });

  it('正常: 空行をスキップする', () => {
    const { env, errors } = parseEnvText('FOO=bar\n\nBAZ=qux\n');
    expect(errors).toHaveLength(0);
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('正常: VALUE に = を含む場合、最初の = で分割する', () => {
    const { env, errors } = parseEnvText('URL=http://example.com?a=1&b=2');
    expect(errors).toHaveLength(0);
    expect(env).toEqual({ URL: 'http://example.com?a=1&b=2' });
  });

  it('正常: 空テキストは空 env を返す', () => {
    const { env, errors } = parseEnvText('');
    expect(errors).toHaveLength(0);
    expect(env).toEqual({});
  });

  // F-S3: 不正 KEY のエラーテスト

  it('F-S3: = が見つからない行はエラー', () => {
    const { errors } = parseEnvText('INVALID_LINE');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/L1/);
    expect(errors[0]).toMatch(/'=' が見つかりません/);
  });

  it('F-S3: 数字始まりの KEY はエラー', () => {
    const { errors } = parseEnvText('1FOO=bar');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/L1/);
    expect(errors[0]).toMatch(/KEY が無効/);
  });

  it('F-S3: ハイフンを含む KEY はエラー', () => {
    const { errors } = parseEnvText('MY-VAR=value');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/KEY が無効/);
    expect(errors[0]).toMatch(/MY-VAR/);
  });

  it('F-S3: スペースを含む KEY はエラー', () => {
    const { errors } = parseEnvText('MY VAR=value');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/KEY が無効/);
  });

  it('F-S3: 複数行に不正な行が混在するとき、全エラーを返す', () => {
    const text = 'VALID=ok\n1INVALID=bad\nALSO-INVALID=ng\nANOTHER=fine';
    const { env, errors } = parseEnvText(text);
    // VALID と ANOTHER は通過する
    expect(env).toEqual({ VALID: 'ok', ANOTHER: 'fine' });
    // 2 件のエラー (L2, L3)
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/L2/);
    expect(errors[1]).toMatch(/L3/);
  });

  it('F-S3: 空 KEY (= が先頭) はエラー', () => {
    const { errors } = parseEnvText('=value');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/'=' が見つかりません/);
  });
});
