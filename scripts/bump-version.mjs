// 版番号を、版を持つ全ファイルでまとめて書き換える。
//
//   npm run bump -- patch      # 1.9.13 → 1.9.14
//   npm run bump -- minor      # 1.9.13 → 1.10.0
//   npm run bump -- 2.0.0      # 指定した版にする
//
// 書き換える場所（どれか 1 つでも見つからなければ何も書かずに失敗する）:
//   package.json / package-lock.json (ルートと packages[""])
//   src-tauri/tauri.conf.json
//   src-tauri/Cargo.toml / src-tauri/explorer-command/Cargo.toml
//   src-tauri/Cargo.lock (racker-terminal / racker-explorer-command の 2 エントリ)
//
// リリースノート docs/changelog/<版>.md は内容を人 (か Claude) が書くため、ここでは作らない。
// 新しい版を標準出力の最後の行に出すので、呼び出し側はそれを拾える。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`[bump] ✗ ${msg}`);
  process.exit(1);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')).version;
const m = SEMVER.exec(current);
if (!m) fail(`package.json の version が x.y.z 形式ではありません: ${current}`);
const [major, minor, patch] = m.slice(1).map(Number);

const arg = process.argv[2];
let next;
if (arg === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
else if (arg === 'major') next = `${major + 1}.0.0`;
else if (arg && SEMVER.test(arg)) next = arg;
else fail('使い方: npm run bump -- <patch|minor|major|x.y.z>');

if (next === current) fail(`すでに ${current} です。`);

// [ファイル, 置換前の文字列, 置換後の文字列, 期待する置換回数]
const q = JSON.stringify;
const edits = [
  ['package.json', `"version": ${q(current)}`, `"version": ${q(next)}`, 1],
  // ルートの version と packages[""] の version の 2 か所。依存パッケージの version は
  // 同じ文字列になりえないよう、インデント込みで当てる。
  ['package-lock.json', `\n  "version": ${q(current)}`, `\n  "version": ${q(next)}`, 1],
  ['package-lock.json', `\n      "version": ${q(current)}`, `\n      "version": ${q(next)}`, 1],
  ['src-tauri/tauri.conf.json', `"version": ${q(current)}`, `"version": ${q(next)}`, 1],
  ['src-tauri/Cargo.toml', `\nversion = ${q(current)}`, `\nversion = ${q(next)}`, 1],
  ['src-tauri/explorer-command/Cargo.toml', `\nversion = ${q(current)}`, `\nversion = ${q(next)}`, 1],
  [
    'src-tauri/Cargo.lock',
    `name = "racker-explorer-command"\nversion = ${q(current)}`,
    `name = "racker-explorer-command"\nversion = ${q(next)}`,
    1,
  ],
  [
    'src-tauri/Cargo.lock',
    `name = "racker-terminal"\nversion = ${q(current)}`,
    `name = "racker-terminal"\nversion = ${q(next)}`,
    1,
  ],
];

// 先に全部の置換を検証してから書く（途中で失敗して版がばらばらになるのを防ぐ）
const contents = new Map();
for (const [file, from, to, expected] of edits) {
  const full = path.join(root, file);
  if (!contents.has(full)) contents.set(full, readFileSync(full, 'utf-8'));
  // 改行コードが CRLF でも当たるよう、検索側の \n を実ファイルの改行に合わせる
  const text = contents.get(full);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fromEol = from.replaceAll('\n', eol);
  const count = text.split(fromEol).length - 1;
  if (count !== expected) {
    fail(`${file}: "${from.trim()}" が ${expected} 件の想定のところ ${count} 件でした。`);
  }
  contents.set(full, text.replace(fromEol, to.replaceAll('\n', eol)));
}
for (const [full, text] of contents) writeFileSync(full, text);

console.log(`[bump] ${current} → ${next}（${contents.size} ファイル）`);
console.log(next);
