/*
 * User-defined drone profiles and flight profiles (waypoint plans):
 * validation, persistence in localStorage, compact URL encoding, JSON
 * exchange, and conversions (flown track or pattern → waypoints).
 * Everything that comes from outside (storage, URL, files) passes through
 * the sanitizers: numbers are clamped, strings trimmed, unknown keys dropped.
 */
import { DRONE_BY_ID, minTurnRadius, canHover } from './flight.js';
import { AIR_ANTENNA_IDS } from './rf/antennas.js';
import { clamp } from './util.js';

const KEY_DRONES = 'georfsim.drones';
const KEY_FLIGHTS = 'georfsim.flights';
const MAX_WAYPOINTS = 250;

export const DRONE_TYPES = [['multi', 'Multirotor'], ['fixed', 'Fixed wing'], ['vtol', 'VTOL']];
export const DRONE_MODELS = [
  ['quad', 'Quadcopter'], ['quadL', 'Large quadcopter'], ['fpv', 'FPV quad'], ['hexa', 'Hexacopter'], ['plane', 'Fixed wing'], ['vtol', 'VTOL'],
];
/** Editable numeric drone fields; `types` limits a field to some airframe types. */
export const DRONE_FIELDS = [
  { key: 'vCruise', label: 'Cruise speed', unit: 'm/s', min: 1, max: 80, step: 0.5 },
  { key: 'vMax', label: 'Max speed', unit: 'm/s', min: 2, max: 100, step: 0.5 },
  { key: 'vMin', label: 'Min (stall) speed', unit: 'm/s', min: 3, max: 40, step: 0.5, types: ['fixed'] },
  { key: 'climb', label: 'Climb rate', unit: 'm/s', min: 0.5, max: 40, step: 0.5 },
  { key: 'accel', label: 'Acceleration', unit: 'm/s²', min: 0.5, max: 30, step: 0.5 },
  { key: 'maxTilt', label: 'Max tilt', unit: '°', min: 5, max: 75, step: 1, types: ['multi', 'vtol'] },
  { key: 'maxBank', label: 'Max bank', unit: '°', min: 10, max: 70, step: 1, types: ['fixed', 'vtol'] },
  { key: 'span', label: 'Size (span)', unit: 'm', min: 0.1, max: 6, step: 0.05 },
];
export const END_MODES = [['loop', 'Loop'], ['reverse', 'Back & forth'], ['stop', 'Stop at end']];

const num = (v, lo, hi, d) => {
  const x = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(x) ? clamp(x, lo, hi) : d;
};
const str = (v, d, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);
const ID_RE = /^[up]_[a-z0-9_-]{1,40}$/i;

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

const store = {
  get(k) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
};

// ------------------------------------------------------------------ drones

export function sanitizeDrone(raw, fallbackId) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const type = DRONE_TYPES.some(([t]) => t === r.type) ? r.type : 'multi';
  const model = DRONE_MODELS.some(([m]) => m === r.model) ? r.model : type === 'fixed' ? 'plane' : type === 'vtol' ? 'vtol' : 'quad';
  const vMax = num(r.vMax, 2, 100, 20);
  const vMin = type === 'fixed' ? num(r.vMin, 3, vMax - 1, Math.min(10, vMax - 1)) : 0;
  const vCruise = num(r.vCruise, Math.max(vMin, 1), vMax, Math.max(vMin, Math.min(vMax, (vMin + vMax) / 2)));
  return {
    id: typeof r.id === 'string' && ID_RE.test(r.id) && r.id.startsWith('u_') ? r.id : fallbackId || newId('u_'),
    name: str(r.name, 'Custom drone'),
    type,
    model,
    vMin,
    vMax,
    vCruise,
    climb: num(r.climb, 0.5, 40, 5),
    accel: num(r.accel, 0.5, 30, type === 'fixed' ? 2.5 : 5),
    maxTilt: num(r.maxTilt, 5, 75, 30),
    maxBank: num(r.maxBank, 10, 70, 35),
    span: num(r.span, 0.1, 6, 0.5),
    airAnt: r.airAnt === 'auto' || AIR_ANTENNA_IDS.includes(r.airAnt) ? r.airAnt : 'auto',
    custom: true,
  };
}

export function customDrones() {
  return Object.values(DRONE_BY_ID).filter((d) => d.custom);
}

export function registerDrone(d) {
  DRONE_BY_ID[d.id] = d;
  return d;
}

export function unregisterDrone(id) {
  if (DRONE_BY_ID[id]?.custom) delete DRONE_BY_ID[id];
}

export function loadCustomDrones() {
  const list = store.get(KEY_DRONES);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 100).map((d) => registerDrone(sanitizeDrone(d)));
}

