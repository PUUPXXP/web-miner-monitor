// 进程内事件总线 + WebSocket 广播
import { attachWs } from '../shared/ws.js';

export class EventBus {
  constructor() {
    this.ws = null;
    this.clients = new Set();
    this.listeners = new Map();
    this._pending = new Map(); // 合并高频广播
    this._flushTimer = null;
  }

  attach(httpServer, { path = '/ws', verify } = {}) {
    this.ws = attachWs(httpServer, {
      path,
      verify,
      onConnection: (conn) => {
        this.clients.add(conn);
        conn.on('close', () => this.clients.delete(conn));
        conn.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg?.type === 'ping') conn.send({ type: 'pong', t: Date.now() });
          if (msg?.type === 'subscribe') conn.data.subs = new Set(msg.rooms || []);
        });
        conn.send({ type: 'hello', t: Date.now(), server: 'web-miner-monitor' });
      },
    });
    return this.ws;
  }

  /**
   * 广播事件。高频事件（rig.update）按 rigId 合并，每 500ms 刷一次，避免刷屏。
   */
  broadcast(msg, { throttle = false } = {}) {
    const payload = JSON.stringify(msg);
    if (throttle && msg.type === 'rig.update' && msg.rig?.id) {
      this._pending.set(msg.rig.id, payload);
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => this._flush(), 500);
        this._flushTimer.unref?.();
      }
      return;
    }
    this._send(payload);
  }

  _flush() {
    this._flushTimer = null;
    const items = [...this._pending.values()];
    this._pending.clear();
    for (const p of items) this._send(p);
  }

  _send(payload) {
    for (const c of this.clients) {
      if (c.open) c.send(payload);
    }
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, data) {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(data); } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  close() { this.ws?.close(); }
}
