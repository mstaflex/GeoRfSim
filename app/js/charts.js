/*
 * 2-D canvas charts. Colours: categorical slots for series identity, status
 * colours only for good/bad meaning, ink tokens for all text, hairline grid.
 */
import { ricianPdfDb } from './rf/fading.js';
import { clamp } from './util.js';

export const COL = {
  surface: '#1a1a19',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  s1: '#3987e5',
  s2: '#d95926',
  s3: '#199e70',
  s4: '#c98500',
  s5: '#d55181',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};
const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function prep(canvas, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(50, canvas.clientWidth || canvas.parentElement.clientWidth);
  if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`;
  const bw = Math.round(w * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, cssH);
  ctx.font = FONT;
  return { ctx, w, h: cssH };
}

function niceStep(span, target) {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1)];
}

function showTip(tip, parent, x, y, rows) {
  tip.textContent = '';
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'row';
    if (r.color) {
      const k = document.createElement('i');
      k.className = 'key-line';
      k.style.background = r.color;
      div.append(k);
    }
    const b = document.createElement('b');
    b.textContent = r.value;
    div.append(b);
    if (r.label) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = r.label;
      div.append(s);
    }
    tip.append(div);
  }
  tip.hidden = false;
  const pw = parent.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = `${clamp(x + 12, 0, pw - tw)}px`;
  tip.style.top = `${Math.max(0, y - 10)}px`;
}

// ------------------------------------------------------------------ distribution

export class DistChart {
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.tip = tip;
    this.mode = 'pdf';
    this.cssH = 190;
    this.last = null;
    canvas.addEventListener('pointermove', (e) => this.#hover(e));
    canvas.addEventListener('pointerleave', () => {
      this.tip.hidden = true;
      this.hoverX = null;
    });
  }

  /** d: { eff, nb (dB arrays), minSnr, K (linear model K), name } */
  draw(d) {
    const { ctx, w, h } = prep(this.canvas, this.cssH);
    const pad = { l: 36, r: 8, t: 8, b: 24 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    this.last = null;
    if (!d || d.nb.length < 50) {
      ctx.fillStyle = COL.muted;
      ctx.fillText('collecting samples …', pad.l + 8, pad.t + 20);
      return;
    }
    const nbS = Float32Array.from(d.nb).sort();
    const effS = Float32Array.from(d.eff).sort();
    let lo = Math.floor(Math.min(quantile(nbS, 0.002), quantile(effS, 0.002), d.minSnr) - 2);
    let hi = Math.ceil(Math.max(quantile(nbS, 0.998), quantile(effS, 0.998)) + 2);
    if (hi - lo < 16) {
      const c = (hi + lo) / 2;
      lo = Math.floor(c - 8);
      hi = Math.ceil(c + 8);
    }
    const span = hi - lo;
    const bin = span > 60 ? 2 : span > 28 ? 1 : 0.5;
    const nb = Math.ceil(span / bin);
    const hNb = new Float32Array(nb);
    const hEff = new Float32Array(nb);
    for (const v of d.nb) hNb[clamp(Math.floor((v - lo) / bin), 0, nb - 1)]++;
    for (const v of d.eff) hEff[clamp(Math.floor((v - lo) / bin), 0, nb - 1)]++;
    const n = d.nb.length;
    for (let i = 0; i < nb; i++) {
      hNb[i] /= n * bin;
      hEff[i] /= n * bin;
    }
    // Rician theory for the narrow-band envelope
    let mean = 0;
    for (const v of d.nb) mean += Math.pow(10, v / 10);
    mean /= n;
    const step = 0.25;
    const tx = [];
    const ty = [];
    let cum = 0;
    const tc = [];
    for (let x = lo; x <= hi; x += step) {
      const p = ricianPdfDb(x, mean, d.K);
      tx.push(x);
      ty.push(p);
      cum += p * step;
      tc.push(cum);
    }
    const X = (v) => pad.l + ((v - lo) / span) * pw;
    this.last = { lo, hi, bin, nb, hNb, hEff, nbS, effS, X, pad, pw, ph, tx, ty, tc, minSnr: d.minSnr };

    if (this.mode === 'pdf') {
      let ymax = 0;
      for (let i = 0; i < nb; i++) ymax = Math.max(ymax, hNb[i], hEff[i]);
      for (const v of ty) ymax = Math.max(ymax, v);
      ymax *= 1.08;
      const Y = (v) => pad.t + ph - (v / ymax) * ph;
      this.#yGrid(ctx, pad, pw, ph, ymax, (v) => `${(v * 100).toFixed(v * 100 < 1 ? 1 : 0)}`, Y, niceStep(ymax, 3), '%/dB');
      // narrow-band histogram bars
      const bw = (bin / span) * pw;
      const gap = bw > 6 ? 1 : 0;
      ctx.fillStyle = COL.s1;
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < nb; i++) {
        if (!hNb[i]) continue;
        const x0 = X(lo + i * bin) + gap / 2;
        const y0 = Y(hNb[i]);
        ctx.fillRect(x0, y0, Math.max(bw - gap, 0.8), pad.t + ph - y0);
      }
      ctx.globalAlpha = 1;
      // effective distribution as a step line
      ctx.strokeStyle = COL.s2;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < nb; i++) {
        const y = Y(hEff[i]);
        const xa = X(lo + i * bin);
        const xb = X(lo + (i + 1) * bin);
        if (i === 0) ctx.moveTo(xa, y);
        else ctx.lineTo(xa, y);
        ctx.lineTo(xb, y);
      }
      ctx.stroke();
      // theory
      ctx.strokeStyle = COL.ink2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      tx.forEach((x, i) => (i ? ctx.lineTo(X(x), Y(ty[i])) : ctx.moveTo(X(x), Y(ty[i]))));
      ctx.stroke();
      this.last.Y = Y;
    } else {
      const LMIN = -3;
      const Y = (p) => pad.t + ph - ((Math.log10(Math.max(p, 1e-3)) - LMIN) / -LMIN) * ph;
      ctx.strokeStyle = COL.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = COL.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const [p, lab] of [[1, '100%'], [0.1, '10%'], [0.01, '1%'], [0.001, '0.1%']]) {
        const y = Math.round(Y(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + pw, y);
        ctx.stroke();
        ctx.fillText(lab, pad.l - 4, y);
      }
      const cdfLine = (sorted, color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        const m = sorted.length;
        const stride = Math.max(1, Math.floor(m / 600));
        let started = false;
        for (let i = 0; i < m; i += stride) {
          const p = (i + 1) / m;
          if (p < 1e-3) continue;
          const x = X(sorted[i]);
          const y = Y(p);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.lineTo(X(sorted[m - 1]), Y(1));
        ctx.stroke();
      };
      cdfLine(nbS, COL.s1, 2);
      cdfLine(effS, COL.s2, 2);
      ctx.strokeStyle = COL.ink2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      tx.forEach((x, i) => {
        if (tc[i] < 1e-3) return;
        if (!started) {
          ctx.moveTo(X(x), Y(tc[i]));
          started = true;
        } else ctx.lineTo(X(x), Y(Math.min(tc[i], 1)));
      });
      ctx.stroke();
      this.last.Y = Y;
    }

    // x axis
    this.#xAxis(ctx, pad, pw, ph, lo, hi, X);
    // threshold
    const xt = X(d.minSnr);
    if (xt > pad.l && xt < pad.l + pw) {
      ctx.strokeStyle = COL.critical;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(xt) + 0.5, pad.t);
      ctx.lineTo(Math.round(xt) + 0.5, pad.t + ph);
      ctx.stroke();
      ctx.fillStyle = COL.ink2;
      ctx.textAlign = xt > pad.l + pw - 70 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('min. needed', xt + (ctx.textAlign === 'left' ? 4 : -4), pad.t + 1);
    }
    // percentile ticks of the effective distribution
    ctx.fillStyle = COL.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const x1 = X(quantile(effS, 0.01));
    const x10 = X(quantile(effS, 0.1));
    const tight = x10 - x1 < 30;
    for (const [x, lab, align] of [[x1, '1%', tight ? 'right' : 'center'], [x10, '10%', tight ? 'left' : 'center']]) {
      if (x < pad.l || x > pad.l + pw) continue;
      ctx.beginPath();
      ctx.moveTo(x, pad.t + ph);
      ctx.lineTo(x - 4, pad.t + ph - 7);
      ctx.lineTo(x + 4, pad.t + ph - 7);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = align;
      ctx.fillText(lab, x + (align === 'right' ? -3 : align === 'left' ? 3 : 0), pad.t + ph - 8);
    }
    if (this.hoverX !== null && this.hoverX !== undefined) this.#tipAt(this.hoverX, this.hoverY);
  }

  #yGrid(ctx, pad, pw, ph, ymax, fmt, Y, stepV, unit) {
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COL.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= ymax + 1e-9; v += stepV) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
      ctx.fillText(fmt(v), pad.l - 4, y);
    }
    ctx.save();
    ctx.translate(9, pad.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(unit, 0, 0);
    ctx.restore();
  }

  #xAxis(ctx, pad, pw, ph, lo, hi, X) {
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + ph + 0.5);
    ctx.lineTo(pad.l + pw, pad.t + ph + 0.5);
    ctx.stroke();
    ctx.fillStyle = COL.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const st = niceStep(hi - lo, 7);
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) ctx.fillText(`${v}`, X(v), pad.t + ph + 4);
    ctx.textAlign = 'right';
    ctx.fillText('dB', pad.l + pw, pad.t + ph + 4 + 11);
  }

  #hover(e) {
    const r = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - r.left;
    this.hoverY = e.clientY - r.top;
    this.#tipAt(this.hoverX, this.hoverY);
  }

  #tipAt(x, y) {
    const L = this.last;
    if (!L || x < L.pad.l || x > L.pad.l + L.pw) {
      this.tip.hidden = true;
      return;
    }
    const v = L.lo + ((x - L.pad.l) / L.pw) * (L.hi - L.lo);
    const rows = [{ value: `${v.toFixed(1)} dB`, label: this.mode === 'pdf' ? 'SINR bin' : 'SINR below' }];
    if (this.mode === 'pdf') {
      const i = clamp(Math.floor((v - L.lo) / L.bin), 0, L.nb - 1);
      rows.push({ value: `${(L.hNb[i] * 100).toFixed(1)} %/dB`, label: 'narrow-band, 1 antenna', color: COL.s1 });
      rows.push({ value: `${(L.hEff[i] * 100).toFixed(1)} %/dB`, label: 'effective', color: COL.s2 });
    } else {
      const frac = (s) => {
        let a = 0;
        let b = s.length;
        while (a < b) {
          const m = (a + b) >> 1;
          if (s[m] < v) a = m + 1;
          else b = m;
        }
        return a / s.length;
      };
      rows.push({ value: `${(frac(L.nbS) * 100).toFixed(1)} %`, label: 'narrow-band, 1 antenna', color: COL.s1 });
      rows.push({ value: `${(frac(L.effS) * 100).toFixed(1)} %`, label: 'effective', color: COL.s2 });
    }
    showTip(this.tip, this.canvas.parentElement, x, y, rows);
  }
}

// ------------------------------------------------------------------ history

export class HistoryChart {
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.tip = tip;
    this.cssH = 150;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY - r.top;
      this.#tipAt();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.tip.hidden = true;
    });
  }

  /** d: { v, m (dB arrays, oldest first), rate (Hz), minSnr, span (s) } */
  draw(d) {
    const { ctx, w, h } = prep(this.canvas, this.cssH);
    const pad = { l: 36, r: 8, t: 8, b: 22 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const span = d.span;
    const n = d.v.length;
    this.last = null;
    if (n < 4) {
      ctx.fillStyle = COL.muted;
      ctx.fillText('collecting samples …', pad.l + 8, pad.t + 20);
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = d.v[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    lo = Math.max(lo, hi - 70);
    lo = Math.floor(Math.min(lo, d.minSnr - 3) / 5) * 5;
    hi = Math.ceil(Math.max(hi, d.minSnr + 3) / 5) * 5;
    if (hi - lo < 20) hi = lo + 20;
    const X = (i) => pad.l + pw - ((n - 1 - i) / d.rate / span) * pw;
    const Y = (v) => pad.t + ph - ((clamp(v, lo, hi) - lo) / (hi - lo)) * ph;
    // grid
    ctx.strokeStyle = COL.grid;
    ctx.fillStyle = COL.muted;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const st = niceStep(hi - lo, 4);
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
      ctx.fillText(`${v}`, pad.l - 4, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= span; s += 5) ctx.fillText(s ? `−${s}s` : 'now', pad.l + pw - (s / span) * pw, pad.t + ph + 5);
    // instantaneous: min/max per pixel column
    ctx.strokeStyle = COL.s1;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let col = -1;
    let mn = 0;
    let mx = 0;
    const flush = () => {
      if (col < 0) return;
      ctx.moveTo(col + 0.5, Y(mx));
      ctx.lineTo(col + 0.5, Y(mn) + 0.6);
    };
    let px = null;
    for (let i = 0; i < n; i++) {
      const x = Math.floor(X(i));
      if (x < pad.l) continue;
      const v = d.v[i];
      if (x !== col) {
        flush();
        if (px !== null) ctx.moveTo(px[0], px[1]);
        col = x;
        mn = v;
        mx = v;
      } else {
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      px = [x + 0.5, Y(v)];
    }
    flush();
    ctx.stroke();
    // large-scale mean
    ctx.strokeStyle = COL.ink2;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += 2) {
      const x = X(i);
      if (x < pad.l) continue;
      if (!started) {
        ctx.moveTo(x, Y(d.m[i]));
        started = true;
      } else ctx.lineTo(x, Y(d.m[i]));
    }
    ctx.stroke();
    // threshold
    const yt = Math.round(Y(d.minSnr)) + 0.5;
    ctx.strokeStyle = COL.critical;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, yt);
    ctx.lineTo(pad.l + pw, yt);
    ctx.stroke();
    ctx.fillStyle = COL.ink2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('min. needed', pad.l + 4, yt - 2);
    this.last = { d, X, Y, pad, pw, ph, n };
    if (this.hoverX !== null && this.hoverX !== undefined) {
      this.#tipAt();
      const i = this.hoverIdx;
      if (i !== undefined) {
        const x = Math.round(X(i)) + 0.5;
        ctx.strokeStyle = COL.ink2;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + ph);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  #tipAt() {
    const L = this.last;
    if (!L || this.hoverX < L.pad.l || this.hoverX > L.pad.l + L.pw) {
      this.tip.hidden = true;
      this.hoverIdx = undefined;
      return;
    }
    const ago = ((L.pad.l + L.pw - this.hoverX) / L.pw) * L.d.span;
    const i = clamp(Math.round(L.n - 1 - ago * L.d.rate), 0, L.n - 1);
    this.hoverIdx = i;
    showTip(this.tip, this.canvas.parentElement, this.hoverX, this.hoverY, [
      { value: `−${ago.toFixed(1)} s`, label: '' },
      { value: `${L.d.v[i].toFixed(1)} dB`, label: 'SINR (instantaneous)', color: COL.s1 },
      { value: `${L.d.m[i].toFixed(1)} dB`, label: 'large-scale mean', color: COL.ink2 },
    ]);
  }
}

// ------------------------------------------------------------------ polar

export class PolarChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.cssH = 220;
  }

  /**
   * series: [{ color, cut: (deg) → dBi, marker: deg }], angle 0° = horizontal towards
   * the drone, 90° = up. Rings span [top − 40, top] dBi.
   */
  draw(series) {
    const { ctx, w, h } = prep(this.canvas, this.cssH);
    const cx = w / 2;
    const cy = h / 2 + 2;
    const R = Math.min(w, h) / 2 - 16;
    let top = -Infinity;
    const cuts = series.map((s) => {
      const pts = [];
      for (let a = 0; a <= 360; a += 2) {
        const g = s.cut(a);
        pts.push(g);
        top = Math.max(top, g);
      }
      return pts;
    });
    top = Math.ceil(top / 10) * 10;
    const range = 40;
    const rad = (g) => (clamp(g - (top - range), 0, range) / range) * R;
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COL.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${top - range + (range * k) / 4}`, cx + 3, cy - (R * k) / 4 + 7);
    }
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(t) * R, cy - Math.sin(t) * R);
      ctx.stroke();
    }
    ctx.fillStyle = COL.muted;
    ctx.textAlign = 'center';
    ctx.fillText('up', cx, cy - R - 8);
    ctx.fillText('down', cx, cy + R + 9);
    ctx.textAlign = 'left';
    ctx.fillText('→ drone', cx + R - 34, cy - 9);
    ctx.textAlign = 'right';
    ctx.fillText('dBi', w - 2, 10);
    series.forEach((s, i) => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      cuts[i].forEach((g, k) => {
        const t = (k * 2 * Math.PI) / 180;
        const r = rad(g);
        const x = cx + Math.cos(t) * r;
        const y = cy - Math.sin(t) * r;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      // marker: current direction to the other end of the link
      const t = (s.marker * Math.PI) / 180;
      const r = rad(s.cut(s.marker));
      ctx.fillStyle = s.color;
      ctx.strokeStyle = COL.surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(t) * r, cy - Math.sin(t) * r, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(t) * R, cy - Math.sin(t) * R);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }
}