export function saveCustomDrones() {
  return store.set(KEY_DRONES, customDrones().map(({ custom, ...d }) => d));
}

/** Derived flight figures shown next to the drone editor. */
export function droneFigures(d) {
  const hover = canHover(d);
  const tiltAt = (v) => (hover ? (d.maxTilt || 30) * clamp(v / d.vMax, 0, 1) ** 2 : 0);
  return {
    turnCruise: minTurnRadius(d, d.vCruise),
    turnMax: minTurnRadius(d, d.vMax),
    tiltCruise: tiltAt(d.vCruise),
    stop: hover ? (d.vCruise * d.vCruise) / (2 * d.accel) : null,
    dopplerMax: (f) => (d.vMax * f) / 299792458,
    bankTurnRate: !hover || d.type === 'vtol' ? ((9.81 * Math.tan(((d.maxBank || 30) * Math.PI) / 180)) / d.vCruise) * (180 / Math.PI) : null,
  };
}

// ------------------------------------------------------------------ flight profiles

function sanitizeWaypoint(w) {
  if (!w || typeof w !== 'object') return null;
  const x = Number(w.x);
  const z = Number(w.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x: clamp(x, -5000, 5000),
    z: clamp(z, -5000, 5000),
    h: num(w.h, 1, 1000, 30),
    v: num(w.v, 0.5, 100, 8),
    hold: num(w.hold, 0, 600, 0),
  };
}

export function sanitizeProfile(raw, fallbackId) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const wps = Array.isArray(r.waypoints) ? r.waypoints.slice(0, MAX_WAYPOINTS).map(sanitizeWaypoint).filter(Boolean) : [];
  return {
    id: typeof r.id === 'string' && ID_RE.test(r.id) && r.id.startsWith('p_') ? r.id : fallbackId || newId('p_'),
    name: str(r.name, 'Flight profile'),
    scenario: typeof r.scenario === 'string' && /^[a-z0-9_-]{1,24}$/i.test(r.scenario) ? r.scenario : '',
    end: END_MODES.some(([m]) => m === r.end) ? r.end : 'loop',
    waypoints: wps,
  };
}

export function loadProfiles() {
  const list = store.get(KEY_FLIGHTS);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map((p) => sanitizeProfile(p));
}

export function saveProfiles(list) {
  return store.set(KEY_FLIGHTS, list);
}

/** Length (m), duration (s) and the steepest climb rate (m/s) a plan asks for. */
export function profileStats(p, drone) {
  const w = p.waypoints;
  const vEnv = (v) => clamp(v, drone.vMin || 0.5, drone.vMax);
  const legs = [];
  for (let i = 0; i + 1 < w.length; i++) legs.push([w[i], w[i + 1], w[i].v]);
  if (p.end === 'loop' && w.length > 2) legs.push([w[w.length - 1], w[0], w[w.length - 1].v]);
  if (p.end === 'reverse') for (let i = w.length - 1; i > 0; i--) legs.push([w[i], w[i - 1], w[i - 1].v]);
  let len = 0;
  let time = 0;
  let maxClimb = 0;
  for (const [a, b, v] of legs) {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const t = L / vEnv(v);
    len += L;
    time += t;
    if (t > 0) maxClimb = Math.max(maxClimb, Math.abs(b.h - a.h) / t);
  }
  const holds = w.reduce((s, x) => s + (x.hold || 0), 0) * (p.end === 'reverse' ? 2 : 1);
  return { len, time: time + (canHover(drone) ? holds : 0), maxClimb, legs: legs.length };
}

// ------------------------------------------------------------------ URL encoding

const clean = (s) => s.replace(/[~;,]/g, ' ');

export function encodeProfile(p) {
  const wps = p.waypoints.map((w) => [Math.round(w.x), Math.round(w.z), +w.h.toFixed(1), +w.v.toFixed(1), Math.round(w.hold)].join(',')).join(';');
  return [p.id, clean(p.name), p.end, p.scenario, wps].join('~');
}

export function decodeProfile(s) {
  if (typeof s !== 'string' || s.length > 20000) return null;
  const parts = s.split('~');
  if (parts.length !== 5) return null;
  const [id, name, end, scenario, wps] = parts;
  const waypoints = wps.split(';').filter(Boolean).map((t) => {
    const [x, z, h, v, hold] = t.split(',').map(Number);
    return { x, z, h, v, hold };
  });
  return sanitizeProfile({ id, name, end, scenario, waypoints });
}

const DRONE_KEYS = ['id', 'name', 'type', 'model', 'vMin', 'vMax', 'vCruise', 'climb', 'accel', 'maxTilt', 'maxBank', 'span', 'airAnt'];

