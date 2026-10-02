#!/usr/bin/env node
// Reverses install.mjs: removes the Chrome registration (HKCU registry value
// or the manifest file), then removes the install directory this project created. Uninstalling the
// native host does not affect any other extension feature — flows, execution and sync live entirely
// in the extension.
//
// Usage: node uninstall.mjs [--browser chrome|chromium] [--manifest-dir <dir>] [--registry-root <key>]
//                          [--install-dir <dir>] [--keep-files]
import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { HOST_NAME, assertNode22, chromeHostRegistration, installDir } from './protocol.mjs';

function parseArgs(argv) {
  const options = { browser: 'chrome' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--keep-files') {
      options.keepFiles = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    i += 1;
    if (flag === '--browser') options.browser = value;
    else if (flag === '--manifest-dir') options.manifestDir = value;
    else if (flag === '--registry-root') options.registryRoot = value;
    else if (flag === '--install-dir') options.installDir = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!['chrome', 'chromium'].includes(options.browser)) {
    throw new Error(`--browser must be chrome or chromium (found "${options.browser}")`);
  }
  return options;
}

// Only delete a directory this installer plausibly created (it must contain host.mjs AND
// protocol.mjs AND a oncewise launcher) — never rm anything else, even under --install-dir.
function safeRemoveInstallDir(dir) {
  if (!existsSync(dir)) return false;
  const expected = ['host.mjs', 'protocol.mjs'];
  const launcher = process.platform === 'win32' ? 'oncewise-native-host.cmd' : 'oncewise-native-host';
  const looksOurs =
    expected.every((f) => statSync(path.join(dir, f)).isFile()) && statSync(path.join(dir, launcher)).isFile();
  if (!looksOurs) throw new Error(`${dir} does not look like a OnceWise native-host install; refusing to delete it`);
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function main() {
  assertNode22();
  const options = parseArgs(process.argv.slice(2));
  const dir = options.installDir ?? installDir();
  const registration = chromeHostRegistration(options.browser, {
    ...(options.manifestDir !== undefined ? { manifestDir: options.manifestDir } : {}),
    ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
  });

  let registrationRemoved = false;
  if (registration.kind === 'registry') {
    const result = spawnSync('reg', ['delete', registration.key, '/f'], { encoding: 'utf8' });
    registrationRemoved = result.status === 0;
  } else if (existsSync(registration.manifestPath)) {
    // Only unlink a manifest that actually names our host
    const written = JSON.parse(readFileSync(registration.manifestPath, 'utf8'));
    if (written.name === HOST_NAME) {
      unlinkSync(registration.manifestPath);
      registrationRemoved = true;
    }
  }

  const filesRemoved = options.keepFiles === true ? false : safeRemoveInstallDir(dir);

  process.stdout.write(
    `${JSON.stringify({ uninstalled: true, registrationRemoved, registration, filesRemoved, installDir: dir }, null, 2)}\n`,
  );
  process.stderr.write('[oncewise-uninstall] done. Restart Chrome so the change takes effect.\n');
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ uninstalled: false, error: error.message })}\n`);
  process.exit(1);
}
