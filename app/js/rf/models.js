/*
 * Established propagation models, kept as small pure functions so each
 * contribution can be shown on its own. Units: f in Hz, distances and heights
 * in m, angles in degrees unless noted, losses in dB (positive = loss).
 */
import { C0, DEG, clamp } from '../util.js';

/**
 * Clutter classes. K-factor end points follow the exponential-in-elevation law
 * K(θ) = K0·exp(2θ/π·ln(K90/K0)) used for air-to-ground links (Azari et al.,
 * IEEE TCOM 2018), i.e. linear in dB; values are tuned to the ranges measured
 * in the NASA/Matolak air-ground campaigns. Ground constants follow ITU-R P.527,
 * delay spreads and shadowing follow 3GPP TR 38.901 / TR 36.777 orders of
 * magnitude. `ism` = assumed unlicensed-band noise rise [dB at ground, dB per
 * decade of receiver height above 10 m].
 */
export const ENVS = {
  water: { name: 'Water', rank: 0, k0: 10, k90: 28, epsR: 80, sigma: 0.01, rough: 0.02, ds: 20, sfLos: 2.5, sfNlos: 6, dcorr: 120, ism: [0.2, 0.4] },
  open: { name: 'Open / rural', rank: 1, k0: 6, k90: 22, epsR: 15, sigma: 0.005, rough: 0.06, ds: 30, sfLos: 4, sfNlos: 8, dcorr: 60, ism: [0.3, 0.6] },
  forest: { name: 'Forest', rank: 2, k0: 2, k90: 16, epsR: 20, sigma: 0.01, rough: 0.6, ds: 60, sfLos: 5, sfNlos: 8, dcorr: 30, ism: [0.2, 0.5] },
  suburban: { name: 'Suburban', rank: 3, k0: 3, k90: 18, epsR: 6, sigma: 0.005, rough: 0.3, ds: 50, sfLos: 4, sfNlos: 6, dcorr: 37, ism: [1.5, 1.5] },
  urban: { name: 'Urban', rank: 4, k0: 0, k90: 15, epsR: 5, sigma: 0.01, rough: 0.8, ds: 100, sfLos: 4, sfNlos: 7.8, dcorr: 13, ism: [3, 2.5] },
  dense: { name: 'Dense urban', rank: 5, k0: -3, k90: 12, epsR: 5, sigma: 0.01, rough: 1.2, ds: 140, sfLos: 4, sfNlos: 8, dcorr: 10, ism: [4, 3] },
};

// ----------------------------------------------------------------- free space

/** Free-space path loss (Friis). */
export function fspl(d, f) {
  return 20 * Math.log10(Math.max(d, 1)) + 20 * Math.log10(f) - 147.55;
}

/** Gaseous absorption, dB/km (coarse fit to ITU-R P.676 at sea level, 7.5 g/m³). */
const GAS = [
  [0.1e9, 0.005], [1e9, 0.006], [3e9, 0.008], [6e9, 0.01], [10e9, 0.015],
  [15e9, 0.03], [20e9, 0.09], [22.2e9, 0.2], [26e9, 0.13], [30e9, 0.11], [40e9, 0.13], [60e9, 15],
];
export function gasAttenuation(f) {
  if (f <= GAS[0][0]) return GAS[0][1];
  for (let i = 1; i < GAS.length; i++) {
    if (f <= GAS[i][0]) {
      const [f0, a0] = GAS[i - 1];
      const [f1, a1] = GAS[i];
      const t = Math.log(f / f0) / Math.log(f1 / f0);
      return Math.exp(Math.log(a0) + t * (Math.log(a1) - Math.log(a0)));
    }
  }
  return GAS[GAS.length - 1][1];
}

// ----------------------------------------------------------------- diffraction

/** Fresnel-Kirchhoff parameter ν for an obstacle h metres above the ray. */
export function fresnelNu(h, d1, d2, lambda) {
  return h * Math.sqrt((2 * (d1 + d2)) / (lambda * d1 * d2));
}

