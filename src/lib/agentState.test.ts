import { describe, it, expect } from 'vitest';
import {
  readBottomSnapshot,
  isBlockedSnapshot,
  classifyAgentState,
  type SnapshotSource,
} from './agentState';

/**
 * SnapshotSource のスタブを組み立てる。
 * `lines` は scrollback を含むバッファ全体（index = 絶対行番号）とみなす。
 */
function makeTerm(lines: (string | undefined)[], rows: number, baseY: number): SnapshotSource {
  return {
    rows,
    buffer: {
      active: {
        baseY,
        getLine: (y: number) => {
          const text = lines[y];
          if (text === undefined) return undefined;
          return { translateToString: () => text };
        },
      },
    },
  };
}

/** Claude Code の権限確認 UI を模した画面（罫線・選択カーソル付き）。 */
const APPROVAL_SCREEN = [
  '╭──────────────────────────────────────────────────╮',
  '│ Edit file                                        │',
  '│                                                  │',
  '│ src/main.ts                                      │',
  '│                                                  │',
  '│ Do you want to make this edit to main.ts?        │',
  '│ ❯ 1. Yes                                         │',
  '│   2. Yes, and don\'t ask again this session       │',
  '│   3. No, and tell Claude what to do differently  │',
  '╰──────────────────────────────────────────────────╯',
].join('\n');

describe('readBottomSnapshot', () => {
  it('1: baseY + rows までの「いま画面に見えている」範囲だけを読む', () => {
    // 全 10 行のうち、baseY=6 / rows=4 なので絶対行 6..9 が可視範囲
    const lines = ['s0', 's1', 's2', 's3', 's4', 's5', 'v0', 'v1', 'v2', 'v3'];
    const term = makeTerm(lines, 4, 6);
    expect(readBottomSnapshot(term, 24)).toBe('v0\nv1\nv2\nv3');
  });

  it('2: lines 指定が可視範囲より小さいとき、下から lines 行だけを読む', () => {
    const lines = ['v0', 'v1', 'v2', 'v3'];
    const term = makeTerm(lines, 4, 0);
    expect(readBottomSnapshot(term, 2)).toBe('v2\nv3');
  });

  it('3: 要求行数がバッファ先頭を超えても start が 0 にクランプされる', () => {
    const lines = ['v0', 'v1'];
    const term = makeTerm(lines, 2, 0);
    expect(readBottomSnapshot(term, 24)).toBe('v0\nv1');
  });

  it('4: getLine が undefined を返す行はスキップされる', () => {
    const lines = ['v0', undefined, 'v2'];
    const term = makeTerm(lines, 3, 0);
    expect(readBottomSnapshot(term, 24)).toBe('v0\nv2');
  });
});

describe('isBlockedSnapshot', () => {
  it('5: 質問文と番号付き選択肢が揃った承認 UI → true', () => {
    expect(isBlockedSnapshot(APPROVAL_SCREEN)).toBe(true);
  });

  it('6: 質問文だけで選択肢がない → false（地の文の可能性があるため）', () => {
    const snapshot = 'I can refactor this module for you.\nDo you want to proceed with that?';
    expect(isBlockedSnapshot(snapshot)).toBe(false);
  });

  it('7: 番号付きリストだけで質問文がない → false（手順の箇条書きと区別できないため）', () => {
    const snapshot = 'Here is the plan:\n  1. Read the file\n  2. Apply the patch\n  3. Run tests';
    expect(isBlockedSnapshot(snapshot)).toBe(false);
  });

  it('8: フォルダ信頼の確認 UI → true', () => {
    const snapshot = [
      '│ Do you trust the files in this folder?  │',
      '│ ❯ 1. Yes, proceed                       │',
      '│   2. No, exit                           │',
    ].join('\n');
    expect(isBlockedSnapshot(snapshot)).toBe(true);
  });

  it('9: Plan モードの承認 UI (Would you like to proceed?) → true', () => {
    const snapshot = [
      '│ Would you like to proceed with this plan?      │',
      '│ ❯ 1. Yes, and auto-accept edits               │',
      '│   2. Yes, and manually approve edits          │',
      '│   3. No, keep planning                        │',
    ].join('\n');
    expect(isBlockedSnapshot(snapshot)).toBe(true);
  });

  it('10: バージョン番号のような小数点は選択肢として誤マッチしない', () => {
    const snapshot = 'Do you want to know the version?\nInstalled v1.2.3 and v2.0.1 are available.';
    expect(isBlockedSnapshot(snapshot)).toBe(false);
  });

  it('11: 空文字列 → false', () => {
    expect(isBlockedSnapshot('')).toBe(false);
  });
});

describe('classifyAgentState', () => {
  it('12: 承認 UI が出ていれば blocked', () => {
    expect(classifyAgentState(APPROVAL_SCREEN, false)).toBe('blocked');
  });

  it('13: BEL を受信していても承認 UI が優先される（Claude は承認時にも BEL を鳴らすため）', () => {
    expect(classifyAgentState(APPROVAL_SCREEN, true)).toBe('blocked');
  });

  it('14: 実行中マーカーがあれば working', () => {
    const snapshot = '✳ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)';
    expect(classifyAgentState(snapshot, false)).toBe('working');
  });

  it('15: 実行中マーカーは BEL より優先される（前回の完了通知が残っていても実行中を出す）', () => {
    const snapshot = '✳ Wrangling… (3s · esc to interrupt)';
    expect(classifyAgentState(snapshot, true)).toBe('working');
  });

  it('16: 実行中でも応答待ちでもなく BEL を受信していれば done', () => {
    expect(classifyAgentState('> ', true)).toBe('done');
  });

  it('17: どの条件にも当てはまらなければ idle', () => {
    expect(classifyAgentState('> ', false)).toBe('idle');
  });

  it('18: 空のスナップショット + BEL なし → idle', () => {
    expect(classifyAgentState('', false)).toBe('idle');
  });
});
