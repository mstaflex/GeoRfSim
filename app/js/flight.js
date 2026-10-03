/*
 * Drone profiles, flight patterns and kinematics. A pattern becomes a closed
 * path resampled every PATH_DS metres with a desired height above ground; an
 * optional obstacle pass lifts the height over buildings and tree crowns
 * (respecting the climb rate). With the barometric height reference the
 * commanded heights are altitudes above the take-off point instead, and the
 * drone only rises where the ground closes in. Attitude follows simple flight mechanics:
 * multirotors pitch into the wind of their own speed and bank in turns,
 * fixed-wings bank with tan φ = v²κ/g.
 */
import { clamp, DEG, TAU } from './util.js';

export const G = 9.81;
const PATH_DS = 2;

export const DRONES = [
  { id: 'mini', name: 'Mini quad (<250 g)', type: 'multi', vMax: 16, vCruise: 8, climb: 4, accel: 5, maxTilt: 30, span: 0.25, model: 'quad', airAnt: 'auto' },
  { id: 'prosumer', name: 'Prosumer quad (Mavic class)', type: 'multi', vMax: 21, vCruise: 12, climb: 6, accel: 6, maxTilt: 35, span: 0.38, model: 'quad', airAnt: 'auto' },
  { id: 'enterprise', name: 'Enterprise quad (M350 class)', type: 'multi', vMax: 23, vCruise: 10, climb: 6, accel: 5, maxTilt: 30, span: 0.9, model: 'quadL', airAnt: 'auto' },
  { id: 'fpv', name: 'FPV racer (5-inch)', type: 'multi', vMax: 40, vCruise: 22, climb: 20, accel: 15, maxTilt: 60, span: 0.22, model: 'fpv', airAnt: 'auto' },
  { id: 'heavy', name: 'Heavy-lift hexa (agri)', type: 'multi', vMax: 10, vCruise: 6, climb: 3, accel: 3, maxTilt: 20, span: 1.8, model: 'hexa', airAnt: 'auto' },
  { id: 'fixedwing', name: 'Fixed-wing mapper', type: 'fixed', vMin: 11, vMax: 25, vCruise: 16, climb: 4, accel: 2.5, maxBank: 35, span: 1.2, model: 'plane', airAnt: 'auto' },
  { id: 'vtol', name: 'VTOL long-range', type: 'vtol', vMin: 0, vMax: 30, vCruise: 22, climb: 4, accel: 3, maxBank: 30, maxTilt: 15, span: 2.4, model: 'vtol', airAnt: 'auto' },
];
export const DRONE_BY_ID = Object.fromEntries(DRONES.map((d) => [d.id, d]));

export const PATTERNS = [
  { id: 'hover', name: 'Hover', size: null },
  { id: 'line', name: 'Out & back (range test)', size: 'Length' },
  { id: 'orbit', name: 'Orbit', size: 'Diameter' },
  { id: 'figure8', name: 'Figure 8', size: 'Width' },
  { id: 'survey', name: 'Survey (lawnmower)', size: 'Area side' },
  { id: 'climb', name: 'Vertical profile', size: null },
  { id: 'spiral', name: 'Spiral climb', size: 'Diameter' },
  { id: 'route', name: 'Scenario route', size: null },
];
/** Waypoint flight plans (flight profiles) fly as pattern 'custom'. */
export const CUSTOM_PATTERN = { id: 'custom', name: 'Flight profile', size: null };
export const PATTERN_BY_ID = Object.fromEntries([...PATTERNS, CUSTOM_PATTERN].map((p) => [p.id, p]));

/** Smallest turn radius the airframe flies at speed v. */
export function minTurnRadius(drone, v) {
  if (drone.type === 'multi' || (drone.type === 'vtol' && v < 10)) return Math.max(2, (v * v) / (G * Math.tan(drone.maxTilt * DEG)) * 0.5);
  return (v * v) / (G * Math.tan(drone.maxBank * DEG));
}

/** True when the airframe can hold position. */
export const canHover = (drone) => drone.type !== 'fixed';

