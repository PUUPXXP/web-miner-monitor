// REST API 客户端
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
    throw new ApiError(res.status, json?.error || `请求失败 (${res.status})`);
  }
  return json;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p) => request('DELETE', p),

  // 认证
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  me: () => request('GET', '/api/auth/me'),
  changePassword: (oldPassword, newPassword) => request('POST', '/api/auth/password', { oldPassword, newPassword }),

  // 数据
  overview: () => request('GET', '/api/overview'),
  rigs: () => request('GET', '/api/rigs'),
  rig: (id) => request('GET', `/api/rigs/${id}`),
  createRig: (data) => request('POST', '/api/rigs', data),
  updateRig: (id, data) => request('PATCH', `/api/rigs/${id}`, data),
  deleteRig: (id) => request('DELETE', `/api/rigs/${id}`),
  rotateToken: (id) => request('POST', `/api/rigs/${id}/rotate-token`, {}),
  command: (id, type, payload) => request('POST', `/api/rigs/${id}/command`, { type, payload }),
  fleetCommand: (type, ids) => request('POST', '/api/fleet/command', { type, ids }),
  bulk: (ids, action, data) => request('POST', '/api/rigs/bulk', { ids, action, ...data }),
  installScript: (id) => request('GET', `/api/rigs/${id}/install`),
  commands: () => request('GET', '/api/commands'),

  // 历史
  fleetHistory: (hours = 24, coin = null) => request('GET', `/api/history/fleet?hours=${hours}${coin ? `&coin=${coin}` : ''}`),
  rigHistory: (id, hours = 6) => request('GET', `/api/history/rig/${id}?hours=${hours}`),

  // 配置
  flightSheets: () => request('GET', '/api/flight-sheets'),
  saveFlightSheet: (data) => request('POST', '/api/flight-sheets', data),
  deleteFlightSheet: (id) => request('DELETE', `/api/flight-sheets/${id}`),
  saveWallet: (data) => request('POST', '/api/wallets', data),
  deleteWallet: (id) => request('DELETE', `/api/wallets/${id}`),

  // 告警 / 事件
  alerts: () => request('GET', '/api/alerts'),
  saveRule: (data) => request('POST', '/api/alerts/rules', data),
  deleteRule: (id) => request('DELETE', `/api/alerts/rules/${id}`),
  ackAlert: (id) => request('POST', `/api/alerts/${id}/ack`, {}),
  testNotification: (channel) => request('POST', '/api/notifications/test', { channel }),
  events: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''));
    return request('GET', `/api/events?${q}`);
  },

  // 设置 / 系统
  settings: () => request('GET', '/api/settings'),
  saveSettings: (data) => request('PUT', '/api/settings', data),
  server: () => request('GET', '/api/server'),
  os: () => request('GET', '/api/os'),
  backup: () => request('GET', '/api/backup'),
  restore: (data) => request('POST', '/api/restore', data),

  // 币种
  coins: () => request('GET', '/api/coins'),
  addCoin: (data) => request('POST', '/api/coins', data),
  deleteCoin: (symbol) => request('DELETE', `/api/coins/${symbol}`),

  // 在线升级
  updates: () => request('GET', '/api/updates'),
  pushUpdate: (data) => request('POST', '/api/updates/push', data),
  deleteUpdate: (kind, id, version) => request('DELETE', `/api/updates/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(version)}`),
};