export function encodeDrone(d) {
  return DRONE_KEYS.map((k) => (typeof d[k] === 'number' ? +d[k].toFixed(2) : clean(String(d[k])))).join('~');
}

export function decodeDrone(s) {
  if (typeof s !== 'string' || s.length > 500) return null;
  const parts = s.split('~');
  if (parts.length !== DRONE_KEYS.length) return null;
  return sanitizeDrone(Object.fromEntries(DRONE_KEYS.map((k, i) => [k, i > 3 && k !== 'airAnt' ? Number(parts[i]) : parts[i]])));
}

// ------------------------------------------------------------------ JSON files

export function exportJson(kind, items) {
  return JSON.stringify({ georfsim: kind, version: 1, items }, null, 2);
}

/** Accepts our export format, a bare array or a single object. */
export function importJson(text, kind) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  let items = data;
  if (data && !Array.isArray(data) && Array.isArray(data.items)) {
    if (data.georfsim && data.georfsim !== kind) throw new Error(`this file holds ${data.georfsim}, not ${kind}`);
    items = data.items;
  }
  if (!Array.isArray(items)) items = [items];
  const clean = items.slice(0, 200).map((x) => (kind === 'drones' ? sanitizeDrone(x, newId('u_')) : sanitizeProfile(x, newId('p_'))));
  if (kind === 'flights' && !clean.some((p) => p.waypoints.length)) throw new Error('no waypoints found');
  return clean;
}

// ------------------------------------------------------------------ conversions

/** Douglas-Peucker on [x, z, h] points; heights weigh double (they matter for the link). */
function simplify(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a];
    const B = pts[b];
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const dh = (B.h - A.h) * 2;
    const L2 = dx * dx + dz * dz + dh * dh || 1;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const t = clamp(((P.x - A.x) * dx + (P.z - A.z) * dz + (P.h - A.h) * 2 * dh) / L2, 0, 1);
      const d = Math.hypot(P.x - (A.x + dx * t), P.z - (A.z + dz * t), (P.h - A.h) * 2 - dh * t);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function toWaypoints(pts, tol) {
  let t = tol;
  let kept = simplify(pts, t);
  while (kept.length > 120) {
    t *= 1.6;
    kept = simplify(pts, t);
  }
  return kept;
}

/** Turns the part of the flown track between t0 and meta.t1 (default: the end) into a flight profile. */
export function profileFromTrack(track, t0, meta = {}) {
  const t1 = meta.t1 ?? Infinity;
  const pts = [];
  for (let i = 0; i < track.n; i++) if (track.t[i] >= t0 && track.t[i] <= t1) pts.push({ x: track.x[i], z: track.z[i], h: track.agl[i], t: track.t[i] });
  if (pts.length < 2) return null;
  const kept = toWaypoints(pts, 5);
  const waypoints = kept.map((p, k) => {
    const q = kept[k + 1] || kept[k - 1];
    const dt = Math.abs((q.t - p.t) || 1);
    const v = Math.hypot(q.x - p.x, q.z - p.z) / dt;
    return { x: Math.round(p.x), z: Math.round(p.z), h: Math.max(1, Math.round(p.h)), v: +clamp(v, 0.5, 100).toFixed(1), hold: 0 };
  });
  return sanitizeProfile({ name: meta.name || 'Recorded flight', scenario: meta.scenario, end: 'stop', waypoints });
}

/** Turns a built pattern path into an editable flight profile. */
export function profileFromPath(path, meta = {}) {
  const pts = [];
  for (let i = 0; i < path.x.length; i++) pts.push({ x: path.x[i], z: path.z[i], h: path.agl[i] });
  const speedAt = (k) => (path.speed ? path.speed[k] : meta.speed || 8);
  let waypoints;
  if (path.len <= 0) waypoints = [{ x: pts[0].x, z: pts[0].z, h: pts[0].h, v: meta.speed || 8, hold: 0 }];
  else {
    // keep the index to read the leg speed
    pts.forEach((p, i) => {
      p.i = i;
    });
    const kept = toWaypoints(pts, 3);
    if (!path.open && kept.length > 2) kept.pop(); // a closed pattern ends where it starts
    waypoints = kept.map((p) => ({ x: Math.round(p.x), z: Math.round(p.z), h: Math.max(1, Math.round(p.h)), v: +speedAt(p.i).toFixed(1), hold: 0 }));
  }
  return sanitizeProfile({ name: meta.name || 'Pattern', scenario: meta.scenario, end: path.open ? 'stop' : 'loop', waypoints });
}
