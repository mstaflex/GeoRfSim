/*
 * Procedural world: terrain height grid, land-use / clutter rasters, building
 * boxes and trees, plus the geometric queries the RF model needs (heights,
 * obstruction profile along a ray, surface under a reflection point).
 *
 * Coordinates: x east, z south, y up, metres. The map spans [−S/2, S/2]².
 * Elevations are stored relative to the lowest point of the map.
 */
import { rng, makeNoise2D, fbm, clamp, smoothstep, hashString } from './util.js';
import { MODEL } from './rf/models.js';

export const LAND = {
  GRASS: 0, FIELD: 1, FOREST: 2, WATER: 3, ROAD: 4, STREET: 5,
  BUILDING: 6, GARDEN: 7, TRAIL: 8, PARK: 9, SAND: 10,
};

/** Ground constants for the specular bounce (ITU-R P.527 orders of magnitude) and how specular the surface is. */
export const GROUND = [
  /* GRASS    */ { epsR: 15, sigma: 0.005, rough: 0.05, factor: 1 },
  /* FIELD    */ { epsR: 15, sigma: 0.005, rough: 0.1, factor: 1 },
  /* FOREST   */ { epsR: 20, sigma: 0.01, rough: 0.5, factor: 0.05 },
  /* WATER    */ { epsR: 80, sigma: 0.01, rough: 0.02, factor: 1 },
  /* ROAD     */ { epsR: 5, sigma: 0.001, rough: 0.01, factor: 0.8 },
  /* STREET   */ { epsR: 5, sigma: 0.001, rough: 0.01, factor: 0.5 },
  /* BUILDING */ { epsR: 5, sigma: 0.01, rough: 0.05, factor: 0.2 },
  /* GARDEN   */ { epsR: 15, sigma: 0.005, rough: 0.2, factor: 0.5 },
  /* TRAIL    */ { epsR: 10, sigma: 0.005, rough: 0.1, factor: 0.3 },
  /* PARK     */ { epsR: 15, sigma: 0.005, rough: 0.05, factor: 0.9 },
  /* SAND     */ { epsR: 4, sigma: 0.001, rough: 0.03, factor: 1 },
];

/** Crowns start at this fraction of tree height; below is the sparser trunk zone. */
export const CROWN_BASE = 0.35;
// canopy density (foliage share of the canopy volume) and the trunk-zone weight are tunable: MODEL in rf/models.js

export class World {
  /** @param {object} scn scenario definition (see scenarios.js) */
  constructor(scn) {
    this.scn = scn;
    this.S = scn.size;
    this.half = this.S / 2;
    this.N = 257;
    this.gridStep = this.S / (this.N - 1);
    this.R = 512;
    this.res = this.S / this.R;
    this.seed = scn.seed ?? hashString(scn.id);
    this.rand = rng(this.seed);
    this.noises = [0, 1, 2, 3, 4, 5].map((k) => makeNoise2D(this.seed * 7 + k * 101));

    this.elev = new Float32Array(this.N * this.N);
    const RR = this.R * this.R;
    this.land = new Uint8Array(RR);
    this.canopy = new Float32Array(RR);
    this.bldg = new Float32Array(RR);
    this.buildings = [];
    this.treeList = [];
    this.roads = [];
    this.fields = null;
    this.route = [];
    this.routeAgl = 30;
    this.pilot = { x: 0, z: 0, h: 1.5 };
    this.cellSite = { x: 0, z: 0, h: 30, az0: 30, model: 'UMa', isd: 500 };

    scn.build(this);
    this.#finish();
  }

  // ------------------------------------------------------------------ build helpers

  noise(k, x, z, scale, octaves = 4) {
    return fbm(this.noises[k % this.noises.length], x / scale, z / scale, octaves);
  }

