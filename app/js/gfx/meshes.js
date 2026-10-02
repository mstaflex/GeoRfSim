/* Procedural geometry: unit shapes for instancing, airframes, masts, antenna lobes. */

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vertex(p, n, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2], c[3] ?? 1);
    return this.count - 1;
  }

  /** Box centred at c with size s, rotated by rotY (rad) about the vertical, then optional extra transform. */
  box(c, s, color, rotY = 0, tf = null) {
    const [hx, hy, hz] = [s[0] / 2, s[1] / 2, s[2] / 2];
    const cr = Math.cos(rotY);
    const sr = Math.sin(rotY);
    const rot = (v) => [v[0] * cr - v[2] * sr, v[1], v[0] * sr + v[2] * cr];
    const faces = [
      [[1, 0, 0], [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]]],
      [[0, 0, 1], [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]]],
      [[0, 0, -1], [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]]],
    ];
    for (const [n, quad] of faces) {
      const nn = tf ? tf.n(rot(n)) : rot(n);
      const base = this.count;
      for (const q of quad) {
        const r = rot(q);
        const p = [r[0] + c[0], r[1] + c[1], r[2] + c[2]];
        this.vertex(tf ? tf.p(p) : p, nn, color);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Vertical cylinder (axis y) from y0 to y1, optionally tapered. */
  cylinder(c, r0, r1, y0, y1, seg, color, caps = true) {
    const base = this.count;
    const slope = (r0 - r1) / Math.max(y1 - y0, 1e-6);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const n = norm([ca, slope, sa]);
      this.vertex([c[0] + ca * r0, c[1] + y0, c[2] + sa * r0], n, color);
      this.vertex([c[0] + ca * r1, c[1] + y1, c[2] + sa * r1], n, color);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      this.idx.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
    if (caps) {
      for (const [y, r, ny] of [[y1, r1, 1], [y0, r0, -1]]) {
        const cIdx = this.vertex([c[0], c[1] + y, c[2]], [0, ny, 0], color);
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          this.vertex([c[0] + Math.cos(a) * r, c[1] + y, c[2] + Math.sin(a) * r], [0, ny, 0], color);
        }
        for (let i = 0; i < seg; i++) {
          if (ny > 0) this.idx.push(cIdx, cIdx + 2 + i, cIdx + 1 + i);
          else this.idx.push(cIdx, cIdx + 1 + i, cIdx + 2 + i);
        }
      }
    }
  }

  build() {
    return {
      pos: new Float32Array(this.pos),
      nrm: new Float32Array(this.nrm),
      col: new Float32Array(this.col),
      idx: this.count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx),
    };
  }
}

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// ----------------------------------------------------------------- instancing primitives

/** Unit cube [0,1]³ with face normals (buildings). */
export function unitCube() {
  const m = new MeshBuilder();
  m.box([0.5, 0.5, 0.5], [1, 1, 1], [1, 1, 1, 1]);
  return m.build();
}

/** Trunk: open cylinder radius 1, y ∈ [0, 1]. */
export function unitTrunk(seg = 5) {
  const m = new MeshBuilder();
  m.cylinder([0, 0, 0], 1, 1, 0, 1, seg, [1, 1, 1, 1], false);
  return m.build();
}

/** Crown lathe: rings at t = 0..1 with unit radius; the shader applies the crown profile. */
export function unitCrown(seg = 8, rings = 5) {
  const pos = [];
  const idx = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(a), t, Math.sin(a));
    }
  }
  const row = seg + 1;
  for (let k = 0; k < rings; k++) {
    for (let i = 0; i < seg; i++) {
      const a = k * row + i;
      idx.push(a, a + row, a + row + 1, a, a + row + 1, a + 1);
    }
  }
  // bottom cap
  const c = pos.length / 3;
  pos.push(0, 0, 0);
  for (let i = 0; i < seg; i++) idx.push(c, i, i + 1);
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) };
}

// ----------------------------------------------------------------- airframes

const C = {
  body: [0.17, 0.18, 0.2, 1],
  arm: [0.32, 0.33, 0.36, 1],
  motor: [0.55, 0.56, 0.6, 1],
  accent: [0.92, 0.55, 0.18, 1],
  white: [0.86, 0.87, 0.88, 1],
  red: [1, 0.22, 0.2, 1],
  green: [0.2, 1, 0.35, 1],
  glass: [0.1, 0.12, 0.16, 1],
  rotor: [0.85, 0.88, 0.95, 0.28],
};