// ----------------------------------------------------------------- path building

/**
 * Rounds polyline corners with arcs of radius r (shrunk where segments are short) and samples it.
 * A point may carry its own corner radius as third element ([x, z, r]); 0 keeps a sharp corner.
 */
function filletPolyline(input, r, closed) {
  const out = [];
  const pts = input.filter((p, k) => k === 0 || dist(p, input[k - 1]) > 0.5);
  const n = pts.length;
  const P = closed && dist(pts[0], pts[n - 1]) < 1e-6 ? pts.slice(0, -1) : pts.slice();
  const m = P.length;
  const corner = [];
  for (let k = 0; k < m; k++) {
    const hasPrev = closed || k > 0;
    const hasNext = closed || k < m - 1;
    if (!hasPrev || !hasNext) {
      corner.push(null);
      continue;
    }
    const A = P[(k - 1 + m) % m];
    const B = P[k];
    const C = P[(k + 1) % m];
    const ux = B[0] - A[0];
    const uz = B[1] - A[1];
    const vx = C[0] - B[0];
    const vz = C[1] - B[1];
    const lu = Math.hypot(ux, uz);
    const lv = Math.hypot(vx, vz);
    if (lu < 1e-6 || lv < 1e-6) {
      corner.push(null);
      continue;
    }
    const cosA = clamp((ux * vx + uz * vz) / (lu * lv), -1, 1);
    const phi = Math.acos(cosA);
    if (phi < 0.02) {
      corner.push(null);
      continue;
    }
    const rk = B[2] ?? r;
    if (rk <= 0) {
      corner.push(null);
      continue;
    }
    // never cut a corner by more than twice the turn radius (hairpins turn near the vertex)
    let t = rk * Math.tan(phi / 2);
    t = Math.min(t, 2 * rk, 0.48 * lu, 0.48 * lv);
    const rr = t / Math.tan(phi / 2);
    const p0 = [B[0] - (ux / lu) * t, B[1] - (uz / lu) * t];
    const p1 = [B[0] + (vx / lv) * t, B[1] + (vz / lv) * t];
    const turn = Math.sign(ux * vz - uz * vx);
    const nx = (-uz / lu) * turn;
    const nz = (ux / lu) * turn;
    corner.push({ p0, p1, c: [p0[0] + nx * rr, p0[1] + nz * rr], r: rr, turn, phi });
  }
  const pushLine = (a, b) => {
    const L = dist(a, b);
    const steps = Math.max(1, Math.ceil(L / PATH_DS));
    for (let s = out.length ? 1 : 0; s <= steps; s++) out.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
  };
  const pushArc = (cn) => {
    const a0 = Math.atan2(cn.p0[1] - cn.c[1], cn.p0[0] - cn.c[0]);
    const sweep = cn.phi * cn.turn;
    const steps = Math.max(2, Math.ceil((cn.r * cn.phi) / PATH_DS));
    for (let s = 1; s <= steps; s++) {
      const a = a0 + (sweep * s) / steps;
      out.push([cn.c[0] + Math.cos(a) * cn.r, cn.c[1] + Math.sin(a) * cn.r]);
    }
  };
  const start = (k) => (corner[k] ? corner[k].p1 : P[k]);
  const end = (k) => (corner[k] ? corner[k].p0 : P[k]);
  if (corner[0] && closed) out.push(corner[0].p1);
  else out.push(P[0]);
  const last = closed ? m : m - 1;
  for (let k = 0; k < last; k++) {
    const nk = (k + 1) % m;
    pushLine(out[out.length - 1] || start(k), end(nk));
    if (corner[nk] && (closed || nk < m - 1)) pushArc(corner[nk]);
  }
  return out;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function circle(cx, cz, r, a0 = 0, dir = 1) {
  const n = Math.max(24, Math.ceil((TAU * r) / PATH_DS));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (dir * TAU * k) / n;
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return pts;
}

/** Stadium (racetrack): out along `dir` for `len`, U-turn of radius r, back. */
function stadium(sx, sz, dirA, len, r) {
  const ux = Math.cos(dirA);
  const uz = Math.sin(dirA);
  const nx = -uz;
  const nz = ux;
  const pts = [];
  const a = [sx + nx * r, sz + nz * r];
  const b = [sx + ux * len + nx * r, sz + uz * len + nz * r];
  const nLine = Math.max(1, Math.ceil(len / PATH_DS));
  for (let k = 0; k <= nLine; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / nLine, a[1] + ((b[1] - a[1]) * k) / nLine]);
  const cEnd = [sx + ux * len, sz + uz * len];
  const nArc = Math.max(8, Math.ceil((Math.PI * r) / PATH_DS));
  const aStart = Math.atan2(nz, nx);
  for (let k = 1; k <= nArc; k++) {
    const ang = aStart - (Math.PI * k) / nArc;
    pts.push([cEnd[0] + Math.cos(ang) * r, cEnd[1] + Math.sin(ang) * r]);
  }
  const c = [sx + ux * len - nx * r, sz + uz * len - nz * r];
  const d = [sx - nx * r, sz - nz * r];
  for (let k = 1; k <= nLine; k++) pts.push([c[0] + ((d[0] - c[0]) * k) / nLine, c[1] + ((d[1] - c[1]) * k) / nLine]);
  const aS2 = Math.atan2(-nz, -nx);
  for (let k = 1; k <= nArc; k++) {
    const ang = aS2 - (Math.PI * k) / nArc;
    pts.push([sx + Math.cos(ang) * r, sz + Math.sin(ang) * r]);
  }
  return pts;
}