/** Radius of the first Fresnel zone at distances d1/d2 from the terminals. */
export function fresnelRadius(d1, d2, lambda) {
  return Math.sqrt((lambda * d1 * d2) / (d1 + d2));
}

/** Single knife-edge diffraction loss J(ν), ITU-R P.526 eq. (31). */
export function knifeEdge(nu) {
  if (nu <= -0.78) return 0;
  const t = nu - 0.1;
  return 6.9 + 20 * Math.log10(Math.sqrt(t * t + 1) + t);
}

// ----------------------------------------------------------------- vegetation

/** Weissberger modified exponential decay model (230 MHz - 95 GHz, depth ≤ 400 m). */
export function weissberger(f, depth) {
  if (depth <= 0) return 0;
  const k = Math.pow(f / 1e9, 0.284);
  if (depth < 14) return 0.45 * k * depth;
  return 1.33 * k * Math.pow(Math.min(depth, 400), 0.588);
}

/** ITU-R P.833 maximum excess attenuation of in-leaf woodland, A_m = 0.18·f^0.752 (f in MHz). */
export function p833MaxAttenuation(f) {
  return 0.18 * Math.pow(f / 1e6, 0.752);
}

/**
 * Vegetation loss: Weissberger's depth law, saturated at the P.833 maximum
 * (A = A_m·(1 − exp(−A_w/A_m))) because beyond some depth the energy arrives
 * scattered over and around the canopy rather than through it.
 */
export function vegetationLoss(f, depth) {
  const aw = weissberger(f, depth);
  if (aw <= 0) return 0;
  const am = p833MaxAttenuation(f);
  return am * (1 - Math.exp(-aw / am));
}

// ----------------------------------------------------------------- ground reflection

function csqrt(re, im) {
  const m = Math.hypot(re, im);
  const r = Math.sqrt((m + re) / 2);
  const i = Math.sqrt(Math.max(0, (m - re) / 2));
  return [r, im < 0 ? -i : i];
}

function cdiv(ar, ai, br, bi) {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
}

/**
 * Fresnel reflection coefficient of flat ground at grazing angle psi (rad).
 * pol: 'V' (vertical), 'H' (horizontal) or 'CP' (co-polar circular, which
 * vanishes at normal incidence - the handedness flips on reflection).
 * Returns [re, im].
 */
export function groundReflection(psi, f, epsR, sigma, pol) {
  const lambda = C0 / f;
  const er = epsR;
  const ei = -60 * lambda * sigma;
  const s = Math.sin(psi);
  const c2 = Math.cos(psi) ** 2;
  const [qr, qi] = csqrt(er - c2, ei);
  const gh = cdiv(s - qr, -qi, s + qr, qi);
  const esr = er * s;
  const esi = ei * s;
  const gv = cdiv(esr - qr, esi - qi, esr + qr, esi + qi);
  if (pol === 'H') return gh;
  if (pol === 'CP') return [(gv[0] + gh[0]) / 2, (gv[1] + gh[1]) / 2];
  return gv;
}

/** Specular attenuation of a rough surface (Rayleigh criterion / Ament): exp(−8(π σh sinψ / λ)²). */
export function roughnessFactor(psi, f, sigmaH) {
  const x = (Math.PI * sigmaH * Math.sin(psi) * f) / C0;
  return Math.exp(-8 * x * x);
}

// ----------------------------------------------------------------- small-scale statistics

/** Rician K-factor (dB) of an unobstructed air-ground link at elevation elevDeg. */
export function kFactorDb(elevDeg, env, f) {
  const e = ENVS[env];
  const t = clamp(elevDeg, 0, 90) / 90;
  return e.k0 + (e.k90 - e.k0) * t + 4 * Math.log10(f / 2e9);
}

/**
 * RMS delay spread in seconds. Ground-level values per clutter class, NLOS
 * stretched by 2.5× (3GPP TR 38.901 UMa: ~100 ns LOS vs ~360 ns NLOS), and
 * decaying once the drone climbs out of the clutter (fewer nearby scatterers).
 */
