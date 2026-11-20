// 截图线上「系统镜像」页（含自动构建卡片）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.argv[2] || 'http://47.122.120.90:32001';
const PASS = process.argv[3] || '';
const CAND = [
  path.join(ROOT, '.tools', 'browsers', 'chrome-win', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EXE = CAND.find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1150 } })).newPage();

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type=password]', PASS);
await page.click('button[type=submit]');
await page.waitForTimeout(3000);
await page.goto(BASE + '/#/os', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(OUT, '43-live-os-build.png') });
const txt = await page.textContent('body');
console.log('含「镜像自动构建」:', txt.includes('镜像自动构建'));
console.log('含「立即构建」:', txt.includes('立即构建'));
console.log('含「构建中」:', txt.includes('构建中'));
console.log('截图: screenshots/43-live-os-build.png');
await browser.close();
