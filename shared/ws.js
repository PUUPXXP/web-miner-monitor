// 零依赖 WebSocket 服务端（RFC 6455）：只支持文本/二进制消息、ping/pong、close。
// 用途：浏览器控制台实时推送 + 采集端与服务器的长连接。
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 8 * 1024 * 1024; // 8MB 上限

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.remote = (req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    this.open = true;
    this.closed = false;
    this.isAlive = true;
    this.data = {}; // 业务侧挂载数据（如 agent 会话）
    this._buf = Buffer.alloc(0);
    this._frag = [];
    this._fragOp = null;
    this._fragLen = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._destroy(err));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
  }

  send(obj) {
    if (!this.open) return false;
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    try {
      this.socket.write(encodeFrame(OP.TEXT, payload));
      return true;
    } catch {
      this._destroy();
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    this._closeCode = code;
    const buf = Buffer.alloc(2 + Buffer.byteLength(reason));
    buf.writeUInt16BE(code, 0);
    buf.write(reason, 2);
    try { this.socket.write(encodeFrame(OP.CLOSE, buf)); } catch { /* ignore */ }
    this.open = false;
    // 给对方一点时间收到 close 帧
    setTimeout(() => this._destroy(), 250).unref?.();
  }

  _destroy(err) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.emit('close', err);
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    if (this.closed) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._buf.length >= 2) {
        const b0 = this._buf[0];
        const b1 = this._buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (this._buf.length < 4) return;
          len = this._buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (this._buf.length < 10) return;
          const big = this._buf.readBigUInt64BE(2);
          if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'too large');
          len = Number(big);
          offset = 10;
        }
        if (!masked) return this.close(1002, 'client frames must be masked');
        if (this._buf.length < offset + 4 + len) return;
        const mask = this._buf.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(this._buf.subarray(offset, offset + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        this._buf = this._buf.subarray(offset + len);
        this._handleFrame(opcode, fin, payload);
        if (this.closed) return;
      }
    } catch (e) {
      this._destroy(e);
    }
  }

  _handleFrame(opcode, fin, payload) {
    if (opcode === OP.PING) {
      try { this.socket.write(encodeFrame(OP.PONG, payload)); } catch { /* ignore */ }
      this.emit('ping');
      return;
    }
    if (opcode === OP.PONG) { this.isAlive = true; return; }
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.emit('close-frame', code);
      this.close(1000);
      return;
    }
    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      this._fragOp = opcode;
      this._frag = [payload];
      this._fragLen = payload.length;
      if (fin) this._flushFragments();
      return;
    }
    if (opcode === OP.CONT) {
      if (!this._fragOp) return this.close(1002, 'unexpected continuation');
      this._frag.push(payload);
      this._fragLen += payload.length;
      if (this._fragLen > MAX_MESSAGE) return this.close(1009, 'too large');
      if (fin) this._flushFragments();
      return;
    }
    this.close(1002, 'bad opcode');
  }

  _flushFragments() {
    const buf = Buffer.concat(this._frag);
    const isText = this._fragOp === OP.TEXT;
    this._frag = [];
    this._fragOp = null;
    this._fragLen = 0;
    if (isText) {
      this.emit('message', buf.toString('utf8'));
    } else {
      this.emit('binary', buf);
    }
  }
}

/**
 * 在 http.Server 上挂载 WebSocket 端点。
 * @param {import('node:http').Server} server
 * @param {{ path?: string, onConnection?: (conn: WsConnection, req) => void, verify?: (req) => boolean|Promise<boolean>, heartbeatMs?: number }} opts
 * @returns {{ close(): void, clients: Set<WsConnection> }}
 */
export function attachWs(server, opts = {}) {
  const path = opts.path || '/ws';
  const clients = new Set();
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  const onUpgrade = async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      // 同一个 HTTP 服务器上可能挂了多个 WebSocket 端点（浏览器 /ws + 采集端 /agent/ws），
      // 路径不匹配时必须直接返回、交给其它监听器处理；这里销毁 socket 会把别人的连接打死。
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (req.method !== 'GET' || !key || version !== '13' ||
        String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (opts.verify) {
      let ok = false;
      try { ok = await opts.verify(req); } catch { ok = false; }
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setTimeout(0);
    socket.setKeepAlive(true, 30_000);
    const conn = new WsConnection(socket, req);
    if (head && head.length) socket.unshift(head);
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));
    try {
      opts.onConnection?.(conn, req);
    } catch (e) {
      conn.close(1011, 'handler error');
    }
  };

  server.on('upgrade', (req, socket, head) => {
    onUpgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
  });

  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.isAlive) { c._destroy(new Error('heartbeat timeout')); clients.delete(c); continue; }
      c.isAlive = false;
      c.send({ type: 'ping', t: Date.now() });
    }
  }, heartbeatMs);
  timer.unref?.();

  return {
    clients,
    close() {
      clearInterval(timer);
      for (const c of clients) c.close(1001, 'server shutdown');
      clients.clear();
    },
  };
}
