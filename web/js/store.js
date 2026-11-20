// 极简全局状态：订阅-通知 + 矿机索引
class Store {
  constructor() {
    this.state = {
      user: null,
      overview: null,
      rigs: [],
      rigMap: new Map(),
      groups: [],
      alerts: [],
      realtime: false,
      price: {},
      net: {},
      loading: true,
    };
    this.listeners = new Set();
  }

  get() { return this.state; }

  set(patch) {
    Object.assign(this.state, patch);
    if (patch.rigs) {
      this.state.rigMap = new Map(patch.rigs.map((r) => [r.id, r]));
      this.state.groups = [...new Set(patch.rigs.map((r) => r.group_name).filter(Boolean))];
    }
    this.notify();
  }

  setRigs(rigs) { this.set({ rigs }); }

  upsertRig(rig) {
    if (!rig?.id) return;
    const map = new Map(this.state.rigMap);
    map.set(rig.id, rig);
    const rigs = [...map.values()];
    this.set({ rigMap: map, rigs });
  }

  removeRig(id) {
    const map = new Map(this.state.rigMap);
    map.delete(id);
    this.set({ rigMap: map, rigs: [...map.values()] });
  }

  addAlert(alert) {
    this.set({ alerts: [alert, ...this.state.alerts].slice(0, 100) });
  }

  resolveAlert(id) {
    this.set({ alerts: this.state.alerts.map((a) => (a.id === id ? { ...a, state: 'resolved', resolved_at: Date.now() } : a)) });
  }

  fleetStats() {
    const rigs = this.state.rigs;
    const online = rigs.filter((r) => r.online);
    const hashrate = online.reduce((s, r) => s + (Number(r.total_hashrate) || 0), 0);
    const power = online.reduce((s, r) => s + (Number(r.power_w) || 0), 0);
    const temps = online.map((r) => Number(r.temp_max)).filter((n) => Number.isFinite(n));
    return {
      total: rigs.length,
      online: online.length,
      offline: rigs.length - online.length,
      hashrate,
      power,
      tempMax: temps.length ? Math.max(...temps) : null,
      byCoin: ['XMR', 'PRL'].map((coin) => {
        const list = rigs.filter((r) => r.coin === coin);
        const on = list.filter((r) => r.online);
        return {
          coin,
          rigs: list.length,
          online: on.length,
          hashrate: on.reduce((s, r) => s + (Number(r.total_hashrate) || 0), 0),
          power: on.reduce((s, r) => s + (Number(r.power_w) || 0), 0),
        };
      }),
    };
  }

  onlineAlerts() {
    return this.state.alerts.filter((a) => a.state === 'firing');
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (e) { console.warn('store listener error', e); }
    }
  }
}

export const store = new Store();
