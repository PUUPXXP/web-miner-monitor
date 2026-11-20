#!/usr/bin/env node
// 测试用"假矿工"：模拟 XMRig 的 HTTP API（/2/summary），按时间产生稳定算力与份额。
// 用法: node fake-xmrig.js --http-port 3333 --http-host 127.0.0.1 --rig-id test ...
import http from 'node:http';

const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const port = Number(getArg('--http-port', 3333));
const host = getArg('--http-host', '127.0.0.1');
const t0 = Date.now();
const base = Number(process.env.FAKE_HASHRATE || 1800); // H/s per GPU

function nowSec() { return Math.floor((Date.now() - t0) / 1000); }

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/2/summary')) {
    const up = nowSec();
    const wave = 1 + 0.02 * Math.sin(up / 7);
    const gpuHashes = [base * wave, base * 0.97 * wave];
    const total = gpuHashes.reduce((a, b) => a + b, 0);
    const accepted = Math.floor(up / 12) + 3;
    const rejected = up > 600 ? 1 : 0;
    const body = {
      hashrate: {
        total: [Math.round(total), Math.round(total * 0.995), Math.round(total * 0.99)],
        highest: Math.round(total * 1.02),
        gpus: gpuHashes.map((h) => Math.round(h)),
      },
      hugepages: { pages: 0, total: 0 },
      results: { diff_current: 120000, shares_good: accepted, shares_total: accepted + rejected, avg_time: 12, hashes_total: accepted * 120000, best: [120000] },
      connection: { pool: 'pool.supportxmr.com:3333', ip: '1.2.3.4', uptime: up, ping: 35, tls: false },
      algo: 'rx/0',
      uptime: up,
      version: '6.22.0-fake',
    };
    const s = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
    return;
  }
  res.writeHead(404).end('{}');
});

server.listen(port, host, () => {
  console.log(`[fake-xmrig] listening on ${host}:${port} (pid ${process.pid})`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
