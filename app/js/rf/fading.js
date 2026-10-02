/*
 * Small-scale fading. The diffuse (scattered) part is a unit-power complex
 * Gaussian process built from a sum of sinusoids (Zheng & Xiao 2003 variant of
 * the Clarke/Jakes model), so its envelope is Rayleigh and its Doppler spectrum
 * follows the classic U shape. Adding a coherent (LOS + ground bounce) term
 * turns it into Rician fading with K = coherent / diffuse power.
 */
import { TAU, besselI0e } from '../util.js';

export class FadingProcess {
  /**
   * @param {() => number} rand seeded random source
   * @param {number} n sinusoids per quadrature branch
   */
  constructor(rand, n = 8) {
    this.n = n;
    this.cosI = new Float64Array(n);
    this.cosQ = new Float64Array(n);
    this.phI = new Float64Array(n);
    this.phQ = new Float64Array(n);
    // scratch: current phasors and per-sample rotations
    this.cI = new Float64Array(n);
    this.sI = new Float64Array(n);
    this.cQ = new Float64Array(n);
    this.sQ = new Float64Array(n);
    this.rcI = new Float64Array(n);
    this.rsI = new Float64Array(n);
    this.rcQ = new Float64Array(n);
    this.rsQ = new Float64Array(n);
    const thI = (rand() - 0.5) * TAU;
    const thQ = (rand() - 0.5) * TAU;
    for (let k = 0; k < n; k++) {
      this.cosI[k] = Math.cos((TAU * (k + 1) - Math.PI + thI) / (4 * n));
      this.cosQ[k] = Math.cos((TAU * (k + 1) - Math.PI + thQ) / (4 * n));
      this.phI[k] = rand() * TAU;
      this.phQ[k] = rand() * TAU;
    }
    this.norm = Math.sqrt(1 / n);
  }

  /**
   * Writes `count` samples spaced dt seconds apart, max Doppler fd (Hz), into
   * re/im starting at `offset`. E[re² + im²] = 1.
   */
  generate(fd, dt, count, re, im, offset = 0) {
    const n = this.n;
    const w = TAU * fd * dt;
    const { cI, sI, cQ, sQ, rcI, rsI, rcQ, rsQ } = this;
    for (let k = 0; k < n; k++) {
      cI[k] = Math.cos(this.phI[k]);
      sI[k] = Math.sin(this.phI[k]);
      cQ[k] = Math.cos(this.phQ[k]);
      sQ[k] = Math.sin(this.phQ[k]);
      const aI = w * this.cosI[k];
      const aQ = w * this.cosQ[k];
      rcI[k] = Math.cos(aI);
      rsI[k] = Math.sin(aI);
      rcQ[k] = Math.cos(aQ);
      rsQ[k] = Math.sin(aQ);
    }
    for (let i = 0; i < count; i++) {
      let sumI = 0;
      let sumQ = 0;
      for (let k = 0; k < n; k++) {
        const c = cI[k] * rcI[k] - sI[k] * rsI[k];
        sI[k] = sI[k] * rcI[k] + cI[k] * rsI[k];
        cI[k] = c;
        sumI += c;
        const c2 = cQ[k] * rcQ[k] - sQ[k] * rsQ[k];
        sQ[k] = sQ[k] * rcQ[k] + cQ[k] * rsQ[k];
        cQ[k] = c2;
        sumQ += sQ[k];
      }
      re[offset + i] = sumI * this.norm;
      im[offset + i] = sumQ * this.norm;
    }
    for (let k = 0; k < n; k++) {
      this.phI[k] = (this.phI[k] + count * w * this.cosI[k]) % TAU;
      this.phQ[k] = (this.phQ[k] + count * w * this.cosQ[k]) % TAU;
    }
  }
}

/**
 * Rician power PDF in the dB domain: density of x = 10·log10(P) for mean
 * power Ω (linear) and K-factor k (linear; 0 = Rayleigh).
 */
export function ricianPdfDb(xDb, omega, k) {
  const p = Math.pow(10, xDb / 10);
  const a = (k + 1) / omega;
  const z = 2 * Math.sqrt(k * (k + 1) * p / omega);
  // f_P(p) = a·exp(−k − a·p)·I0(z); I0 is used exponentially scaled for stability
  const fp = a * Math.exp(-k - a * p + z) * besselI0e(z);
  return fp * p * Math.LN10 / 10;
}

/** Moment-based K estimate from samples of linear power (Greenstein et al. 1999). */
export function estimateK(powers, count) {
  if (count < 16) return NaN;
  let m1 = 0;
  let m2 = 0;
  for (let i = 0; i < count; i++) {
    const p = powers[i];
    m1 += p;
    m2 += p * p;
  }
  m1 /= count;
  m2 /= count;
  const v = m2 - m1 * m1;
  if (m1 <= 0) return NaN;
  const g = v / (m1 * m1);
  if (g >= 1) return 0;
  const r = Math.sqrt(1 - g);
  return r / (1 - r);
}