/**
 * Airframe in body frame (x forward, y up, z right), span ≈ 1 unit.
 * Returns { solid, rotors } mesh data.
 */
export function airframe(model) {
  const m = new MeshBuilder();
  const r = new MeshBuilder();
  const multirotor = (n, armLen, bodyW, rotorR, color) => {
    m.box([0, 0, 0], [bodyW * 1.5, 0.11, bodyW], C.body);
    m.box([bodyW * 0.75, -0.03, 0], [0.08, 0.08, 0.1], C.glass);
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * 2 * (k + 0.5)) / n;
      const ex = Math.cos(a) * armLen;
      const ez = Math.sin(a) * armLen;
      m.box([ex / 2, 0.01, ez / 2], [armLen, 0.035, 0.05], C.arm, a);
      m.cylinder([ex, 0.02, ez], 0.045, 0.045, 0, 0.06, 8, C.motor);
      r.cylinder([ex, 0.09, ez], rotorR, rotorR, 0, 0.008, 18, C.rotor);
      const front = Math.cos(a) > 0;
      if (front) m.box([ex, -0.02, ez], [0.04, 0.03, 0.04], ez < 0 ? C.red : C.green);
    }
    m.box([-bodyW * 0.3, -0.12, -bodyW * 0.45], [0.025, 0.14, 0.025], C.arm);
    m.box([-bodyW * 0.3, -0.12, bodyW * 0.45], [0.025, 0.14, 0.025], C.arm);
    m.box([bodyW * 0.3, -0.12, -bodyW * 0.45], [0.025, 0.14, 0.025], C.arm);
    m.box([bodyW * 0.3, -0.12, bodyW * 0.45], [0.025, 0.14, 0.025], C.arm);
    m.box([0, 0.065, 0], [bodyW * 0.8, 0.02, bodyW * 0.4], color);
  };
  const wing = (span, chord, x0, color) => {
    m.box([x0, 0.02, 0], [chord, 0.025, span], color);
    m.box([x0 - chord * 0.2, 0.025, -span / 2 + 0.02], [chord * 0.6, 0.03, 0.04], C.red);
    m.box([x0 - chord * 0.2, 0.025, span / 2 - 0.02], [chord * 0.6, 0.03, 0.04], C.green);
  };
  switch (model) {
    case 'fpv':
      multirotor(4, 0.42, 0.18, 0.2, C.accent);
      m.box([-0.12, 0.13, 0], [0.015, 0.16, 0.015], C.white);
      break;
    case 'hexa':
      multirotor(6, 0.46, 0.3, 0.17, [0.2, 0.55, 0.3, 1]);
      m.box([0, -0.16, 0], [0.3, 0.12, 0.3], [0.7, 0.72, 0.75, 1]);
      break;
    case 'quadL':
      multirotor(4, 0.46, 0.3, 0.2, [0.85, 0.85, 0.86, 1]);
      break;
    case 'plane':
      m.box([0, 0, 0], [0.9, 0.11, 0.11], C.white);
      m.box([0.47, 0, 0], [0.06, 0.08, 0.08], C.glass);
      wing(1, 0.2, 0.05, C.white);
      m.box([-0.42, 0.02, 0], [0.12, 0.015, 0.34], C.white);
      m.box([-0.42, 0.09, 0], [0.12, 0.15, 0.015], C.accent);
      r.cylinder([-0.47, 0, 0], 0.11, 0.11, 0, 0.006, 16, C.rotor);
      break;
    case 'vtol':
      m.box([0, 0, 0], [0.62, 0.1, 0.1], C.white);
      m.box([0.33, 0, 0], [0.05, 0.07, 0.07], C.glass);
      wing(1, 0.17, 0.02, C.white);
      for (const z of [-0.26, 0.26]) {
        m.box([-0.02, 0.01, z], [0.72, 0.035, 0.035], C.arm);
        m.box([-0.4, 0.07, z], [0.08, 0.12, 0.012], C.accent);
        for (const x of [0.3, -0.33]) {
          m.cylinder([x, 0.02, z], 0.03, 0.03, 0, 0.04, 8, C.motor);
          r.cylinder([x, 0.07, z], 0.13, 0.13, 0, 0.006, 16, C.rotor);
        }
      }
      r.cylinder([-0.33, 0, 0], 0.08, 0.08, 0, 0.006, 16, C.rotor);
      break;
    default:
      multirotor(4, 0.4, 0.22, 0.17, [0.75, 0.76, 0.78, 1]);
  }
  return { solid: m.build(), rotors: r.build() };
}

