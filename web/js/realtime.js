// 全局状态 + WebSocket 实时推送 + Toast
import { api } from './api.js';
import { h } from './dom.js';
import { store } from './store.js';

// ───────── Toast ─────────
export function toast(message, type = 'ok', ms = 3800) {
  const root = document.getElementById('toast-root');
  const icons = { ok: '✓', err: '✕', warn: '!', info: 'i' };
  const el = h('div', { class: `toast ${type}` },
    h('span', { class: 't-ico', style: { color: type === 'err' ? 'var(--danger)' : type === 'warn' ? 'var(--warn)' : type === 'ok' ? 'var(--ok)' : 'var(--info)' } }, icons[type] || 'i'),
    h('div', { style: { flex: '1' } }, message),
  );
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ───────── 实时连接 ─────────
class Realtime {
  constructor() {
    this.ws = null;
    this.retry = 0;
    this.timer = null;
    this.pollTimer = null;
    this.connected = false;
    this.listeners = new Map();
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(data); } catch (e) { console.warn('realtime listener error', e); }
    }
  }

  start() {
    this.stop();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      store.set({ realtime: true });
      this.emit('open');
      this.ws.send(JSON.stringify({ type: 'subscribe', rooms: ['all'] }));
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.handle(msg);
    };
    this.ws.onclose = () => {
      this.connected = false;
      store.set({ realtime: false });
      this.emit('close');
      this.scheduleReconnect();
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch { /* ignore */ } };
  }

  handle(msg) {
    switch (msg.type) {
      case 'hello':
        this.emit('hello', msg);
        break;
      case 'rig.update':
        store.upsertRig(msg.rig);
        this.emit('rig', msg.rig);
        break;
      case 'rig.removed':
        store.removeRig(msg.rigId);
        this.emit('rig.removed', msg.rigId);
        break;
      case 'alert':
        store.addAlert(msg.alert);
        this.emit('alert', msg.alert);
        break;
      case 'alert.resolved':
        store.resolveAlert(msg.alertId);
        this.emit('alert.resolved', msg.alertId);
        break;
      case 'command.result':
        this.emit('command', msg.command);
        break;
      case 'event':
        this.emit('event', msg.event);
        break;
      case 'network':
        store.set({ price: msg.price, net: msg.net });
        this.emit('network', msg);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    this.retry += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.retry, 5), 20_000);
    this.timer = setTimeout(() => this.start(), delay);
  }

  stop() {
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /** 浏览器不支持 WS 或断线时：轮询兜底 */
  startFallbackPolling(ms = 10_000) {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (this.connected) return;
      try {
        const { rigs } = await api.rigs();
        store.setRigs(rigs);
      } catch { /* ignore */ }
    }, ms);
  }
}

export const realtime = new Realtime();
