// 1 コマンドリリース: 署名ビルド → 自動更新 manifest 生成 → GitHub Release 作成 を一括実行する。
//
//   npm run release
//
// 署名パスフレーズ等の機密は、リポジトリ直下の `.env.release`（.gitignore 済み）に置く。
// このスクリプトは `.env.release` を読み込んでビルドプロセスの環境変数へ流すだけで、
// 値を標準出力にもファイルにも書き出さない。既に環境変数が設定済みならそちらを優先する。
//
// 事前準備:
//   1. `.env.release.example` を `.env.release` にコピーし、鍵パスとパスフレーズを記入。
//   2. `gh auth login` 済みであること。
//   3. リリースノート `CHANGELOG-<version>.md` を用意しておくこと。
//
// バージョンは package.json の version を自動採用する（先に bump しておくこと）。

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));

const VERSION = pkg.version;
const PRODUCT = 'Racker Terminal';
const REPO = 'kogasura/racker-terminal';
const TAG = `v${VERSION}`;

// ── .env.release を読み込む（簡易 KEY=VALUE。値はログ出力しない） ───────────────
const envFile = path.join(root, '.env.release');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val; // 既存環境変数を優先
  }
  console.log('[release] .env.release を読み込みました。');
} else {
  console.log('[release] .env.release が無いため、既存の環境変数を使用します。');
}

function fail(msg) {
  console.error(`[release] ✗ ${msg}`);
  process.exit(1);
}

// ── 事前チェック ───────────────────────────────────────────────────────────────
for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
  if (!process.env[name]) {
    fail(`環境変数 ${name} が未設定です。.env.release に記入するか環境変数で渡してください。`);
  }
}

const notesFile = `./CHANGELOG-${VERSION}.md`;
if (!existsSync(path.join(root, notesFile))) {
  fail(`リリースノート ${notesFile} が見つかりません。先に作成してください。`);
}

const installer = `src-tauri/target/release/bundle/nsis/${PRODUCT}_${VERSION}_x64-setup.exe`;
const sig = `${installer}.sig`;

// ── コマンド実行ヘルパ（スペースを含むパスは "" で括る。値はそのまま継承環境で実行） ──
function run(cmdline) {
  console.log(`\n[release] $ ${cmdline}`);
  const r = spawnSync(cmdline, { stdio: 'inherit', shell: true, cwd: root });
  if (r.status !== 0) fail(`コマンド失敗 (exit ${r.status}): ${cmdline}`);
}

console.log(`[release] ${PRODUCT} ${TAG} をリリースします。`);

// 1. 署名付きビルド（TAURI_SIGNING_* を継承して .sig を生成）
run('npm run tauri build');

for (const f of [installer, sig]) {
  if (!existsSync(path.join(root, f))) {
    fail(`生成物が見つかりません: ${f}（署名鍵/パスフレーズや createUpdaterArtifacts 設定を確認）`);
  }
}

// 2. 自動更新 manifest 生成
run(
  `node scripts/generate-update-manifest.mjs ` +
    `--version ${VERSION} ` +
    `--notes-file "${notesFile}" ` +
    `--installer-path "${installer}" ` +
    `--signature-path "${sig}" ` +
    `--download-url-prefix https://github.com/${REPO}/releases/download/${TAG} ` +
    `--output ./latest.json`,
);

// 3. GitHub Release 作成（タグ ${TAG} もここで作成される）
run(
  `gh release create ${TAG} ` +
    `"${installer}" "${sig}" ./latest.json ` +
    `--title ${TAG} --notes-file "${notesFile}"`,
);

console.log(`\n[release] ✅ ${TAG} を公開しました: https://github.com/${REPO}/releases/tag/${TAG}`);
