import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANTENNAS, gainLocal, axesFromAzTilt, gainWorld, polLoss, polOf, sectorGain } from '../app/js/rf/antennas.js';
import { FadingProcess, ricianPdfDb, estimateK } from '../app/js/rf/fading.js';
import { rng, gauss } from '../app/js/util.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('half-wave dipole: 2.15 dBi broadside, deep null along the axis', () => {
  const d = ANTENNAS.dipole;
  near(gainLocal(d, 1, 0, 0), 2.15, 1e-6, 'broadside');
  assert.ok(gainLocal(d, 0, 1, 0) <= d.g - 20, 'zenith null');
  near(gainLocal(d, Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0), 2.15 + 20 * Math.log10(Math.cos((Math.PI / 2) * Math.SQRT1_2) / Math.SQRT1_2), 1e-6, '45°');
});

test('directional patterns follow the 3GPP parabolic cut', () => {
  const p = ANTENNAS.patch;
  near(gainLocal(p, 1, 0, 0), p.g, 1e-9, 'boresight');
  near(gainLocal(p, -1, 0, 0), p.g - p.am, 1e-9, 'front-to-back');
  const half = (p.bwAz / 2) * (Math.PI / 180);
  near(gainLocal(p, Math.cos(half), 0, Math.sin(half)), p.g - 3, 1e-9, '-3 dB at half beamwidth');
  // a tilted panel points its beam upwards
  const ax = axesFromAzTilt(0, 30);
  const up30 = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0];
  near(gainWorld(p, ax, up30), p.g, 1e-9, 'tilted boresight');
  // three sectors cover all azimuths within the 65° crossover loss
  const s = ANTENNAS.sector;
  for (let az = 0; az < 360; az += 7) {
    const a = (az * Math.PI) / 180;
    const g = sectorGain(s, 0, [Math.cos(a) * Math.cos(-s.tilt * Math.PI / 180), Math.sin(s.tilt * Math.PI / 180), Math.sin(a) * Math.cos(-s.tilt * Math.PI / 180)]).g;
    assert.ok(g > s.g - 12, `sector coverage at ${az}°`);
  }
});

test('polarisation mismatch', () => {
  const k = [1, 0, 0];
  const v = { type: 'lin', v: [0, 1, 0] };
  const h = { type: 'lin', v: [0, 0, 1] };
  near(polLoss(v, v, k), 0, 1e-9, 'co-polar');
  near(polLoss(v, h, k), 20, 1e-9, 'cross-polar capped at 20 dB');
  near(polLoss(v, { type: 'CP' }, k), 3.01, 1e-9, 'linear vs circular');
  near(polLoss({ type: 'CP' }, { type: 'CP' }, k), 0, 1e-9, 'CP vs CP');
  const tilted = { type: 'lin', v: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] };
  near(polLoss(v, tilted, k), -20 * Math.log10(Math.cos(Math.PI / 6)), 1e-9, '30° bank');
  assert.equal(polOf(ANTENNAS.sector, axesFromAzTilt(0, 0)).type, 'X');
});

test('sum-of-sinusoids fading: unit power and Rayleigh statistics', () => {
  const rand = rng(42);
  const N = 40000;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let sum = 0;
  let below = 0;
  let count = 0;
  // many independent processes so the ensemble statistics are tight
  for (let p = 0; p < 20; p++) {
    const f = new FadingProcess(rand, 8);
    f.generate(120, 1 / 400, N, re, im);
    for (let i = 0; i < N; i += 7) {
      const pw = re[i] * re[i] + im[i] * im[i];
      sum += pw;
      if (pw < 0.1) below++;
      count++;
    }
  }
  near(sum / count, 1, 0.08, 'mean power');
  near(below / count, 1 - Math.exp(-0.1), 0.03, 'P(power < 0.1) Rayleigh');
});

test('Rician PDF in dB integrates to one; K estimator recovers K', () => {
  for (const k of [0, 1, 10]) {
    let s = 0;
    for (let x = -50; x < 25; x += 0.01) s += ricianPdfDb(x, 1, k) * 0.01;
    near(s, 1, 0.01, `∫pdf K=${k}`);
  }
  const rand = rng(7);
  const K = 5;
  const n = 50000;
  const p = new Float64Array(n);
  const a = Math.sqrt(K / (K + 1));
  const s = Math.sqrt(1 / (2 * (K + 1)));
  for (let i = 0; i < n; i++) {
    const x = a + s * gauss(rand);
    const y = s * gauss(rand);
    p[i] = x * x + y * y;
  }
  near(estimateK(p, n), K, 0.5, 'moment K estimate');
});
