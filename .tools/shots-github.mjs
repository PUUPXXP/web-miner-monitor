// 截取 GitHub 仓库页，确认 README 与截图正常显示
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const URL = process.argv[2] || 'https://github.com/PUUPXXP/web-miner-monitor';

const CANDIDATES = [
  path.join(ROOT, '.tools', 'browsers', 'chrome-win', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EXE = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!EXE) { console.error('no chromium browser'); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: path.join(OUT, '30-github-repo.png') });
console.log('  截取:', '30-github-repo.png', '| 标题:', await page.title());

// 给 README 里的表格与截图留时间渲染
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(3500);
await page.screenshot({ path: path.join(OUT, '31-github-readme.png') });
console.log('  截取:', '31-github-readme.png');

const stats = await page.evaluate(() => {
  const files = document.querySelectorAll('[aria-labelledby="files"] tr.react-directory-row, table tbody tr').length;
  const imgs = [...document.images].filter((i) => i.src.includes('user-images') || i.src.includes('raw.githubusercontent')).length;
  const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src.startsWith('http')).length;
  return { files, imgs, broken };
});
console.log('  文件行数:', stats.files, '| README 图片:', stats.imgs, '| 加载失败图片:', stats.broken);

await browser.close();
if (errs.length) { console.log('  页面告警:', errs.slice(0, 3)); }
