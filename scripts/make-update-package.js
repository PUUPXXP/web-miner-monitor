#!/usr/bin/env node
// 生成升级包：把挖矿程序目录打成 tar.gz，并输出上传所需信息
//
// 用法：
//   node scripts/make-update-package.js --id xmrig --version 6.26.0 --platform win32 --dir C:\miners\xmrig-6.26
//   node scripts/make-update-package.js --id peakminer --version 2.0.4 --platform linux --file peakminer-2.0.4
//
// 输出目录：updates/<kind>/<id>/<version>/（可直接被服务器扫描到，也可通过控制台上传）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const kind = String(arg('kind', 'miner'));
const id = arg('id');
const version = arg('version');
const platform = String(arg('platform', process.platform === 'win32' ? 'win32' : 'linux'));
const entry = arg('entry', null);
const notes = String(arg('notes', '') || '');
const dir = arg('dir', null);
const file = arg('file', null);

if (!id || !version) {
  console.error(`用法: node scripts/make-update-package.js --id <名称> --version <版本> (--dir <目录> | --file <文件>) [--platform win32|linux] [--entry exe名] [--notes 说明]

示例:
  node scripts/make-update-package.js --id xmrig --version 6.26.0 --platform win32 --dir C:\\miners\\xmrig-6.26
`);
  process.exit(1);
}
if (!dir && !file) { console.error('需要 --dir（目录）或 --file（已有 tar.gz）'); process.exit(1); }

const outDir = path.join(ROOT, 'updates', kind, id, String(version).replace(/[^\w.+-]/g, '_'));
fs.mkdirSync(outDir, { recursive: true });
const archiveName = `${id}-${version}-${platform}.tar.gz`;
const target = path.join(outDir, archiveName);

if (file) {
  if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(1); }
  fs.copyFileSync(file, target);
} else {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) { console.error(`目录不存在: ${abs}`); process.exit(1); }
  // 用目录名作为包内根目录，解包后保持结构
  execFileSync('tar', ['-czf', target, '-C', path.dirname(abs), path.basename(abs)], { stdio: 'inherit' });
}

const buf = fs.readFileSync(target);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const manifest = {
  version: String(version),
  platform,
  notes,
  sha256: sha,
  archive: archiveName,
  ...(entry ? { entry: String(entry) } : {}),
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('');
console.log('升级包已生成：');
console.log(`  类型    : ${kind}`);
console.log(`  名称    : ${id}`);
console.log(`  版本    : ${version}`);
console.log(`  平台    : ${platform}`);
console.log(`  文件    : ${target}`);
console.log(`  大小    : ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  sha256  : ${sha}`);
console.log('');
console.log('下一步：');
console.log('  A. 直接放进服务器目录（已在 updates/ 下，服务器会自动扫描到）');
console.log('  B. 或在控制台「在线升级中心 → 上传升级包」选择该文件');
console.log('');
