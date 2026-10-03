#!/usr/bin/env node
/*
 * Installs the development tools - ESLint (npm run lint) and playwright-core
 * (npm run smoke) - into node_modules/ without touching package.json. The app
 * and the unit tests need neither.
 *
 * Supply-chain cooldown: npm may only pick versions published at least
 * COOLDOWN_DAYS days ago (28 by default and at least 28), for the tools and
 * for their whole dependency tree (npm install --before=<date>). A hijacked
 * release is usually spotted and pulled within days - long before it could
 * reach this project. The installed tree is then checked against the
 * registry's publish dates, and the install fails if anything is younger.
 *
 * node_modules/ is wiped first, so no newer package from an earlier install
 * can linger in the tree.
 *
 * Usage: node scripts/install-tools.mjs        (or: npm run tools)
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const TOOLS = ['eslint@10', 'playwright-core@1'];
const MIN_DAYS = 28;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const days = Math.max(MIN_DAYS, Number(process.env.COOLDOWN_DAYS) || MIN_DAYS);
const cutoff = new Date(Date.now() - days * 86400e3);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log(`Installing ${TOOLS.join(', ')}: only versions published before ${cutoff.toISOString()} (${days}-day cooldown).`);
fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
execFileSync(npm, ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', `--before=${cutoff.toISOString()}`, ...TOOLS], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// every installed package (also nested ones), from npm's own record of the tree
const lock = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '.package-lock.json'), 'utf8'));
const installed = new Map();
for (const [where, meta] of Object.entries(lock.packages || {})) {
  if (!where || meta.link || !meta.version) continue;
  const name = meta.name || where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);
  installed.set(`${name}@${meta.version}`, { name, version: meta.version });
}

// check the publish date of each, a few registry queries at a time
const run = promisify(execFile);
const items = [...installed.values()];
const tooNew = [];
const unknown = [];
let next = 0;
async function worker() {
  while (next < items.length) {
    const { name, version } = items[next++];
    try {
      const { stdout } = await run(npm, ['view', `${name}@${version}`, 'time', '--json'], { cwd: root, shell: process.platform === 'win32', maxBuffer: 64 << 20 });
      const published = JSON.parse(stdout)[version];
      if (!published) unknown.push(`${name}@${version}`);
      else if (new Date(published) > cutoff) tooNew.push(`${name}@${version} (published ${published})`);
    } catch {
      unknown.push(`${name}@${version}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const top = TOOLS.map((t) => t.slice(0, t.lastIndexOf('@'))).map((n) => `${n}@${items.find((i) => i.name === n)?.version}`);
if (tooNew.length || unknown.length) {
  if (tooNew.length) console.error(`Younger than the ${days}-day cooldown:\n  ${tooNew.join('\n  ')}`);
  if (unknown.length) console.error(`Publish date not verifiable:\n  ${unknown.join('\n  ')}`);
  process.exit(1);
}
console.log(`Installed ${top.join(', ')}; all ${items.length} packages in the tree were published before ${cutoff.toISOString().slice(0, 10)}.`);
