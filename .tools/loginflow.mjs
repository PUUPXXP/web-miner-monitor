import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const CAND = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const EXE = CAND.find(p => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport:{width:1400,height:900} })).newPage();
await page.goto('http://47.122.120.90:32001', { waitUntil:'networkidle' });
// 完全模拟用户：清空账号框、输入密码、点登录
await page.fill('input[type=text]', 'admin');
await page.fill('input[type=password]', 'Miner2026Xmr');
await page.click('button[type=submit]');
await page.waitForTimeout(3500);
const body = await page.textContent('body');
console.log('登录后标题:', await page.title());
console.log('进入控制台:', body.includes('总览') && body.includes('矿机'));
console.log('错误提示:', (await page.$('.login-error.show')) ? await page.textContent('.login-error') : '(无)');
await page.screenshot({ path: path.join(ROOT,'screenshots','42-live-relogin.png') });
console.log('截图已存: screenshots/42-live-relogin.png');
await browser.close();