export function delaySpread(env, nlos, droneAgl, clutterH) {
  let ds = ENVS[env].ds;
  if (nlos) ds *= 2.5;
  const above = Math.max(0, droneAgl - clutterH);
  ds = 8 + (ds - 8) * Math.exp(-above / 120);
  return ds * 1e-9;
}

/** Log-normal shadowing std-dev (dB); LOS decays with height like TR 36.777 UMa-AV. */
export function shadowSigma(env, obstructed, hAgl, vegLoss = 0) {
  const e = ENVS[env];
  const los = Math.max(1, e.sfLos * Math.exp(-0.005 * Math.max(0, hAgl)));
  if (obstructed) return e.sfNlos;
  return los + (e.sfNlos - los) * clamp(vegLoss / 20, 0, 1);
}

// ----------------------------------------------------------------- reference models

/** Al-Hourani et al. (2014) LOS probability and excess losses (2 GHz fit). */
const AL_HOURANI = {
  suburban: { a: 4.88, b: 0.43, etaLos: 0.1, etaNlos: 21 },
  urban: { a: 9.61, b: 0.16, etaLos: 1.0, etaNlos: 20 },
  dense: { a: 12.08, b: 0.11, etaLos: 1.6, etaNlos: 23 },
  highrise: { a: 27.23, b: 0.08, etaLos: 2.3, etaNlos: 34 },
};

export function alHourani(cls, elevDeg, d3, f) {
  const p = AL_HOURANI[cls] || AL_HOURANI.suburban;
  const pLos = 1 / (1 + p.a * Math.exp(-p.b * (elevDeg - p.a)));
  const fs = fspl(d3, f);
  return {
    pLos,
    plLos: fs + p.etaLos,
    plNlos: fs + p.etaNlos,
    plMean: fs + pLos * p.etaLos + (1 - pLos) * p.etaNlos,
  };
}

const log10 = Math.log10;

function pLosAv(d2D, d1, p1) {
  return d2D <= d1 ? 1 : d1 / d2D + Math.exp(-d2D / p1) * (1 - d1 / d2D);
}

/**
 * 3GPP path loss: TR 38.901 for terrestrial heights, TR 36.777 (aerial
 * vehicles) above 10 m (RMa) / 22.5 m (UMa, UMi). Returns LOS probability,
 * LOS/NLOS path loss and shadowing std-devs.
 */
