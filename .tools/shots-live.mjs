// 截图线上部署
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.argv[2] || 'http://47.122.120.90:32001';
const PASS = process.argv[3] || '';
const CANDIDATES = [
  path.join(ROOT, '.tools', 'browsers', 'chrome-win', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EXE = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!EXE) { console.error('no browser'); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, '40-live-login.png') });
console.log('  截图: 40-live-login.png | 标题:', await page.title());

if (PASS) {
  await page.fill('input[type=password]', PASS);
  const userInput = await page.$('input[type=text]');
  if (userInput) await userInput.fill('admin');
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, '41-live-dashboard.png') });
  console.log('  截图: 41-live-dashboard.png | URL:', page.url());
  const txt = await page.textContent('body');
  console.log('  登录后含"总览":', txt.includes('总览'), '| 含"矿机在线":', txt.includes('矿机在线'));
}

await browser.close();
if (errs.length) console.log('  页面错误:', errs.slice(0, 3));
