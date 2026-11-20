// Playwright 截图脚本：真实浏览器渲染 + 截图
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASS = process.argv[3] || 'admin12345';
const OUT = path.join(ROOT, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const CANDIDATES = [
  path.join(ROOT, '.tools', 'browsers', 'chrome-win', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EXE = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!EXE) { console.error('no chromium browser found'); process.exit(1); }

const errors = [];
const consoleErrors = [];

async function main() {
  const browser = await chromium.launch({
    executablePath: EXE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name), fullPage: false });
    console.log('  📸', name);
  };

  console.log('→ 登录页');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type=password]');
  await shot('01-login.png');

  console.log('→ 登录');
  await page.fill('input[type=password]', PASS);
  await page.click('button[type=submit]');
  await page.waitForSelector('.rig-card', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot('02-dashboard.png');
  const cards = await page.locator('.rig-card').count();
  console.log('  矿机卡片:', cards);

  console.log('→ 矿机详情');
  await page.locator('.rig-card').first().click();
  await page.waitForTimeout(2200);
  await shot('03-rig-detail.png');

  console.log('→ 历史曲线');
  await page.locator('.tab', { hasText: '历史' }).click();
  await page.waitForTimeout(2200);
  await shot('04-rig-history.png');

  console.log('→ 飞行表');
  await page.goto(BASE + '/#/flight-sheets', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('05-flight-sheets.png');

  console.log('→ 飞行表编辑器');
  await page.locator('button', { hasText: '新建飞行表' }).click();
  await page.waitForTimeout(900);
  await shot('06-flight-sheet-editor.png');

  console.log('→ 告警');
  await page.goto(BASE + '/#/alerts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('07-alerts.png');

  console.log('→ 事件');
  await page.goto(BASE + '/#/events', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('08-events.png');

  console.log('→ 设置');
  await page.goto(BASE + '/#/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('09-settings.png');

  console.log('→ 矿机列表');
  await page.goto(BASE + '/#/rigs', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('10-rig-list.png');

  console.log('→ 移动端');
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  await shot('11-mobile.png');

  await browser.close();
  const serious = [...errors, ...consoleErrors.filter((e) => !/favicon|net::|ERR_/i.test(e))];
  if (serious.length) {
    console.log('\n⚠ 页面错误:');
    for (const e of serious.slice(0, 10)) console.log('  -', e);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 无 JS 错误');
  }
  console.log(`\n截图目录: ${OUT}`);
}

main().catch((e) => { console.error('❌ 截图失败:', e.message); process.exit(1); });