export function gpp(model, d2Din, hBS, hUTin, f) {
  const fc = f / 1e9;
  const d2D = Math.max(d2Din, 10);
  const hUT = clamp(hUTin, 1.5, 300);
  const d3D = Math.hypot(d2D, hBS - hUT);
  const fsc = 20 * log10((40 * Math.PI * fc) / 3);
  let pLos, plLos, plNlos, sfLos, sfNlos;

  if (model === 'RMa') {
    if (hUT <= 10) {
      const h = 5;
      const W = 20;
      const dBP = (2 * Math.PI * hBS * hUT * f) / C0;
      const pl1 = (d) => 20 * log10((40 * Math.PI * d * fc) / 3) + Math.min(0.03 * h ** 1.72, 10) * log10(d)
        - Math.min(0.044 * h ** 1.72, 14.77) + 0.002 * log10(h) * d;
      plLos = d2D <= dBP ? pl1(d3D) : pl1(dBP) + 40 * log10(d3D / dBP);
      const nl = 161.04 - 7.1 * log10(W) + 7.5 * log10(h) - (24.37 - 3.7 * (h / hBS) ** 2) * log10(hBS)
        + (43.42 - 3.1 * log10(hBS)) * (log10(d3D) - 3) + 20 * log10(fc) - (3.2 * log10(11.75 * hUT) ** 2 - 4.97);
      plNlos = Math.max(plLos, nl);
      pLos = d2D <= 10 ? 1 : Math.exp(-(d2D - 10) / 1000);
      sfLos = d2D <= dBP ? 4 : 6;
      sfNlos = 8;
    } else {
      pLos = hUT > 40 ? 1 : pLosAv(d2D, Math.max(1350.8 * log10(hUT) - 1602, 18), Math.max(15021 * log10(hUT) - 16053, 1000));
      plLos = Math.max(23.9 - 1.8 * log10(hUT), 20) * log10(d3D) + fsc;
      plNlos = Math.max(plLos, -12 + (35 - 5.3 * log10(hUT)) * log10(d3D) + fsc);
      sfLos = 4.2 * Math.exp(-0.0046 * hUT);
      sfNlos = 6;
    }
  } else if (model === 'UMi') {
    if (hUT <= 22.5) {
      const dBP = (4 * (hBS - 1) * (hUT - 1) * f) / C0;
      plLos = d2D <= dBP
        ? 32.4 + 21 * log10(d3D) + 20 * log10(fc)
        : 32.4 + 40 * log10(d3D) + 20 * log10(fc) - 9.5 * log10(dBP ** 2 + (hBS - hUT) ** 2);
      plNlos = Math.max(plLos, 35.3 * log10(d3D) + 22.4 + 21.3 * log10(fc) - 0.3 * (hUT - 1.5));
      pLos = d2D <= 18 ? 1 : 18 / d2D + Math.exp(-d2D / 36) * (1 - 18 / d2D);
      sfLos = 4;
      sfNlos = 7.82;
    } else {
      pLos = pLosAv(d2D, Math.max(294.05 * log10(hUT) - 432.94, 18), 233.98 * log10(hUT) - 0.95);
      plLos = Math.max(fspl(d3D, f), 30.9 + (22.25 - 0.5 * log10(hUT)) * log10(d3D) + 20 * log10(fc));
      plNlos = Math.max(plLos, 32.4 + (43.2 - 7.6 * log10(hUT)) * log10(d3D) + 20 * log10(fc));
      sfLos = Math.max(5 * Math.exp(-0.01 * hUT), 2);
      sfNlos = 8;
    }
  } else {
    // UMa
    if (hUT <= 22.5) {
      const dBP = (4 * (hBS - 1) * (hUT - 1) * f) / C0;
      plLos = d2D <= dBP
        ? 28 + 22 * log10(d3D) + 20 * log10(fc)
        : 28 + 40 * log10(d3D) + 20 * log10(fc) - 9 * log10(dBP ** 2 + (hBS - hUT) ** 2);
      plNlos = Math.max(plLos, 13.54 + 39.08 * log10(d3D) + 20 * log10(fc) - 0.6 * (hUT - 1.5));
      const c = hUT <= 13 ? 0 : ((hUT - 13) / 10) ** 1.5;
      pLos = d2D <= 18 ? 1
        : (18 / d2D + Math.exp(-d2D / 63) * (1 - 18 / d2D)) * (1 + c * 1.25 * (d2D / 100) ** 3 * Math.exp(-d2D / 150));
      sfLos = 4;
      sfNlos = 6;
    } else {
      pLos = hUT > 100 ? 1 : pLosAv(d2D, Math.max(460 * log10(hUT) - 700, 18), 4300 * log10(hUT) - 3800);
      plLos = 28 + 22 * log10(d3D) + 20 * log10(fc);
      plNlos = -17.5 + (46 - 7 * log10(hUT)) * log10(d3D) + fsc;
      plNlos = Math.max(plLos, plNlos);
      sfLos = 4.64 * Math.exp(-0.0066 * hUT);
      sfNlos = 6;
    }
  }
  pLos = clamp(pLos, 0, 1);
  return { model, pLos, plLos, plNlos, sfLos, sfNlos, d3D };
}

/** Mean of the LOS/NLOS mixture in the linear domain (used for neighbour-cell interference). */
export function gppMeanGain(r) {
  return r.pLos * Math.pow(10, -r.plLos / 10) + (1 - r.pLos) * Math.pow(10, -r.plNlos / 10);
}

/** Elevation angle (deg) of b as seen from a, both [x, y, z] with y up. */
export function elevation(a, b) {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  return Math.atan2(b[1] - a[1], Math.hypot(dx, dz)) / DEG;
}