/**
 * Builds the flight path.
 * cfg: { pattern, center:[x,z], size, heading (deg), height, speed, avoid }
 * Returns { x, z, agl, s, curv, len, vertical, hover }.
 */
export function buildPath(world, drone, cfg) {
  const v = Math.max(cfg.speed, 0.5);
  const rTurn = minTurnRadius(drone, v);
  const [cx, cz] = cfg.center;
  const h = cfg.height;
  const head = (cfg.heading || 0) * DEG;
  let pts;
  let agl = null;
  let vertical = false;
  let hover = false;
  const pattern = cfg.pattern;
  if (pattern === 'custom') return buildProfilePath(world, drone, cfg);

  if (pattern === 'hover' && canHover(drone)) {
    hover = true;
    pts = [[cx, cz], [cx, cz]];
  } else if (pattern === 'hover') {
    // fixed-wing cannot hover: loiter on the tightest comfortable circle
    pts = circle(cx, cz, Math.max(rTurn * 1.15, 25));
  } else if (pattern === 'climb' && canHover(drone)) {
    vertical = true;
    pts = [[cx, cz], [cx, cz]];
  } else if (pattern === 'spiral' || pattern === 'climb') {
    const r = pattern === 'climb' ? Math.max(rTurn * 1.15, 25) : Math.max(cfg.size / 2, rTurn * 1.05, 10);
    const ring = circle(cx, cz, r);
    const perTurn = Math.max(1, (drone.climb * 0.8 * TAU * r) / v);
    const turns = Math.max(2, Math.ceil((h - 10) / perTurn));
    pts = [];
    for (let t = 0; t < turns * 2; t++) for (let k = t === 0 ? 0 : 1; k < ring.length; k++) pts.push(ring[k]);
    agl = new Float64Array(pts.length);
    for (let k = 0; k < pts.length; k++) {
      const f = k / (pts.length - 1);
      agl[k] = 10 + (h - 10) * (f < 0.5 ? f * 2 : (1 - f) * 2);
    }
  } else if (pattern === 'line') {
    const p = world.pilot;
    const a = Math.atan2(cz - p.z, cx - p.x);
    const sx = p.x + Math.cos(a) * 25;
    const sz = p.z + Math.sin(a) * 25;
    const r = drone.type === 'multi' ? Math.max(rTurn, 3) : Math.max(rTurn * 1.1, 15);
    pts = stadium(sx, sz, a, Math.max(cfg.size, 50), r);
  } else if (pattern === 'orbit') {
    pts = circle(cx, cz, Math.max(cfg.size / 2, rTurn * 1.05, 5));
  } else if (pattern === 'figure8') {
    const a = Math.max(cfg.size / 2, rTurn * 3);
    const n = Math.ceil((a * 7) / PATH_DS);
    pts = [];
    const ca = Math.cos(head);
    const sa = Math.sin(head);
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * TAU;
      const u = a * Math.sin(t);
      const w = a * Math.sin(t) * Math.cos(t);
      pts.push([cx + u * ca - w * sa, cz + u * sa + w * ca]);
    }
  } else if (pattern === 'survey') {
    const side = Math.max(cfg.size, 60);
    const lanes = Math.max(2, Math.round(side / Math.max(side / 6, 2.2 * rTurn)));
    const sp = side / lanes;
    const ca = Math.cos(head);
    const sa = Math.sin(head);
    const loc = (u, w) => [cx + u * ca - w * sa, cz + u * sa + w * ca];
    const wp = [];
    for (let l = 0; l <= lanes; l++) {
      const w = -side / 2 + l * sp;
      const u0 = l % 2 === 0 ? -side / 2 : side / 2;
      wp.push(loc(u0, w), loc(-u0, w));
    }
    // return leg along the outside edge
    const lastU = lanes % 2 === 0 ? side / 2 : -side / 2;
    wp.push(loc(lastU + (lastU > 0 ? sp : -sp), side / 2 + sp), loc(-side / 2 - sp, side / 2 + sp), loc(-side / 2 - sp, -side / 2 - sp * 0.5));
    wp.push(wp[0]);
    pts = filletPolyline(wp, Math.max(sp / 2, rTurn), true);
  } else {
    // scenario route
    const r = drone.type === 'multi' ? Math.max(rTurn, 6) : Math.max(rTurn, 20);
    pts = filletPolyline(world.route, r, true);
  }

  // resample uniformly
  const path = resample(pts, agl, h);
  path.vertical = vertical;
  path.hover = hover;
  if (vertical) {
    // vertical profile: param s runs over height 2 m → h → 2 m
    const top = Math.max(h, 5);
    const n = Math.max(4, Math.ceil(((top - 2) * 2) / PATH_DS));
    path.x = new Float64Array(n + 1).fill(cx);
    path.z = new Float64Array(n + 1).fill(cz);
    path.agl = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      path.agl[k] = 2 + (top - 2) * (f < 0.5 ? f * 2 : (1 - f) * 2);
    }
    path.curv = new Float64Array(n + 1);
    path.len = (top - 2) * 2;
    path.ds = path.len / n;
  }
  applyHeightReference(world, drone, path, cfg, v);
  return path;
}

