// Windows 11 の新コンテキストメニュー用 sparse package をビルドする。
//
//   npm run build:context-menu
//
// 生成物はすべて src-tauri/appx/ に置かれ、tauri.conf.json の bundle.resources
// 経由でインストーラに同梱される（インストール先は $INSTDIR\appx\）。
//
//   racker_explorer_command.dll  IExplorerCommand を実装した shell extension
//   RackerTerminal.msix          それを Windows に登録するための sparse package
//   Square150x150Logo.png        マニフェストが要求するロゴ
//   Square44x44Logo.png          同上
//
// テンプレート src-tauri/appx/AppxManifest.xml の {{VERSION}} / {{PUBLISHER}} を
// 置換してからパッケージ化する。Publisher は署名に使う証明書のサブジェクトと
// 完全一致していないと、インストール時の登録が必ず失敗する。
//
// 署名について:
//   sparse package は署名が無いと通常の環境では登録できない（開発者モードの
//   `Add-AppxPackage -Register` を除く）。以下の環境変数が両方揃っているときだけ
//   signtool で署名する。未設定なら未署名のまま出力し、警告を出す。
//
//     RACKER_APPX_PFX           コード署名証明書 (.pfx) のパス
//     RACKER_APPX_PFX_PASSWORD  その .pfx のパスワード
//     RACKER_APPX_PUBLISHER     証明書のサブジェクト（既定: CN=yokubo）
//
// なお Windows 10 には新コンテキストメニュー自体が無い。インストーラ側で
// バージョン判定して登録をスキップするため、生成物が載っていても害はない。

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = path.join(root, 'src-tauri');
const appxDir = path.join(srcTauri, 'appx');
const template = path.join(appxDir, 'AppxManifest.xml');
const stageDir = path.join(srcTauri, 'target', 'appx-stage');
const msixOut = path.join(appxDir, 'RackerTerminal.msix');

function fail(msg) {
  console.error(`[context-menu] ✗ ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`${path.basename(cmd)} を起動できませんでした: ${r.error.message}`);
  if (r.status !== 0) fail(`${path.basename(cmd)} が失敗しました (exit ${r.status})`);
}

// ── Windows SDK のツールを探す（新しいバージョンを優先） ──────────────────────
function findSdkTool(name) {
  const bases = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  const found = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const candidate = path.join(base, entry, 'x64', name);
      // バージョン付きディレクトリ (10.0.26100.0) だけを見る
      if (/^10\.\d+\.\d+\.\d+$/.test(entry) && existsSync(candidate)) {
        found.push({ version: entry, candidate });
      }
    }
  }
  if (found.length === 0) return null;
  // 文字列比較ではなく数値で比較する（10.0.9 と 10.0.26100 の順序を誤らないため）
  found.sort((a, b) => {
    const pa = a.version.split('.').map(Number);
    const pb = b.version.split('.').map(Number);
    for (let i = 0; i < 4; i += 1) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
  });
  return found[0].candidate;
}

// ── バージョン ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
// MSIX のバージョンは 4 桁固定。リビジョンは使わないので 0 を足す。
const appxVersion = `${pkg.version}.0`;
if (!/^\d+\.\d+\.\d+\.0$/.test(appxVersion)) {
  fail(`package.json の version (${pkg.version}) を MSIX のバージョンに変換できません。`);
}

const publisher = process.env.RACKER_APPX_PUBLISHER || 'CN=yokubo';

console.log(`[context-menu] ${appxVersion} / Publisher=${publisher} でビルドします。`);

// ── 1. shell extension の DLL をビルド ────────────────────────────────────────
run('cargo', ['build', '--release', '-p', 'racker-explorer-command'], { cwd: srcTauri });

const dll = path.join(srcTauri, 'target', 'release', 'racker_explorer_command.dll');
if (!existsSync(dll)) fail(`DLL が生成されていません: ${dll}`);

// ── 2. マニフェストを生成して sparse package をパックする ─────────────────────
if (!existsSync(template)) fail(`テンプレートが見つかりません: ${template}`);
const manifest = readFileSync(template, 'utf-8')
  .replaceAll('{{VERSION}}', appxVersion)
  .replaceAll('{{PUBLISHER}}', publisher);

// sparse package の中身はマニフェスト 1 枚だけ。実体は ExternalLocation 側にある。
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
writeFileSync(path.join(stageDir, 'AppxManifest.xml'), manifest, 'utf-8');

const makeappx = findSdkTool('makeappx.exe');
if (!makeappx) fail('makeappx.exe が見つかりません。Windows SDK をインストールしてください。');

mkdirSync(appxDir, { recursive: true });
rmSync(msixOut, { force: true });
// /nv: パッケージ内に実体が無い (sparse) ため検証を外す。/o: 既存を上書き。
run(makeappx, ['pack', '/d', stageDir, '/p', msixOut, '/nv', '/o']);

// ── 3. 署名（証明書が用意されているときだけ） ─────────────────────────────────
const pfx = process.env.RACKER_APPX_PFX;
const pfxPassword = process.env.RACKER_APPX_PFX_PASSWORD;
if (pfx && pfxPassword) {
  if (!existsSync(pfx)) fail(`証明書が見つかりません: ${pfx}`);
  const signtool = findSdkTool('signtool.exe');
  if (!signtool) fail('signtool.exe が見つかりません。Windows SDK をインストールしてください。');
  // パスワードは引数配列で渡す（shell を経由しないのでコマンドラインに展開されない）。
  run(signtool, ['sign', '/fd', 'SHA256', '/f', pfx, '/p', pfxPassword, msixOut]);
  console.log('[context-menu] 署名しました。');
} else {
  console.warn(
    '[context-menu] ⚠ RACKER_APPX_PFX / RACKER_APPX_PFX_PASSWORD が未設定のため未署名です。\n' +
      '               未署名の sparse package は、開発者モードの Add-AppxPackage -Register でしか\n' +
      '               登録できません。配布用ビルドでは必ず署名してください。',
  );
}

// ── 4. インストーラに載せる実体を appx/ に集める ──────────────────────────────
for (const [from, to] of [
  [dll, 'racker_explorer_command.dll'],
  [path.join(srcTauri, 'icons', 'Square150x150Logo.png'), 'Square150x150Logo.png'],
  [path.join(srcTauri, 'icons', 'Square44x44Logo.png'), 'Square44x44Logo.png'],
]) {
  if (!existsSync(from)) fail(`同梱するファイルが見つかりません: ${from}`);
  copyFileSync(from, path.join(appxDir, to));
}

console.log(`[context-menu] ✓ ${path.relative(root, msixOut)} を生成しました。`);
