// 新功能截图：在线升级中心 / 币种管理 / 系统镜像（升级卡片）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASS = process.argv[3] || 'admin12345';
const OUT = path.join(ROOT, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const BUNDLED = path.join(ROOT, '.tools', 'browsers', 'chrome-win', 'chrome.exe');
const CANDIDATES = [
  BUNDLED,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EXE = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!EXE) {
  console.error('❌ 找不到可用的 Chromium 内核浏览器（Chrome / Edge）');
  process.exit(1);
}
console.log('浏览器:', EXE);

const errors = [];
const consoleErrors = [];

async function main() {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name), fullPage: false });
    console.log('  📷', name);
  };

  console.log('→ 登录');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type=password]');
  await page.fill('input[type=password]', PASS);
  await page.click('button[type=submit]');
  await page.waitForSelector('.rig-card', { timeout: 20000 });
  await page.waitForTimeout(1500);

  console.log('→ 在线升级中心');
  await page.goto(BASE + '/#/updates', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await shot('20-updates-packages.png');

  console.log('→ 矿机版本矩阵');
  await page.locator('.tab', { hasText: '矿机版本' }).click();
  await page.waitForTimeout(900);
  await shot('21-updates-rigs.png');

  console.log('→ 制作升级包说明');
  await page.locator('.tab', { hasText: '制作升级包' }).click();
  await page.waitForTimeout(900);
  await shot('22-updates-howto.png');

  console.log('→ 上传升级包弹窗');
  await page.locator('button', { hasText: '上传升级包' }).first().click();
  await page.waitForTimeout(900);
  await shot('23-updates-upload.png');
  await page.locator('.modal .btn', { hasText: '取消' }).first().click().catch(() => {});
  await page.waitForTimeout(400);

  console.log('→ 币种管理');
  await page.goto(BASE + '/#/coins', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot('24-coins.png');

  console.log('→ 新增币种弹窗');
  await page.locator('button', { hasText: '新增币种' }).first().click();
  await page.waitForTimeout(800);
  await shot('25-coins-add.png');
  await page.locator('.modal .btn', { hasText: '取消' }).first().click().catch(() => {});
  await page.waitForTimeout(400);

  console.log('→ 系统镜像（含在线升级卡片）');
  await page.goto(BASE + '/#/os', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await shot('26-os-upgrade.png');

  await browser.close();
  const serious = [...errors, ...consoleErrors.filter((e) => !/favicon|net::|ERR_/i.test(e))];
  if (serious.length) {
    console.log('\n⚠ 页面错误:');
    for (const e of serious.slice(0, 10)) console.log('  -', e);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 无 JS 错误');
  }
}

main().catch((e) => { console.error('❌ 截图失败:', e.message); process.exit(1); });
