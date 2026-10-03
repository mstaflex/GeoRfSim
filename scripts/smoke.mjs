#!/usr/bin/env node
/*
 * Smoke test of the built site in headless Chrome, the way GitHub Pages serves
 * it: from a sub-path (/GeoRfSim/) and without any special headers, so only
 * the page's own Content-Security-Policy applies. It checks that the app
 * starts, simulates, and survives a round of UI actions without page errors,
 * console errors or CSP violations, and saves a screenshot (smoke.png).
 *
 * Usage: node scripts/smoke.mjs [siteDir]   (default: _site)
 * Needs playwright-core (npm install --no-save playwright-core) and Chrome or
 * Chromium: CHROME_PATH, else the usual install locations, else Playwright's.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dir = path.resolve(process.argv[2] || '_site');
const BASE = '/GeoRfSim/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const candidates = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = candidates.find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({
  executablePath,
  // software WebGL on machines without a GPU (CI runners)
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
});
page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
});

const step = async (label, fn) => {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (e) {
    problems.push(`${label}: ${e.message.split('\n')[0]}`);
    console.log(`FAIL ${label}`);
  }
};
const until = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });

await step('loads from a sub-path and simulates', async () => {
  await page.goto(`${origin}${BASE}#s=urban`);
  await until(() => window.georfsim && window.georfsim.sim.t > 1);
  if (await page.isVisible('#fatal')) throw new Error(await page.textContent('#fatal'));
});
await step('help shows the build stamp', async () => {
  const text = await page.evaluate(() => document.querySelector('.help__build')?.textContent || '');
  if (!/build [0-9a-f]{7}|build dev/.test(text)) throw new Error(`stamp missing: "${text}"`);
  console.log(`     ${text}`);
});
await step('scenario, barometric height and settings', async () => {
  await page.focus('#gl');
  await page.keyboard.press('5');
  await until(() => window.georfsim.state.scenario === 'valley');
  await page.click('#alt-ref button[data-ref="baro"]');
  await until(() => window.georfsim.sim.cfg.altRef === 'baro' && /ar=baro/.test(location.hash));
  await page.click('#btn-model');
  await until(() => !document.getElementById('settings').hidden);
  await page.keyboard.press('Escape');
});
await step('flight-profile editor', async () => {
  await page.click('#btn-edit-flight');
  await until(() => !document.getElementById('flight-editor').hidden);
  await page.click('#fe-close');
});
await step('free flight', async () => {
  await page.focus('#gl');
  await page.keyboard.press('g');
  await until(() => !!window.georfsim.sim.free && !document.getElementById('osd').hidden);
  await page.keyboard.down('w');
  await page.waitForTimeout(800);
  await page.keyboard.up('w');
  await page.keyboard.press('g');
  await until(() => !window.georfsim.sim.free);
});
await step('keeps simulating', async () => {
  const t0 = await page.evaluate(() => window.georfsim.sim.t);
  await until((t) => window.georfsim.sim.t > t + 1, t0);
});
await page.screenshot({ path: 'smoke.png' });
await browser.close();
server.close();

if (problems.length) {
  console.error(`\nSmoke test failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nSmoke test passed (screenshot: smoke.png).');