/**
 * Waypoint flight plan → path. Each waypoint carries a height above ground (h),
 * the speed of the leg that starts there (v) and an optional hold (s). End
 * behaviour: 'loop' closes back to the first waypoint, 'reverse' flies the
 * plan back and forth, 'stop' ends at the last waypoint (hover; fixed wings
 * loop instead). Corners are rounded with the turn radius the airframe needs
 * at the local speed; multirotors stop sharp at hold points.
 */
function buildProfilePath(world, drone, cfg) {
  const prof = cfg.profile;
  const wps = (prof && prof.waypoints) || [];
  const hover = canHover(drone);
  const vEnv = (v) => clamp(v, drone.vMin || 0.5, drone.vMax);
  if (wps.length < 2) {
    const w = wps[0] || { x: cfg.center[0], z: cfg.center[1], h: cfg.height, v: cfg.speed };
    const pts = hover ? [[w.x, w.z], [w.x, w.z]] : circle(w.x, w.z, Math.max(minTurnRadius(drone, vEnv(w.v)) * 1.15, 25));
    const path = resample(pts, null, w.h, pts.map(() => vEnv(w.v)));
    path.hover = hover;
    path.vertical = false;
    path.holds = [];
    applyHeightReference(world, drone, path, cfg, vEnv(w.v));
    return path;
  }
  let verts = wps.map((w, i) => ({ ...w, hold: hover ? w.hold || 0 : 0, idx: i }));
  let closed = true;
  if (prof.end === 'reverse') {
    // back the same way: each leg keeps the speed it had on the way out
    const m = verts.length;
    verts[m - 1] = { ...verts[m - 1], v: wps[m - 2].v };
    for (let k = m - 2; k >= 1; k--) verts.push({ ...wps[k], hold: hover ? wps[k].hold || 0 : 0, idx: k, v: wps[k - 1].v });
  } else if (prof.end === 'stop' && hover) closed = false;
  const n = verts.length;
  const legV = (k) => vEnv(verts[((k % n) + n) % n].v);
  // a multirotor flies a hairpin (> 150°) like a real one: stop on the waypoint, turn, go back
  const turnBack = verts.map((w, k) => {
    if (!hover || (!closed && (k === 0 || k === n - 1))) return false;
    const a = verts[(k - 1 + n) % n];
    const b = verts[(k + 1) % n];
    const ux = w.x - a.x;
    const uz = w.z - a.z;
    const vx = b.x - w.x;
    const vz = b.z - w.z;
    const l = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    return l > 0 && (ux * vx + uz * vz) / l < Math.cos((150 * Math.PI) / 180);
  });
  const corner = verts.map((w, k) => {
    if (w.hold > 0 || turnBack[k]) return 0;
    const v = Math.max(legV(k - 1), legV(k));
    return Math.max(minTurnRadius(drone, v), hover ? 3 : 15);
  });
  const poly = verts.map((w, k) => [w.x, w.z, corner[k]]);
  if (closed) poly.push([verts[0].x, verts[0].z, corner[0]]);
  const pts = filletPolyline(poly, 0, closed);

  // carry height and leg speed along the rounded polyline by projecting onto the original legs;
  // the arc length where a leg begins is where the drone passes its waypoint (holds stop there)
  const segs = closed ? n : n - 1;
  const aglArr = new Float64Array(pts.length);
  const spdArr = new Float64Array(pts.length);
  const legStart = new Float64Array(n).fill(-1);
  legStart[0] = 0;
  let seg = 0;
  let cum = 0;
  const project = (p, k) => {
    const a = verts[k % n];
    const b = verts[(k + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = clamp(((p[0] - a.x) * dx + (p[1] - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return { t, d: Math.hypot(p[0] - (a.x + dx * t), p[1] - (a.z + dz * t)) };
  };
  for (let i = 0; i < pts.length; i++) {
    if (i) cum += dist(pts[i - 1], pts[i]);
    let best = project(pts[i], seg);
    // legs only advance; look a few ahead so very short legs are not skipped
    for (let k = seg + 1; k < Math.min(seg + 4, segs); k++) {
      const c = project(pts[i], k);
      if (c.d < best.d - 1e-6 || (c.d <= best.d + 1e-6 && best.t > 0.999)) {
        best = c;
        for (let j = seg + 1; j <= k; j++) if (legStart[j] < 0) legStart[j] = cum;
        seg = k;
      }
    }
    const a = verts[seg % n];
    const b = verts[(seg + 1) % n];
    aglArr[i] = a.h + (b.h - a.h) * best.t;
    spdArr[i] = legV(seg);
  }
  const path = resample(pts, aglArr, cfg.height, spdArr);
  path.vertical = false;
  path.hover = false;
  path.open = !closed;
  path.holds = [];
  // holds, and zero-length stops where a multirotor turns back
  for (let k = 0; k < n; k++) {
    if ((verts[k].hold > 0 || turnBack[k]) && legStart[k] >= 0) path.holds.push({ s: Math.min(legStart[k], path.len), t: verts[k].hold, wp: verts[k].idx });
  }
  // an open plan ends at its last waypoint: hold there for good
  if (!closed && verts[n - 1].hold > 0) path.holds.push({ s: path.len, t: verts[n - 1].hold, wp: verts[n - 1].idx });
  path.holds.sort((a, b) => a.s - b.s);
  applyHeightReference(world, drone, path, cfg, cfg.speed);
  return path;
}

function resample(pts, agl, h, spd = null) {
  const n = pts.length;
  const cum = new Float64Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + dist(pts[k - 1], pts[k]);
  const len = cum[n - 1];
  if (len < 1e-3) {
    return {
      x: Float64Array.of(pts[0][0], pts[0][0]),
      z: Float64Array.of(pts[0][1], pts[0][1]),
      agl: Float64Array.of(agl ? agl[0] : h, agl ? agl[0] : h),
      speed: spd ? Float64Array.of(spd[0], spd[0]) : null,
      curv: new Float64Array(2),
      len: 0,
      ds: 1,
    };
  }
  const m = Math.max(2, Math.ceil(len / PATH_DS) + 1);
  const ds = len / (m - 1);
  const x = new Float64Array(m);
  const z = new Float64Array(m);
  const a = new Float64Array(m);
  const v = spd ? new Float64Array(m) : null;
  let k = 0;
  for (let i = 0; i < m; i++) {
    const s = i * ds;
    while (k < n - 2 && cum[k + 1] < s) k++;
    const seg = cum[k + 1] - cum[k] || 1;
    const t = clamp((s - cum[k]) / seg, 0, 1);
    x[i] = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t;
    z[i] = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t;
    a[i] = agl ? agl[k] + (agl[k + 1] - agl[k]) * t : h;
    if (v) v[i] = t < 0.5 ? spd[k] : spd[k + 1];
  }
  // signed curvature from heading change (positive = right turn on the map)
  const curv = new Float64Array(m);
  for (let i = 1; i < m - 1; i++) {
    const h0 = Math.atan2(z[i] - z[i - 1], x[i] - x[i - 1]);
    const h1 = Math.atan2(z[i + 1] - z[i], x[i + 1] - x[i]);
    let d = h1 - h0;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    curv[i] = d / ds;
  }
  // smooth curvature a little (fillet joins are discontinuous)
  const c2 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    let c = 0;
    for (let d = -2; d <= 2; d++) {
      const j = i + d;
      if (j < 0 || j >= m) continue;
      s += curv[j];
      c++;
    }
    c2[i] = s / c;
  }
  return { x, z, agl: a, speed: v, curv: c2, len, ds };
}

/**
 * Height reference of the commanded heights (path.agl on entry):
 *   'agl'  - above the ground below the drone (terrain following); avoidance
 *            lifts the path over roofs and tree crowns.
 *   'baro' - altitudes above the take-off point (the pilot's ground), held like
 *            a barometric altimeter does. The drone only rises where the ground
 *            (with avoidance also a roof or tree crown) comes closer than the
 *            clearance - or than the commanded height, if that is lower - and
 *            comes back down to its altitude afterwards.
 * Either way climbs start early enough for the airframe's climb rate.
 * On return path.agl holds the height above the terrain to fly.
 */
function applyHeightReference(world, drone, path, cfg, v) {
  const n = path.agl.length;
  if (cfg.altRef !== 'baro') {
    if (!cfg.avoid) return;
    const need = new Float64Array(n);
    for (let i = 0; i < n; i++) need[i] = world.requiredAgl(path.x[i], path.z[i], path.agl[i]);
    path.agl = path.vertical || path.hover ? need : rateLimit(need, path, drone, v);
    return;
  }
  const home = world.pilot;
  const eHome = world.elevAt(home.x, home.z);
  const clearance = Math.max(cfg.clearance ?? 10, 0.5);
  const e = new Float64Array(n);
  const alt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    e[i] = world.elevAt(path.x[i], path.z[i]);
    const cmd = path.agl[i];
    let agl = Math.max(eHome + cmd - e[i], Math.min(clearance, cmd));
    if (cfg.avoid) agl = world.requiredAgl(path.x[i], path.z[i], agl);
    alt[i] = e[i] + agl;
  }
  const out = path.vertical || path.hover ? alt : rateLimit(alt, path, drone, v);
  path.agl = new Float64Array(n);
  for (let i = 0; i < n; i++) path.agl[i] = out[i] - e[i];
  path.eHome = eHome;
}

/**
 * Makes a height profile flyable: each sample may sit at most one climb step
 * below the next (climbs start early enough for the airframe's climb rate) and
 * descents are at most 1.5× as steep. Works on heights above ground as well as
 * on absolute altitudes.
 */
function rateLimit(need, path, drone, v) {
  const n = need.length;
  // allowed height change per sample at the local speed and the airframe's climb rate
  const step = (i) => ((drone.climb * 0.8) / Math.max(path.speed ? path.speed[i] : v, 0.5)) * path.ds;
  const out = Float64Array.from(need);
  for (let round = 0; round < 2; round++) {
    for (let i = n - 2; i >= 0; i--) out[i] = Math.max(out[i], out[i + 1] - step(i));
    if (!path.open) out[n - 1] = Math.max(out[n - 1], out[0] - step(n - 1));
    for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] - step(i) * 1.5);
    if (!path.open) out[0] = Math.max(out[0], out[n - 1] - step(0) * 1.5);
  }
  return out;
}

// ----------------------------------------------------------------- kinematics

/** Position on the path at arc length s (wraps around). */
export function samplePath(path, s, out = {}) {
  const len = path.len;
  const n = path.x.length;
  if (len <= 0) {
    out.x = path.x[0];
    out.z = path.z[0];
    out.agl = path.agl[0];
    out.curv = 0;
    out.dx = 0;
    out.dz = 0;
    out.dagl = 0;
    return out;
  }
  let u = path.open ? clamp(s, 0, len) : s % len;
  if (u < 0) u += len;
  const f = u / path.ds;
  const i = Math.max(0, Math.min(Math.floor(f), n - 2));
  const t = f - i;
  out.x = path.x[i] + (path.x[i + 1] - path.x[i]) * t;
  out.z = path.z[i] + (path.z[i + 1] - path.z[i]) * t;
  out.agl = path.agl[i] + (path.agl[i + 1] - path.agl[i]) * t;
  out.curv = path.curv[i] + (path.curv[i + 1] - path.curv[i]) * t;
  out.dx = (path.x[i + 1] - path.x[i]) / path.ds;
  out.dz = (path.z[i + 1] - path.z[i]) / path.ds;
  out.dagl = (path.agl[i + 1] - path.agl[i]) / path.ds;
  return out;
}

/** Target attitude (rad) for the airframe at speed v and curvature κ; pitch > 0 = nose down. */
export function attitude(drone, v, curv, climbRate) {
  const lat = Math.atan((v * v * curv) / G);
  if (drone.type === 'multi' || (drone.type === 'vtol' && v < 10)) {
    const tilt = (drone.maxTilt || 15) * DEG;
    const pitch = tilt * clamp(v / drone.vMax, 0, 1) ** 2;
    return { pitch, roll: clamp(lat, -tilt, tilt) };
  }
  const bank = drone.maxBank * DEG;
  const gamma = Math.atan2(climbRate, Math.max(v, 1));
  return { pitch: -(3 * DEG + gamma), roll: clamp(lat, -bank, bank) };
}

/** Body axes {X: forward, Y: up, Z: right} in world coordinates from heading/pitch/roll (rad). */
export function bodyAxes(heading, pitch, roll) {
  const f = [Math.cos(heading), 0, Math.sin(heading)];
  const u = [0, 1, 0];
  const r = [-Math.sin(heading), 0, Math.cos(heading)];
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const f1 = [f[0] * cp - u[0] * sp, f[1] * cp - u[1] * sp, f[2] * cp - u[2] * sp];
  const u1 = [u[0] * cp + f[0] * sp, u[1] * cp + f[1] * sp, u[2] * cp + f[2] * sp];
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const r2 = [r[0] * cr - u1[0] * sr, r[1] * cr - u1[1] * sr, r[2] * cr - u1[2] * sr];
  const u2 = [u1[0] * cr + r[0] * sr, u1[1] * cr + r[1] * sr, u1[2] * cr + r[2] * sr];
  return { X: f1, Y: u2, Z: r2 };
}
