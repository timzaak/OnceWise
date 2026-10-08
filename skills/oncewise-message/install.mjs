#!/usr/bin/env node
// User-level installer for the OnceWise Flow native messaging host. What it does:
//
//   1. copies host.mjs + protocol.mjs to a stable user-level directory (never run them from the
//      skill checkout — moving it would break the manifest path),
//   2. writes a platform launcher that invokes host.mjs with the ABSOLUTE path of the Node 22+ binary
//      running this installer,
//   3. writes the Chrome native-messaging host manifest (stdio, allowed_origins = exactly this
//      extension's origin) and registers it for the chosen browser flavor — HKCU registry on Windows
//      (no admin rights needed), the browser's NativeMessagingHosts directory on macOS/Linux,
//   4. verifies the written files and prints one JSON summary on stdout.
//
// Usage:
//   node install.mjs [--browser chrome|chromium] [--extension-id <id>] [--manifest-dir <dir>]
//                    [--registry-root <hkcu-key>] [--node <path>] [--install-dir <dir>]
//
// --extension-id defaults to the fixed production ID; pass an explicit one for development builds
// loaded with a different key. --manifest-dir/--registry-root cover other Chrome flavors.
// Uninstall: node uninstall.mjs (same browser flags).
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_ID,
  HOST_NAME,
  assertNode22,
  chromeHostRegistration,
  hostManifest,
  installDir,
} from './protocol.mjs';

function parseArgs(argv) {
  const options = { browser: 'chrome' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--browser') options.browser = value;
    else if (flag === '--extension-id') options.extensionId = value;
    else if (flag === '--manifest-dir') options.manifestDir = value;
    else if (flag === '--registry-root') options.registryRoot = value;
    else if (flag === '--node') options.nodePath = value;
    else if (flag === '--install-dir') options.installDir = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!['chrome', 'chromium'].includes(options.browser)) {
    throw new Error(`--browser must be chrome or chromium (found "${options.browser}")`);
  }
  return options;
}

function launcherPath(dir) {
  return path.join(dir, process.platform === 'win32' ? 'oncewise-native-host.cmd' : 'oncewise-native-host');
}

function writeLauncher(dir, nodePath) {
  const target = launcherPath(dir);
  if (process.platform === 'win32') {
    // Candidate launcher: a .cmd wrapper over the absolute Node path. Chromium still launches
    // non-exe hosts through cmd.exe, but this MUST pass a real-Chrome install->ping->save probe
    // before Windows support is claimed; on failure the fallback is a minimal reviewable .exe
    // launcher (tracked in skills/oncewise-setup/references/native-host-setup.md).
    writeFileSync(target, `@echo off\r\n"${nodePath}" "${path.join(dir, 'host.mjs')}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(target, `#!/bin/sh\nexec '${nodePath}' '${path.join(dir, 'host.mjs')}' "$@"\n`, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return target;
}

function register(registration) {
  if (registration.kind === 'registry') {
    // HKCU only — user-level install, no elevation. /ve writes the (Default) value = manifest path.
    const result = spawnSync('reg', ['add', registration.key, '/ve', '/t', 'REG_SZ', '/d', registration.manifestPath, '/f'], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`registry write failed: ${result.stderr || result.stdout}`);
    }
    const check = spawnSync('reg', ['query', registration.key, '/ve'], { encoding: 'utf8' });
    if (check.status !== 0 || !check.stdout.includes(registration.manifestPath)) {
      throw new Error('registry verification failed — the native host was not registered');
    }
    return { kind: 'registry', key: registration.key };
  }
  mkdirSync(path.dirname(registration.manifestPath), { recursive: true });
  return { kind: 'file', path: registration.manifestPath };
}

function main() {
  assertNode22();
  const options = parseArgs(process.argv.slice(2));
  const dir = options.installDir ?? installDir();
  const extensionId = options.extensionId ?? EXTENSION_ID;
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const nodePath = options.nodePath ?? process.execPath;

  mkdirSync(dir, { recursive: true });
  for (const file of ['host.mjs', 'protocol.mjs']) {
    const from = path.join(sourceDir, file);
    if (!existsSync(from)) throw new Error(`missing ${file} next to install.mjs (run from the skill's native-messaging directory)`);
    copyFileSync(from, path.join(dir, file));
  }
  const launcher = writeLauncher(dir, nodePath);

  const registration = chromeHostRegistration(options.browser, {
    ...(options.manifestDir !== undefined ? { manifestDir: options.manifestDir } : {}),
    ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
  });
  const manifest = hostManifest(launcher, extensionId);
  // The manifest's directory (browser NativeMessagingHosts / a --manifest-dir) may not exist on a
  // fresh machine — create it before the write; register()'s own mkdir is the registry no-op then.
  mkdirSync(path.dirname(registration.manifestPath), { recursive: true });
  writeFileSync(registration.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const registered = register(registration);

  // Post-write verification: the manifest exists, parses, and its allowed_origins binds EXACTLY the
  // requested extension origin (no wildcard, no drift).
  const written = JSON.parse(readFileSync(registration.manifestPath, 'utf8'));
  const expectedOrigin = `chrome-extension://${extensionId}/`;
  if (written.allowed_origins?.length !== 1 || written.allowed_origins[0] !== expectedOrigin) {
    throw new Error(`allowed_origins verification failed (expected exactly ${expectedOrigin})`);
  }
  if (!existsSync(launcher) || !statSync(launcher).isFile()) {
    throw new Error('launcher verification failed');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        installed: true,
        host: HOST_NAME,
        installDir: dir,
        launcher,
        nodePath,
        manifestPath: registration.manifestPath,
        registration: registered,
        extensionId,
        platform: process.platform,
      },
      null,
      2,
    )}\n`,
  );
  process.stderr.write(
    '[oncewise-install] installed. Start (or restart) this Chrome so the extension can connect, then verify: node client.mjs ping\n',
  );
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ installed: false, error: error.message })}\n`);
  process.exit(1);
}