// ------------------------------------------------------------------ minimap

export class Minimap {
  constructor(canvas, onPick) {
    this.canvas = canvas;
    this.bg = document.createElement('canvas');
    canvas.addEventListener('click', (e) => {
      if (!this.world) return;
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fz = (e.clientY - r.top) / r.height;
      onPick(-this.world.half + fx * this.world.S, -this.world.half + fz * this.world.S);
    });
  }

  setWorld(world, tex) {
    this.world = world;
    this.bg.width = tex.T;
    this.bg.height = tex.T;
    const c = this.bg.getContext('2d');
    c.putImageData(new ImageData(new Uint8ClampedArray(tex.px), tex.T, tex.T), 0, 0);
    // buildings on top
    c.fillStyle = 'rgba(205, 205, 210, 0.9)';
    const s = tex.T / world.S;
    for (const b of world.buildings) c.fillRect((b.x0 + world.half) * s, (b.z0 + world.half) * s, Math.max((b.x1 - b.x0) * s, 1), Math.max((b.z1 - b.z0) * s, 1));
  }

  /** st: { track, colorOf, path, pilot, cell, drone, heading, view: {x, z, yaw} } */
  draw(st) {
    const w = this.world;
    if (!w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(cw * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bg, 0, 0, cw, ch);
    const P = (x, z) => [((x + w.half) / w.S) * cw, ((z + w.half) / w.S) * ch];
    // planned path
    if (st.path) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(st.path.x.length / 400));
      for (let i = 0; i < st.path.x.length; i += step) {
        const [x, y] = P(st.path.x[i], st.path.z[i]);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    // flown track
    const t = st.track;
    if (t.n > 1) {
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      const step = Math.max(1, Math.floor(t.n / 1500));
      let [px, py] = P(t.x[0], t.z[0]);
      for (let i = step; i < t.n; i += step) {
        const [x, y] = P(t.x[i], t.z[i]);
        const c = st.colorOf(i);
        ctx.strokeStyle = `rgb(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0})`;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
        px = x;
        py = y;
      }
    }
    // camera view direction
    if (st.view) {
      const [vx, vy] = P(st.view.x, st.view.z);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      const a = st.view.yaw + Math.PI;
      ctx.arc(vx, vy, 26, a - 0.45, a + 0.45);
      ctx.closePath();
      ctx.fill();
    }
    // nodes
    const dot = (x, z, r, fill) => {
      const [a, b] = P(x, z);
      ctx.fillStyle = fill;
      ctx.strokeStyle = COL.surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a, b, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    dot(st.pilot.x, st.pilot.z, 4.5, '#f29e35');
    const [cx, cy] = P(st.cell.x, st.cell.z);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = COL.surface;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx + 5, cy + 4);
    ctx.lineTo(cx - 5, cy + 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // drone arrow
    const [dx, dy] = P(st.drone.x, st.drone.z);
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(st.heading);
    ctx.fillStyle = COL.s1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