  /** Sets every terrain vertex from fn(x, z) → height (m). */
  terrain(fn) {
    const { N, half, gridStep: cell, elev } = this;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) elev[j * N + i] = fn(-half + i * cell, -half + j * cell);
    }
  }

  /** Blends the terrain inside rect [x0,z0,x1,z1] towards its centre height, fading over `margin`. */
  flatten(rect, margin) {
    const [x0, z0, x1, z1] = rect;
    const target = this.elevAt((x0 + x1) / 2, (z0 + z1) / 2);
    const { N, half, gridStep: cell, elev } = this;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -half + i * cell;
        const z = -half + j * cell;
        const dx = Math.max(x0 - x, 0, x - x1);
        const dz = Math.max(z0 - z, 0, z - z1);
        const w = 1 - smoothstep(0, margin, Math.hypot(dx, dz));
        if (w > 0) elev[j * N + i] += (target - elev[j * N + i]) * w;
      }
    }
  }

  /** Raster index of a position. */
  idx(x, z) {
    const R = this.R;
    const i = clamp(Math.floor((x + this.half) / this.res), 0, R - 1);
    const j = clamp(Math.floor((z + this.half) / this.res), 0, R - 1);
    return j * R + i;
  }

  /** Calls fn(i, j, x, z) for raster cells whose centre lies in the axis-aligned box. */
  forCells(x0, z0, x1, z1, fn) {
    const { R, res, half } = this;
    const i0 = clamp(Math.ceil((x0 + half) / res - 0.5), 0, R - 1);
    const i1 = clamp(Math.floor((x1 + half) / res - 0.5), 0, R - 1);
    const j0 = clamp(Math.ceil((z0 + half) / res - 0.5), 0, R - 1);
    const j1 = clamp(Math.floor((z1 + half) / res - 0.5), 0, R - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) fn(i, j, -half + (i + 0.5) * res, -half + (j + 0.5) * res);
    }
  }

  /** Lake: ellipse with a noisy shore, flattened to a level just below its lowest shore point. */
  lake(cx, cz, rx, rz, rot = 0) {
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    const q = (x, z) => {
      const dx = x - cx;
      const dz = z - cz;
      const u = (dx * ca + dz * sa) / rx;
      const v = (-dx * sa + dz * ca) / rz;
      return Math.hypot(u, v) + 0.12 * this.noise(5, x, z, 180, 2);
    };
    let level = Infinity;
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      const x = cx + Math.cos(t) * rx * ca - Math.sin(t) * rz * sa;
      const z = cz + Math.cos(t) * rx * sa + Math.sin(t) * rz * ca;
      level = Math.min(level, this.elevAt(x, z));
    }
    level -= 0.5;
    const { N, half, gridStep: cell, elev } = this;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -half + i * cell;
        const z = -half + j * cell;
        const d = q(x, z);
        if (d < 1.25) {
          const w = smoothstep(1.25, 0.95, d);
          elev[j * N + i] += (Math.min(elev[j * N + i], level) - elev[j * N + i]) * w;
        }
      }
    }
    const r = Math.max(rx, rz) * 1.4;
    this.forCells(cx - r, cz - r, cx + r, cz + r, (i, j, x, z) => {
      const d = q(x, z);
      if (d < 1) this.land[j * this.R + i] = LAND.WATER;
      else if (d < 1 + 10 / Math.min(rx, rz)) this.land[j * this.R + i] = LAND.SAND;
    });
  }

  /** Paints a polyline road/trail of given width; clears canopy along it. */
  road(points, width, type = LAND.ROAD) {
    this.roads.push({ points, width, type });
    const hw = width / 2;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, az] = points[k];
      const [bx, bz] = points[k + 1];
      const minx = Math.min(ax, bx) - hw - this.res;
      const maxx = Math.max(ax, bx) + hw + this.res;
      const minz = Math.min(az, bz) - hw - this.res;
      const maxz = Math.max(az, bz) + hw + this.res;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      this.forCells(minx, minz, maxx, maxz, (i, j, x, z) => {
        const t = clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1);
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        if (d <= hw + this.res * 0.6) {
          const id = j * this.R + i;
          if (this.land[id] !== LAND.WATER && this.land[id] !== LAND.BUILDING) {
            this.land[id] = type;
            this.canopy[id] = 0;
          }
        }
      });
    }
  }

  /** Adds a building box and stamps it into the rasters. */
  building(x0, z0, x1, z1, h, tint = 0) {
    const base = Math.min(this.elevAt(x0, z0), this.elevAt(x1, z1), this.elevAt(x0, z1), this.elevAt(x1, z0));
    this.buildings.push({ x0, z0, x1, z1, h, base, tint });
    this.forCells(x0, z0, x1, z1, (i, j) => {
      const id = j * this.R + i;
      this.bldg[id] = Math.max(this.bldg[id], h);
      this.land[id] = LAND.BUILDING;
      this.canopy[id] = 0;
    });
  }

  /** Individual tree (gardens, streets, hedgerows): stamps its crown into the canopy raster. */
  tree(x, z, h, r, type = 1) {
    this.treeList.push({ x, z, h, r, type });
    this.forCells(x - r, z - r, x + r, z + r, (i, j, cx, cz) => {
      const id = j * this.R + i;
      if (this.land[id] === LAND.BUILDING || this.land[id] === LAND.WATER) return;
      if (Math.hypot(cx - x, cz - z) <= r) this.canopy[id] = Math.max(this.canopy[id], h);
    });
  }

  /** Forest wherever mask(x, z) is true and the ground is still open; canopy height from heightFn. */
  forest(mask, heightFn) {
    const { R, res, half } = this;
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const id = j * R + i;
        const t = this.land[id];
        if (t !== LAND.GRASS && t !== LAND.FIELD) continue;
        const x = -half + (i + 0.5) * res;
        const z = -half + (j + 0.5) * res;
        if (mask(x, z)) {
          this.land[id] = LAND.FOREST;
          this.canopy[id] = heightFn(x, z);
        }
      }
    }
  }

  /** Removes single trees (gardens, parks, streets) within r of (cx, cz). */
  clearTrees(cx, cz, r) {
    this.treeList = this.treeList.filter((t) => t.forest || Math.hypot(t.x - cx, t.z - cz) > r);
    this.forCells(cx - r - 6, cz - r - 6, cx + r + 6, cz + r + 6, (i, j, x, z) => {
      const id = j * this.R + i;
      if (this.land[id] !== LAND.FOREST && Math.hypot(x - cx, z - cz) <= r + 6) this.canopy[id] = 0;
    });
  }

  /** Clears a round clearing (grass) inside forest. */
  clearing(cx, cz, r) {
    this.forCells(cx - r, cz - r, cx + r, cz + r, (i, j, x, z) => {
      const id = j * this.R + i;
      if (Math.hypot(x - cx, z - cz) <= r && this.land[id] === LAND.FOREST) {
        this.land[id] = LAND.GRASS;
        this.canopy[id] = 0;
      }
    });
  }

  /** Fills open ground with a patchwork of fields (Voronoi cells), used for colour only. */
  fieldPatchwork(cellSize) {
    this.fields = { cellSize, seed: this.seed };
    for (let id = 0; id < this.land.length; id++) if (this.land[id] === LAND.GRASS) this.land[id] = LAND.FIELD;
  }

  /** Marks an area of open land with the given type (parks, gardens). */
  paint(x0, z0, x1, z1, type, onlyOpen = true) {
    this.forCells(x0, z0, x1, z1, (i, j) => {
      const id = j * this.R + i;
      const t = this.land[id];
      if (!onlyOpen || t === LAND.GRASS || t === LAND.FIELD || t === LAND.STREET) this.land[id] = type;
    });
  }

  // ------------------------------------------------------------------ finishing

  #finish() {
    // normalise elevation to the lowest point
    let lo = Infinity;
    for (const v of this.elev) lo = Math.min(lo, v);
    for (let k = 0; k < this.elev.length; k++) this.elev[k] -= lo;
    for (const b of this.buildings) b.base -= lo;
    this.eMin = 0;
    let hi = 0;
    for (const v of this.elev) hi = Math.max(hi, v);
    this.eMax = hi;

    this.#forestTrees();
    this.#coarseMaps();
    this.trees = this.#packTrees();
  }

  /** Visual trees for forest cells: jittered grid; crowns drawn larger than real (they stand for a group). */
  #forestTrees() {
    const spacing = clamp(this.S / 125, 11, 30);
    this.treeSpacing = spacing;
    const rand = rng(this.seed ^ 0x9e3779b9);
    const n = Math.floor(this.S / spacing);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -this.half + (i + 0.15 + 0.7 * rand()) * spacing;
        const z = -this.half + (j + 0.15 + 0.7 * rand()) * spacing;
        const id = this.idx(x, z);
        if (this.land[id] !== LAND.FOREST) continue;
        const h = this.canopy[id] * (0.85 + 0.25 * rand());
        const type = this.noise(4, x, z, 260, 2) + (rand() - 0.5) * 0.6 > 0 ? 0 : 1;
        this.treeList.push({ x, z, h, r: spacing * (0.55 + 0.15 * rand()), type, forest: true });
      }
    }
  }

  #packTrees() {
    const list = this.treeList;
    const data = new Float32Array(list.length * 8);
    const rand = rng(this.seed ^ 0x51ed27);
    list.forEach((t, k) => {
      const o = k * 8;
      data[o] = t.x;
      data[o + 1] = t.z;
      data[o + 2] = this.elevAt(t.x, t.z);
      data[o + 3] = t.h;
      // forest trees already stand for a group; single trees are drawn larger than life
      data[o + 4] = t.forest ? t.r : t.r * 1.8;
      data[o + 5] = t.type + (t.forest ? 2 : 0);
      data[o + 6] = rand();
      data[o + 7] = CROWN_BASE * (0.85 + 0.3 * rand());
    });
    return { data, count: list.length };
  }

  /** Smoothed clutter height and environment class on coarse grids. */
  #coarseMaps() {
    const C = 64;
    const f = this.R / C;
    const cov = new Float32Array(C * C);
    const hsum = new Float32Array(C * C);
    const bcov = new Float32Array(C * C);
    const bh = new Float32Array(C * C);
    const ccov = new Float32Array(C * C);
    const wcov = new Float32Array(C * C);
    for (let j = 0; j < this.R; j++) {
      for (let i = 0; i < this.R; i++) {
        const id = j * this.R + i;
        const c = Math.floor(j / f) * C + Math.floor(i / f);
        const b = this.bldg[id];
        const cn = this.canopy[id];
        const o = Math.max(b, cn);
        if (o > 0) {
          cov[c] += 1;
          hsum[c] += o;
        }
        if (b > 0) {
          bcov[c] += 1;
          bh[c] += b;
        }
        if (cn > 0) ccov[c] += 1;
        if (this.land[id] === LAND.WATER) wcov[c] += 1;
      }
    }
    const n = f * f;
    this.C = C;
    this.clutter = new Float32Array(C * C);
    this.envGrid = new Array(C * C);
    for (let j = 0; j < C; j++) {
      for (let i = 0; i < C; i++) {
        let sCov = 0, sH = 0, sB = 0, sBH = 0, sC = 0, sW = 0, cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= C || jj >= C) continue;
            const c = jj * C + ii;
            sCov += cov[c]; sH += hsum[c]; sB += bcov[c]; sBH += bh[c]; sC += ccov[c]; sW += wcov[c];
            cnt += n;
          }
        }
        const c = j * C + i;
        const covF = sCov / cnt;
        const meanH = sCov > 0 ? sH / sCov : 0;
        this.clutter[c] = meanH * Math.min(1, 3 * covF);
        const alpha = sB / cnt;
        const bMean = sB > 0 ? sBH / sB : 0;
        let env = 'open';
        if (sW / cnt > 0.5) env = 'water';
        else if (alpha > 0.28 && bMean > 28) env = 'dense';
        else if (alpha > 0.16) env = 'urban';
        else if (alpha > 0.035) env = 'suburban';
        else if (sC / cnt > 0.45) env = 'forest';
        this.envGrid[c] = env;
      }
    }
  }

  // ------------------------------------------------------------------ queries

  /** Terrain elevation (bilinear). */
  elevAt(x, z) {
    const { N, gridStep: cell, half, elev } = this;
    const fx = clamp((x + half) / cell, 0, N - 1.0001);
    const fz = clamp((z + half) / cell, 0, N - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = elev[j * N + i];
    const b = elev[j * N + i + 1];
    const c = elev[(j + 1) * N + i];
    const d = elev[(j + 1) * N + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  landAt(x, z) {
    return this.land[this.idx(x, z)];
  }

  canopyAt(x, z) {
    return this.canopy[this.idx(x, z)];
  }

  bldgAt(x, z) {
    return this.bldg[this.idx(x, z)];
  }

  /** Smoothed local clutter height (m) - how deep a terminal sits in the clutter. */
  clutterAt(x, z) {
    const C = this.C;
    const i = clamp(Math.floor(((x + this.half) / this.S) * C), 0, C - 1);
    const j = clamp(Math.floor(((z + this.half) / this.S) * C), 0, C - 1);
    return this.clutter[j * C + i];
  }

  envAt(x, z) {
    const C = this.C;
    const i = clamp(Math.floor(((x + this.half) / this.S) * C), 0, C - 1);
    const j = clamp(Math.floor(((z + this.half) / this.S) * C), 0, C - 1);
    return this.envGrid[j * C + i];
  }

  /**
   * Height a drone must keep above terrain at (x, z) to clear obstacles when
   * flying at the desired AGL. Under-canopy flight (below the crown base) is allowed.
   */
  requiredAgl(x, z, agl, margin = 4) {
    let need = agl;
    let best = 0;
    // the cell below the drone plus a ring at drone-size distance (tighter for soft tree crowns)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = this.bldg[this.idx(x + dx * 2.5, z + dz * 2.5)];
        if (b > 0) best = Math.max(best, b + margin);
        const c = this.canopy[this.idx(x + dx * 1.2, z + dz * 1.2)];
        if (c > 0 && agl > c * CROWN_BASE - 1) best = Math.max(best, c + margin * 0.75);
      }
    }
    if (best > need) need = best;
    return need;
  }

  /** Highest obstacle (roof or tree top) within r metres of (x, z), in metres above ground. */
  obstacleTop(x, z, r = 8) {
    let top = 0;
    for (let dz = -r; dz <= r; dz += r) {
      for (let dx = -r; dx <= r; dx += r) {
        const id = this.idx(x + dx, z + dz);
        top = Math.max(top, this.bldg[id], this.canopy[id]);
      }
    }
    return top;
  }

  /** Ground constants at a point (for the ground reflection). */
  surfaceAt(x, z) {
    return GROUND[this.landAt(x, z)] || GROUND[0];
  }

  /**
   * Obstruction profile of the straight ray a → b (absolute heights). Returns
   * frequency-independent quantities: k = max of h·√(d/(d1·d2)) per obstacle
   * class (ν = k·√(2/λ)), foliage depths and whether the ray is blocked.
   * `out` is reused to avoid allocations.
   */
  profile(ax, ay, az, bx, by, bz, out = {}) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d2 = Math.hypot(dx, dz);
    const d3 = Math.max(Math.hypot(d2, dy), 0.01);
    const cosEl = d2 / d3;
    const step = Math.max(this.res * 0.5, d2 / 1500);
    const n = Math.max(2, Math.ceil(d2 / step));
    const seg = d3 / n;
    let kT = -Infinity;
    let tT = 0;
    let kB = -Infinity;
    let tB = 0;
    let crown = 0;
    let trunk = 0;
    let bLen = 0;
    let firstVeg = -1;
    const R = this.R;
    const { res, half, bldg, canopy } = this;
    for (let s = 1; s < n; s++) {
      const t = s / n;
      const x = ax + dx * t;
      const z = az + dz * t;
      const y = ay + dy * t;
      const d1 = t * d3;
      const dd2 = d3 - d1;
      const geo = Math.sqrt(d3 / (d1 * dd2)) * cosEl;
      const e = this.elevAt(x, z);
      if (d1 > 8 && dd2 > 8) {
        const k = (e - y) * geo;
        if (k > kT) {
          kT = k;
          tT = t;
        }
      }
      const i = clamp(Math.floor((x + half) / res), 0, R - 1);
      const j = clamp(Math.floor((z + half) / res), 0, R - 1);
      const id = j * R + i;
      const b = bldg[id];
      if (b > 0) {
        const hb = e + b - y;
        const k = hb * geo;
        if (k > kB) {
          kB = k;
          tB = t;
        }
        if (hb > 0) bLen += seg;
      }
      const c = canopy[id];
      if (c > 0) {
        const above = y - e;
        if (above > 0 && above < c) {
          if (above >= c * CROWN_BASE) crown += seg;
          else trunk += seg;
          if (firstVeg < 0) firstVeg = t;
        }
      }
    }
    out.d2 = d2;
    out.d3 = d3;
    out.kT = kT;
    out.tT = tT;
    out.kB = kB;
    out.tB = tB;
    out.crown = crown;
    out.trunk = trunk;
    out.vegDepth = MODEL.canopyDensity * (crown + MODEL.trunkWeight * trunk);
    out.bLen = bLen;
    out.firstVeg = firstVeg;
    return out;
  }

  // ------------------------------------------------------------------ colour texture

  /** RGBA land-cover texture (T×T), used for the terrain and the minimap. */
  colorTexture(T = 1024) {
    const px = new Uint8ClampedArray(T * T * 4);
    const ts = this.S / T;
    const n0 = this.noises[0];
    const n1 = this.noises[1];
    const fieldRand = (a, b) => {
      let h = Math.imul(a * 73856093 ^ b * 19349663, 0x9e3779b1) ^ this.seed;
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
      return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    };
    const CROPS = [
      [168, 152, 86], [96, 132, 58], [118, 96, 68], [186, 170, 64], [86, 122, 60], [140, 150, 80], [104, 140, 72],
    ];
    const fc = this.fields ? this.fields.cellSize : 250;
    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        const x = -this.half + (tx + 0.5) * ts;
        const z = -this.half + (ty + 0.5) * ts;
        const land = this.land[this.idx(x, z)];
        const nn = n0(x / 40, z / 40) * 0.5 + n1(x / 9, z / 9) * 0.5;
        let r, g, b;
        switch (land) {
          case LAND.FIELD: {
            // Voronoi patchwork
            const gx = Math.floor(x / fc);
            const gz = Math.floor(z / fc);
            let best = 1e18, second = 1e18, bi = 0, bj = 0;
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                const ci = gx + di;
                const cj = gz + dj;
                const sx = (ci + 0.15 + 0.7 * fieldRand(ci, cj)) * fc;
                const sz = (cj + 0.15 + 0.7 * fieldRand(cj + 911, ci - 37)) * fc;
                const d = (x - sx) ** 2 + (z - sz) ** 2;
                if (d < best) {
                  second = best;
                  best = d;
                  bi = ci;
                  bj = cj;
                } else if (d < second) second = d;
              }
            }
            const crop = CROPS[Math.floor(fieldRand(bi * 3 + 1, bj * 5 + 2) * CROPS.length)];
            const edge = Math.sqrt(second) - Math.sqrt(best) < 4;
            const ang = fieldRand(bi + 5, bj + 9) * Math.PI;
            const stripes = Math.sin((x * Math.cos(ang) + z * Math.sin(ang)) * 0.9) * 6;
            r = crop[0] + stripes + nn * 10;
            g = crop[1] + stripes + nn * 10;
            b = crop[2] + stripes * 0.5 + nn * 6;
            if (edge) {
              r *= 0.72;
              g *= 0.8;
              b *= 0.7;
            }
            break;
          }
          case LAND.FOREST: r = 34 + nn * 8; g = 56 + nn * 10; b = 34 + nn * 6; break;
          case LAND.WATER: {
            const w = n1(x / 120, z / 120) * 6;
            r = 38 + w; g = 72 + w; b = 104 + w;
            break;
          }
          case LAND.ROAD: r = 104 + nn * 6; g = 102 + nn * 6; b = 98 + nn * 6; break;
          case LAND.STREET: r = 86 + nn * 8; g = 88 + nn * 8; b = 92 + nn * 8; break;
          case LAND.BUILDING: r = 70; g = 70; b = 74; break;
          case LAND.GARDEN: r = 92 + nn * 14; g = 128 + nn * 14; b = 70 + nn * 10; break;
          case LAND.TRAIL: r = 128 + nn * 12; g = 106 + nn * 10; b = 78 + nn * 8; break;
          case LAND.PARK: r = 84 + nn * 10; g = 128 + nn * 12; b = 66 + nn * 8; break;
          case LAND.SAND: r = 184 + nn * 10; g = 170 + nn * 10; b = 128 + nn * 8; break;
          default: r = 92 + nn * 14; g = 124 + nn * 16; b = 64 + nn * 10;
        }
        const o = (ty * T + tx) * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    }
    // crisp roads at texture resolution
    for (const rd of this.roads) {
      const col = rd.type === LAND.TRAIL ? [128, 106, 78] : [108, 106, 102];
      const hw = rd.width / 2;
      for (let k = 0; k + 1 < rd.points.length; k++) {
        const [ax, az] = rd.points[k];
        const [bx, bz] = rd.points[k + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const steps = Math.ceil(len / (ts * 0.5));
        for (let s = 0; s <= steps; s++) {
          const x = ax + ((bx - ax) * s) / steps;
          const z = az + ((bz - az) * s) / steps;
          const rr = Math.ceil(hw / ts);
          const cx = Math.floor((x + this.half) / ts);
          const cz = Math.floor((z + this.half) / ts);
          for (let dj = -rr; dj <= rr; dj++) {
            for (let di = -rr; di <= rr; di++) {
              const ii = cx + di;
              const jj = cz + dj;
              if (ii < 0 || jj < 0 || ii >= T || jj >= T) continue;
              const wx = -this.half + (ii + 0.5) * ts;
              const wz = -this.half + (jj + 0.5) * ts;
              if (Math.hypot(wx - x, wz - z) > hw) continue;
              if (this.landAt(wx, wz) === LAND.WATER) continue;
              const o = (jj * T + ii) * 4;
              px[o] = col[0];
              px[o + 1] = col[1];
              px[o + 2] = col[2];
            }
          }
        }
      }
    }
    return { T, px };
  }
}
