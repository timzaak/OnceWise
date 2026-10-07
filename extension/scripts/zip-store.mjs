// Store-upload packaging: the Chrome Web Store rejects manifests carrying a `key`
// field (2026-10-02, docs/store-listing/README.md 步骤 4), so the pinned dev key from
// wxt.config.ts must be stripped before upload. Packages .output/chrome-mv3 into
// .output/oncewise-ai-<version>-chrome-store.zip with manifest.json at the zip root.
// Run `npm run build` first — this script does not build.

import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
delete manifest.key;
const strippedManifest = JSON.stringify(manifest);

const zip = new AdmZip();
function walk(dir, rel) {
  // Deterministic entry order keeps the zip reproducible across platforms.
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, relPath);
    } else if (relPath === 'manifest.json') {
      zip.addFile(relPath, Buffer.from(strippedManifest, 'utf8'));
    } else {
      zip.addFile(relPath, fs.readFileSync(abs));
    }
  }
}
walk(buildDir, '');

const outPath = path.join(extRoot, '.output', `oncewise-ai-${version}-chrome-store.zip`);
zip.writeZip(outPath);
console.log(`Store package written: ${path.relative(extRoot, outPath)} (key stripped, version ${version})`);
