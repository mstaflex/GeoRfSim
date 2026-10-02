/*
 * Antenna patterns and polarisation. Patterns are evaluated in the antenna's
 * local frame: x = boresight, y = up (dipole axis), z = right. Directional
 * patterns use the 3GPP TR 38.901 parabolic cuts (A = −min(12(φ/φ3dB)², Am)).
 */
import { DEG, clamp } from '../util.js';

export const ANTENNAS = {
  // --------------------------------------------------------------- ground side
  dipole: { name: '½λ dipole (vertical)', kind: 'dipole', g: 2.15, pol: 'V', side: 'ground' },
  collinear: { name: 'Collinear omni 6 dBi', kind: 'omni', g: 6, bwEl: 26, sla: 22, pol: 'V', side: 'ground' },
  patch: { name: 'Patch panel 8 dBi', kind: 'dir', g: 8, bwAz: 65, bwEl: 65, sla: 25, am: 25, pol: 'V', side: 'ground' },
  helix: { name: 'Helical 14 dBi (RHCP)', kind: 'dir', g: 14, bwAz: 32, bwEl: 32, sla: 18, am: 22, pol: 'CP', side: 'ground' },
  tracker: { name: 'Tracking helix 14 dBi', kind: 'dir', g: 14, bwAz: 32, bwEl: 32, sla: 18, am: 22, pol: 'CP', side: 'ground', tracking: true },
  sector: { name: 'Sector panels 17 dBi (3×, 6° tilt)', kind: 'dir', g: 17, bwAz: 65, bwEl: 7, sla: 20, am: 30, pol: 'X', side: 'infra', tilt: -6, sectors: 3 },
  mmimo: {
    name: 'Massive MIMO 24 dBi (3×)', kind: 'steer', g: 24, bw: 12, scanAz: 55, scanEl: [-20, 8], sla: 18,
    pol: 'X', side: 'infra', tilt: -3, sectors: 3,
  },
  mmarray: {
    name: 'mmWave array 26 dBi (3×)', kind: 'steer', g: 26, bw: 8, scanAz: 60, scanEl: [-35, 15], sla: 18,
    pol: 'X', side: 'infra', tilt: -6, sectors: 3, narrowBeam: true,
  },
  // --------------------------------------------------------------- airborne
  dipole_v: { name: 'Vertical dipole', kind: 'dipole', g: 2.15, pol: 'V', side: 'air', mounts: ['up'] },
  dual_space: { name: '2 dipoles · space diversity', kind: 'dipole', g: 2.15, pol: 'V', side: 'air', mounts: ['up', 'up'] },
  dual_vh: { name: '2 dipoles V+H · pol. diversity', kind: 'dipole', g: 2.15, pol: 'V', side: 'air', mounts: ['up', 'side'] },
  cp_omni: { name: 'CP omni (pagoda, RHCP)', kind: 'omni', g: 1.5, bwEl: 110, sla: 10, pol: 'CP', side: 'air', mounts: ['up'] },
  belly_patch: { name: 'Belly patch (RHCP, down)', kind: 'dir', g: 7, bwAz: 75, bwEl: 75, sla: 20, am: 22, pol: 'CP', side: 'air', mounts: ['down'] },
  internal: { name: 'Internal PCB antenna', kind: 'dipole', g: -1, ripple: 4, pol: 'V', side: 'air', mounts: ['up'] },
  ue_array: {
    name: 'mmWave UE array 10 dBi', kind: 'steer', g: 10, bw: 30, scanAz: 75, scanEl: [-75, 75], sla: 12,
    pol: 'X', side: 'air', mounts: ['down'], narrowBeam: true,
  },
};

export const GROUND_ANTENNA_IDS = ['dipole', 'collinear', 'patch', 'helix', 'tracker'];
export const AIR_ANTENNA_IDS = ['dipole_v', 'dual_space', 'dual_vh', 'cp_omni', 'belly_patch', 'internal', 'ue_array'];

// ----------------------------------------------------------------- vectors

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Local axes (in world coordinates) of an antenna pointing at azimuth az (deg, x→z) with tilt (deg, up +). */
export function axesFromAzTilt(azDeg, tiltDeg) {
  const az = azDeg * DEG;
  const t = tiltDeg * DEG;
  const X = [Math.cos(t) * Math.cos(az), Math.sin(t), Math.cos(t) * Math.sin(az)];
  const Y = [-Math.sin(t) * Math.cos(az), Math.cos(t), -Math.sin(t) * Math.sin(az)];
  return { X, Y, Z: cross(X, Y) };
}

/** Local axes of a mount position expressed in the airframe's body frame (x fwd, y up, z right). */
const MOUNTS = {
  up: { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] },
  down: { X: [0, -1, 0], Y: [1, 0, 0], Z: [0, 0, 1] },
  side: { X: [1, 0, 0], Y: [0, 0, 1], Z: [0, -1, 0] },
};

/** Transforms a mount's body-frame axes into world axes given body axes {X: fwd, Y: up, Z: right}. */
export function mountAxes(mount, body) {
  const m = MOUNTS[mount] || MOUNTS.up;
  const tr = (v) => [
    v[0] * body.X[0] + v[1] * body.Y[0] + v[2] * body.Z[0],
    v[0] * body.X[1] + v[1] * body.Y[1] + v[2] * body.Z[1],
    v[0] * body.X[2] + v[1] * body.Y[2] + v[2] * body.Z[2],
  ];
  return { X: tr(m.X), Y: tr(m.Y), Z: tr(m.Z) };
}

// ----------------------------------------------------------------- patterns