// ----------------------------------------------------------------- ground nodes (display space)

/**
 * Pilot with a hand-held/tripod antenna. Heights are physical metres mapped by mapH.
 * w = horizontal display scale (the figure would be invisible at true size).
 */
export function pilotMesh(mapH, antennaH, w) {
  const m = new MeshBuilder();
  const coat = [0.95, 0.62, 0.2, 1];
  m.cylinder([0, 0, 0], 0.22 * w, 0.18 * w, mapH(0), mapH(1.45), 10, coat);
  m.box([0, (mapH(1.5) + mapH(1.8)) / 2, 0], [0.32 * w, mapH(1.8) - mapH(1.5), 0.32 * w], [0.92, 0.78, 0.62, 1]);
  m.cylinder([0.45 * w, 0, 0], 0.03 * w, 0.03 * w, mapH(0), mapH(antennaH), 6, [0.75, 0.75, 0.78, 1]);
  m.box([0.45 * w, mapH(antennaH), 0], [0.25 * w, Math.max(mapH(antennaH + 0.25) - mapH(antennaH), 0.2 * w), 0.25 * w], [0.2, 0.22, 0.25, 1]);
  return m.build();
}

/** Lattice-style mast with three sector panels; base at physical height h0 (roof). */
export function towerMesh(mapH, h0, h1, w, az0Deg, panels = 3) {
  const m = new MeshBuilder();
  const steel = [0.62, 0.64, 0.68, 1];
  const y0 = mapH(h0);
  const y1 = mapH(h1);
  m.cylinder([0, 0, 0], 0.55 * w, 0.22 * w, y0, y1, 4, steel);
  m.box([0, y1 - 0.05 * (y1 - y0), 0], [1.4 * w, 0.03 * (y1 - y0) + 0.5, 1.4 * w], steel);
  for (let k = 0; k < panels; k++) {
    const a = ((az0Deg + (k * 360) / panels) * Math.PI) / 180;
    const cx = Math.cos(a) * 0.7 * w;
    const cz = Math.sin(a) * 0.7 * w;
    m.box([cx, y1 - 0.12 * (y1 - y0), cz], [0.12 * w, 0.18 * (y1 - y0), 0.5 * w], [0.9, 0.9, 0.92, 1], a);
  }
  return m.build();
}

// ----------------------------------------------------------------- antenna lobes

/** Sequential blue ramp (dark → light with gain) for lobes on a dark scene. */
const RAMP = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'].map((h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
]);

export function rampColor(t) {
  const x = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(x), RAMP.length - 2);
  const f = x - i;
  return [0, 1, 2].map((c) => RAMP[i][c] + (RAMP[i + 1][c] - RAMP[i][c]) * f);
}

/**
 * Radiation pattern surface: radius ∝ gain in dB over a 30 dB range.
 * gainFn(x, y, z) gets a unit direction in the lobe's local frame.
 */
export function lobeMesh(gainFn, gMax, range = 30, nLat = 24, nLon = 48) {
  const pos = [];
  const nrm = [];
  const col = [];
  const idx = [];
  for (let i = 0; i <= nLat; i++) {
    const el = -Math.PI / 2 + (i / nLat) * Math.PI;
    for (let j = 0; j <= nLon; j++) {
      const az = (j / nLon) * Math.PI * 2;
      const d = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
      const g = gainFn(d[0], d[1], d[2]);
      const t = Math.max(0.015, (g - (gMax - range)) / range);
      pos.push(d[0] * t, d[1] * t, d[2] * t);
      nrm.push(d[0], d[1], d[2]);
      const c = rampColor(t);
      col.push(c[0], c[1], c[2], 1);
    }
  }
  const row = nLon + 1;
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = i * row + j;
      idx.push(a, a + row, a + row + 1, a, a + row + 1, a + 1);
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(col), idx: new Uint16Array(idx) };
}
