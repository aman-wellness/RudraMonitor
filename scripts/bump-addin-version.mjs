#!/usr/bin/env node
// Stamp public/outlook-addin/manifest.xml with a monotonically-increasing
// version tied to the current git commit count, so every dashboard build
// carries a fresh manifest version.
//
// Why: Microsoft 365 admin center's "Update" flow rejects a re-upload if
// the manifest <Version> is unchanged ("Failed. Please update the version
// number in the manifest file and try again."). We were shipping 1.0.0.0
// forever, so every attempted update landed on that error. Wiring version
// stamping into the build means a customer's admin can always re-upload
// after we push new add-in code and Microsoft will accept it.
//
// Version scheme: `1.0.<year offset from 2026>.<commit count>` — four
// dot-separated components (Microsoft's manifest schema requires exactly
// four) that only ever go UP. commit count is monotone; the year offset
// prefix keeps us safely below the max part value even if we do a lot of
// commits.
//
// Run manually with `node scripts/bump-addin-version.mjs` or automatically
// as part of `npm run build` (the pre-hook in package.json's scripts).

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..');
const MANIFEST = path.join(REPO, 'public', 'outlook-addin', 'manifest.xml');

function commitCount() {
  try {
    return Number(execSync('git rev-list --count HEAD', { cwd: REPO }).toString().trim());
  } catch {
    return 0;
  }
}

function nextVersion() {
  const yearOffset = new Date().getUTCFullYear() - 2026; // 0 for 2026, 1 for 2027, …
  const c = commitCount();
  // Manifest schema requires each component <= 65535. commit count of
  // 65535 is well past our real-world need; if we ever hit it we'll bump
  // the second-to-last part manually.
  return `1.0.${yearOffset}.${c}`;
}

const before = readFileSync(MANIFEST, 'utf8');
const version = nextVersion();
if (!/<Version>[^<]+<\/Version>/.test(before)) {
  console.error('bump-addin-version: no <Version> tag found in manifest.xml');
  process.exit(1);
}
const after = before.replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`);
if (before !== after) writeFileSync(MANIFEST, after);
console.log(`bump-addin-version: manifest.xml -> ${version}${before === after ? ' (unchanged)' : ''}`);
