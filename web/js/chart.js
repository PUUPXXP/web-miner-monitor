// 轻量 Canvas 折线图（零依赖，支持多 Y 轴、时间轴、悬停提示、渐变面积）
import { h } from './dom.js';

export class LineChart {
  /**
   * @param {HTMLElement} container
   * @param {{height?:number, series:Array<{key:string,label:string,color:string,unit?:string,yAxis?:number,fill?:boolean}>, points:Array<object>, xKey?:string, yAxes?:number}} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.opts = { height: 220, xKey: 'ts', yAxes: 1, padding: { l: 46, r: 14, t: 14, b: 26 }, ...opts };
    this.canvas = h('canvas', { class: 'chart' });
    this.wrap = h('div', { class: 'chart-wrap', style: { height: this.opts.height + 'px' } }, this.canvas);
    this.tip = h('div', {
      style: {
        position: 'absolute', pointerEvents: 'none', background: '#0a0c11', border: '1px solid var(--border-2)',
        borderRadius: '8px', padding: '6px 9px', fontSize: '11.5px', fontFamily: 'var(--mono)', display: 'none',
        zIndex: '5', whiteSpace: 'nowrap', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
      },
    });
    this.wrap.appendChild(this.tip);
    container.appendChild(this.wrap);
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.tip.style.display = 'none'; });
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.wrap);
    this.draw();
  }

  setData(points) {
    this.opts.points = points || [];
    this.draw();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.wrap.remove();
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.wrap.clientWidth || 600;
    const hgt = this.opts.height;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.canvas.style.height = hgt + 'px';
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const { padding } = this.opts;
    const plotW = w - padding.l - padding.r;
    const plotH = hgt - padding.t - padding.b;
    if (plotW <= 10 || plotH <= 10) return;
    const points = this.opts.points || [];
    const series = (this.opts.series || []).filter((s) => points.some((p) => Number.isFinite(Number(p[s.key]))));
    this.geom = { padding, plotW, plotH, w, hgt };
    if (!points.length || !series.length) {
      ctx.fillStyle = 'rgba(167,176,198,.45)';
      ctx.font = '12px Inter, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, hgt / 2);
      return;
    }
    const xs = points.map((p) => Number(p[this.opts.xKey])).filter(Number.isFinite);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xSpan = Math.max(1, xMax - xMin);
    const axes = [];
    for (let i = 0; i < this.opts.yAxes; i++) {
      const vals = [];
      for (const s of series.filter((s) => (s.yAxis || 0) === i)) {
        for (const p of points) {
          const v = Number(p[s.key]);
          if (Number.isFinite(v)) vals.push(v);
        }
      }
      const max = vals.length ? Math.max(...vals) : 1;
      axes.push({ max: max > 0 ? max * 1.15 : 1, vals });
    }
    const X = (t) => padding.l + ((t - xMin) / xSpan) * plotW;
    const Y = (v, axis = 0) => padding.t + plotH - (Math.max(0, v) / axes[axis].max) * plotH;

    // 网格 + Y 轴刻度
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(167,176,198,.6)';
    ctx.font = '10.5px Inter, system-ui';
    ctx.textAlign = 'right';
    const rows = 4;
    for (let i = 0; i <= rows; i++) {
      const y = padding.t + (plotH * i) / rows;
      ctx.beginPath();
      ctx.moveTo(padding.l, y);
      ctx.lineTo(w - padding.r, y);
      ctx.stroke();
      const v = axes[0].max * (1 - i / rows);
      ctx.fillText(fmtAxis(v), padding.l - 8, y + 3.5);
    }
    // 第二 Y 轴
    if (axes[1]) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(167,176,198,.6)';
      for (let i = 0; i <= rows; i++) {
        const y = padding.t + (plotH * i) / rows;
        ctx.fillText(fmtAxis(axes[1].max * (1 - i / rows)), w - padding.r + 6, y + 3.5);
      }
    }
    // X 轴时间刻度
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(167,176,198,.55)';
    const ticks = Math.min(6, Math.max(2, Math.floor(plotW / 110)));
    for (let i = 0; i <= ticks; i++) {
      const t = xMin + (xSpan * i) / ticks;
      const x = X(t);
      const d = new Date(t);
      const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      ctx.fillText(label, Math.min(w - padding.r - 16, Math.max(padding.l + 16, x)), hgt - 8);
    }

    // 绘制每条曲线
    for (const s of series) {
      const axis = s.yAxis || 0;
      const pts = points
        .map((p) => ({ x: X(Number(p[this.opts.xKey])), y: Y(Number(p[s.key]) || 0, axis), v: Number(p[s.key]) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!pts.length) continue;
      if (s.fill !== false) {
        const grad = ctx.createLinearGradient(0, padding.t, 0, padding.t + plotH);
        grad.addColorStop(0, hexA(s.color, 0.26));
        grad.addColorStop(1, hexA(s.color, 0.01));
        ctx.beginPath();
        ctx.moveTo(pts[0].x, padding.t + plotH);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1].x, padding.t + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (pts.length > 40) {
        // 点太多时不画点
      } else {
        ctx.fillStyle = s.color;
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    this.axes = axes;
    this.xMin = xMin;
    this.xMax = xMax;
    this.series = series;
  }

  onMove(e) {
    if (!this.geom || !this.series) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const { padding, plotW } = this.geom;
    const frac = (mx - padding.l) / plotW;
    if (frac < 0 || frac > 1) { this.tip.style.display = 'none'; return; }
    const points = this.opts.points || [];
    if (!points.length) return;
    const t = this.xMin + frac * (this.xMax - this.xMin);
    // 找最近点
    let best = null;
    let bestD = Infinity;
    for (const p of points) {
      const d = Math.abs(Number(p[this.opts.xKey]) - t);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return;
    const d = new Date(Number(best[this.opts.xKey]));
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const lines = this.series.map((s) => {
      const v = Number(best[s.key]);
      return `${s.label}: ${Number.isFinite(v) ? fmtTip(v) : '—'}${s.unit || ''}`;
    });
    this.tip.innerHTML = `<div style="color:var(--text-3);margin-bottom:2px">${time}</div>${lines.join('<br>')}`;
    this.tip.style.display = 'block';
    const x = Math.min(this.geom.w - this.tip.offsetWidth - 8, Math.max(8, mx + 14));
    this.tip.style.left = x + 'px';
    this.tip.style.top = '12px';
  }
}

function fmtAxis(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (Math.abs(n) >= 10) return Math.round(n).toString();
  return n.toFixed(1);
}

function fmtTip(v) {
  if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'k';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function hexA(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(124,92,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
