/* Shared helpers: constants, seeded randomness, gradient noise, math, formatting. */

/** Speed of light in m/s. */
export const C0 = 299792458;
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToLin = (db) => Math.pow(10, db / 10);
export const linToDb = (lin) => 10 * Math.log10(lin);

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** mulberry32 - tiny, fast, seedable PRNG returning floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate (Box-Muller). */
export function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
}

/** FNV-1a string hash - turns ids into seeds. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 2-D gradient noise (Perlin, quintic fade). Returns a function (x, y) -> ~[-1, 1]. */
export function makeNoise2D(seed) {
  const rand = rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256);
  const gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rand() * TAU;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const h00 = perm[X + perm[Y]];
    const h10 = perm[X + 1 + perm[Y]];
    const h01 = perm[X + perm[Y + 1]];
    const h11 = perm[X + 1 + perm[Y + 1]];
    const n00 = gx[h00] * xf + gy[h00] * yf;
    const n10 = gx[h10] * (xf - 1) + gy[h10] * yf;
    const n01 = gx[h01] * xf + gy[h01] * (yf - 1);
    const n11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.41;
  };
}

/** Fractal Brownian motion over a noise function. */
export function fbm(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f, y * f);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Bessel J0 (Abramowitz & Stegun 9.4.1 / 9.4.3), |error| < 1e-7. */
export function besselJ0(x) {
  const ax = Math.abs(x);
  if (ax <= 3) {
    const y = (x / 3) ** 2;
    return 1 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.00021)))));
  }
  const y = 3 / ax;
  const f0 = 0.79788456 + y * (-0.00000077 + y * (-0.0055274 + y * (-0.00009512 + y * (0.00137237 + y * (-0.00072805 + y * 0.00014476)))));
  const t0 = ax - 0.78539816 + y * (-0.04166397 + y * (-0.00003954 + y * (0.00262573 + y * (-0.00054125 + y * (-0.00029333 + y * 0.00013558)))));
  return (f0 * Math.cos(t0)) / Math.sqrt(ax);
}

/** Exponentially scaled modified Bessel I0: exp(-|x|) * I0(x) (A&S 9.8.1 / 9.8.2). */
export function besselI0e(x) {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    const y = (x / 3.75) ** 2;
    return Math.exp(-ax) * (1 + y * (3.5156229 + y * (3.0899424 + y * (1.2067492 + y * (0.2659732 + y * (0.0360768 + y * 0.0045813))))));
  }
  const y = 3.75 / ax;
  return (0.39894228 + y * (0.01328592 + y * (0.00225319 + y * (-0.00157565 + y * (0.00916281 + y * (-0.02057706 + y * (0.02635537 + y * (-0.01647633 + y * 0.00392377)))))))) / Math.sqrt(ax);
}

// ------------------------------------------------------------------ formatting

export function fmtHz(f) {
  const a = Math.abs(f);
  if (a >= 1e9) return `${+(f / 1e9).toFixed(a >= 1e10 ? 0 : 2)} GHz`;
  if (a >= 1e6) return `${+(f / 1e6).toFixed(a >= 1e8 ? 0 : 1)} MHz`;
  if (a >= 1e3) return `${+(f / 1e3).toFixed(a >= 1e4 ? 0 : 1)} kHz`;
  return `${Math.round(f)} Hz`;
}

export function fmtRate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '–';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(bps >= 1e5 ? 0 : 1)} kbps`;
  return `${Math.round(bps)} bps`;
}

export function fmtDist(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 1e4 ? 1 : 2)} km`;
  return `${Math.round(m)} m`;
}

export function fmtDb(v, digits = 1) {
  if (!Number.isFinite(v)) return '–';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
}

export function fmtPct(p) {
  if (!Number.isFinite(p)) return '–';
  if (p < 0.001) return '<0.1 %';
  if (p < 0.1) return `${(p * 100).toFixed(1)} %`;
  return `${Math.round(p * 100)} %`;
}
