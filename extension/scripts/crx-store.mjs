// Store-upload CRX signing: the item opted in to Chrome Web Store "Verified CRX
// Uploads" (2026-10-13, docs/store-listing/README.md 步骤 5), so every package
// update must be a CRX signed with the registered RSA key — plain zips are rejected.
// Packs .output/chrome-mv3 into .output/oncewise-ai-<version>-chrome-store.crx via
// `chrome --pack-extension`. Packing uses a stripped-manifest copy at
// .output/chrome-mv3-store because the console rejects manifests carrying a `key`
// field (2026-10-02, same rule as zip-store.mjs). Run `npm run build` first — this
// script does not build.
//
// Required env CRX_KEY_PATH: PEM private key matching the console-registered public
// key (local: ~/.oncewise/cws-signing/privatekey.pem; CI: CWS_SIGNING_KEY secret
// written to a temp file). Chrome binary: env CHROME_PATH, else PATH, else standard
// install locations.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findChrome() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  const locations =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  const onDisk = locations.find((candidate) => fs.existsSync(candidate));
  if (onDisk) {
    return onDisk;
  }
  // GitHub runners expose Chrome only through PATH (google-chrome).
  return process.platform === 'win32' ? undefined : 'google-chrome';
}

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(extRoot, '.output', 'chrome-mv3');
const manifestPath = path.join(buildDir, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error(`Build output missing: ${manifestPath}. Run \`npm run build\` first.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
if (!version) {
  console.error('manifest.json has no version — refusing to name the package.');
  process.exit(1);
}
if (!('key' in manifest)) {
  console.warn('Warning: build manifest has no `key` — wxt.config.ts may have changed.');
}

if (!process.env.CRX_KEY_PATH) {
  console.error('Missing required env CRX_KEY_PATH (PEM private key for verified CRX uploads).');
  process.exit(1);
}
const keyPath = path.resolve(process.env.CRX_KEY_PATH);
if (!fs.existsSync(keyPath)) {
  console.error(`CRX_KEY_PATH does not exist: ${keyPath}`);
  process.exit(1);
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome executable not found — set CHROME_PATH or install Chrome.');
  process.exit(1);
}

const storeDir = path.join(extRoot, '.output', 'chrome-mv3-store');
fs.rmSync(storeDir, { recursive: true, force: true });
fs.cpSync(buildDir, storeDir, { recursive: true });
delete manifest.key;
fs.writeFileSync(path.join(storeDir, 'manifest.json'), JSON.stringify(manifest));

// A dedicated user-data-dir keeps the pack in its own Chrome instance instead of
// delegating to an already-running browser process (which drops the pack flags).
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-pack-'));
execFileSync(
  chromePath,
  [
    `--pack-extension=${storeDir}`,
    `--pack-extension-key=${keyPath}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
  { stdio: 'inherit' },
);
fs.rmSync(profileDir, { recursive: true, force: true });

// Chrome writes <storeDir>.crx next to the packed directory.
const packedCrx = `${storeDir}.crx`;
if (!fs.existsSync(packedCrx)) {
  console.error(`Chrome did not produce ${packedCrx}`);
  process.exit(1);
}
const outPath = path.join(extRoot, '.output', `oncewise-ai-${version}-chrome-store.crx`);
fs.rmSync(outPath, { force: true });
fs.renameSync(packedCrx, outPath);
console.log(`Signed store package written: ${path.relative(extRoot, outPath)} (key stripped, version ${version})`);
