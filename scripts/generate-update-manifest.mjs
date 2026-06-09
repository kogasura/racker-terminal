#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    'notes-file': { type: 'string' },
    'installer-path': { type: 'string' },
    'signature-path': { type: 'string' },
    'download-url-prefix': { type: 'string' },
    output: { type: 'string', default: './latest.json' },
    'pub-date': { type: 'string' },
  },
});

// Validate required arguments
const required = ['version', 'notes-file', 'installer-path', 'signature-path', 'download-url-prefix'];
for (const name of required) {
  if (!values[name]) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
}

const version = values['version'];
const notesFile = values['notes-file'];
const installerPath = values['installer-path'];
const signaturePath = values['signature-path'];
const downloadUrlPrefix = values['download-url-prefix'].replace(/\/$/, '');
const output = values['output'];
const pubDate = values['pub-date'] ?? new Date().toISOString();

// Validate installer-path exists
try {
  statSync(installerPath);
} catch {
  console.error(`installer not found: ${installerPath}`);
  process.exit(1);
}

// Validate signature-path exists
try {
  statSync(signaturePath);
} catch {
  console.error(`signature not found: ${signaturePath}`);
  process.exit(1);
}

// Read files
const notes = readFileSync(notesFile, 'utf-8');
const signature = readFileSync(signaturePath, 'utf-8').trim();

// Build download URL.
// GitHub Releases はアップロード時にアセット名のスペースをドットへ置換して保存する
// (例: "Racker Terminal_1.5.0_x64-setup.exe" → "Racker.Terminal_1.5.0_x64-setup.exe")。
// URL 側をスペースのままにすると 404 になり、updater のダウンロードが全ユーザーで失敗する。
// そのためファイル名のスペースをドットに変換して URL を組み立てる。
const installerFileName = path.basename(installerPath).replace(/ /g, '.');
const url = `${downloadUrlPrefix}/${installerFileName}`;

// Build manifest
const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    'windows-x86_64': {
      signature,
      url,
    },
  },
};

// Write output
writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
console.log(`wrote ${output}`);