/** Gain (dBi) towards the unit direction (lx, ly, lz) given in the antenna's local frame. */
export function gainLocal(ant, lx, ly, lz) {
  switch (ant.kind) {
    case 'dipole': {
      const c = clamp(ly, -1, 1);
      const s = Math.sqrt(1 - c * c);
      let g = s < 1e-6 ? -60 : ant.g + 20 * Math.log10(Math.max(Math.abs(Math.cos((Math.PI / 2) * c) / s), 1e-3));
      if (ant.ripple) g += ant.ripple * Math.cos(2 * Math.atan2(lz, lx) + 0.7) * s;
      return Math.max(g, ant.g - 25);
    }
    case 'omni': {
      const el = Math.asin(clamp(ly, -1, 1)) / DEG;
      return ant.g - Math.min(12 * (el / ant.bwEl) ** 2, ant.sla);
    }
    case 'dir': {
      const el = Math.asin(clamp(ly, -1, 1)) / DEG;
      const az = Math.atan2(lz, lx) / DEG;
      const aH = Math.min(12 * (az / ant.bwAz) ** 2, ant.am);
      const aV = Math.min(12 * (el / ant.bwEl) ** 2, ant.sla);
      return ant.g - Math.min(aH + aV, ant.am);
    }
    case 'steer': {
      // Beam steered to the closest direction inside the scan range; element roll-off cos^1.3.
      const el = Math.asin(clamp(ly, -1, 1));
      const az = Math.atan2(lz, lx);
      const azc = clamp(az, -ant.scanAz * DEG, ant.scanAz * DEG);
      const elc = clamp(el, ant.scanEl[0] * DEG, ant.scanEl[1] * DEG);
      const sx = Math.cos(elc) * Math.cos(azc);
      const sy = Math.sin(elc);
      const sz = Math.cos(elc) * Math.sin(azc);
      const scanLoss = -13 * Math.log10(Math.max(sx, 0.05));
      const off = Math.acos(clamp(sx * lx + sy * ly + sz * lz, -1, 1)) / DEG;
      return ant.g - scanLoss - Math.min(12 * (off / ant.bw) ** 2, ant.sla);
    }
    default:
      return 0;
  }
}

/** Gain towards world direction d for an antenna with world axes {X, Y, Z}. */
export function gainWorld(ant, axes, d) {
  return gainLocal(ant, dot(d, axes.X), dot(d, axes.Y), dot(d, axes.Z));
}

/** Best sector gain of a multi-sector site (sector azimuths az0 + k·360/n). */
export function sectorGain(ant, az0, d) {
  const n = ant.sectors || 1;
  let best = -Infinity;
  let bestAz = az0;
  for (let k = 0; k < n; k++) {
    const az = az0 + (k * 360) / n;
    const g = gainWorld(ant, axesFromAzTilt(az, ant.tilt || 0), d);
    if (g > best) {
      best = g;
      bestAz = az;
    }
  }
  return { g: best, az: bestAz };
}

// ----------------------------------------------------------------- polarisation

/** Polarisation descriptor of an antenna with world axes: linear vector, 'CP' or 'X' (dual-slant). */
export function polOf(ant, axes) {
  if (ant.pol === 'CP') return { type: 'CP' };
  if (ant.pol === 'X') return { type: 'X' };
  return { type: 'lin', v: ant.pol === 'H' ? axes.Z : axes.Y };
}

/** Polarisation mismatch loss in dB for propagation direction k; cross-pol discrimination capped at 20 dB. */
export function polLoss(pa, pb, k) {
  if (pa.type === 'X' || pb.type === 'X') return 0;
  if (pa.type === 'CP' && pb.type === 'CP') return 0;
  if (pa.type === 'CP' || pb.type === 'CP') return 3.01;
  const ka = dot(pa.v, k);
  const kb = dot(pb.v, k);
  const ea = [pa.v[0] - ka * k[0], pa.v[1] - ka * k[1], pa.v[2] - ka * k[2]];
  const eb = [pb.v[0] - kb * k[0], pb.v[1] - kb * k[1], pb.v[2] - kb * k[2]];
  const na = dot(ea, ea);
  const nb = dot(eb, eb);
  if (na < 1e-6 || nb < 1e-6) return 0;
  const plf = dot(ea, eb) ** 2 / (na * nb);
  return -10 * Math.log10(Math.max(plf, 0.01));
}

/** Which Fresnel coefficient governs the ground bounce for this antenna pair. */
export function reflectionPol(pa, pb) {
  if (pa.type === 'CP' && pb.type === 'CP') return 'CP';
  const lin = pa.type === 'lin' ? pa : pb.type === 'lin' ? pb : null;
  if (!lin) return 'V';
  return Math.abs(lin.v[1]) >= Math.hypot(lin.v[0], lin.v[2]) ? 'V' : 'H';
}

// ----------------------------------------------------------------- airborne helpers

/** Branch descriptors of an airborne antenna: [{mount}] (two entries for diversity antennas). */
export function branchesOf(ant) {
  return (ant.mounts || ['up']).map((mount, i) => ({ mount, index: i }));
}

/** Max-over-branches gain of an airborne antenna for a body-frame direction (used for lobes & plots). */
export function airGainBody(ant, d) {
  let best = -Infinity;
  for (const b of branchesOf(ant)) {
    const m = MOUNTS[b.mount] || MOUNTS.up;
    const g = gainLocal(ant, dot(d, m.X), dot(d, m.Y), dot(d, m.Z));
    if (g > best) best = g;
  }
  return best;
}

/** Peak gain used to normalise lobe plots. */
export function peakGain(ant) {
  return ant.g;
}
