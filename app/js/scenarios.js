/*
 * Scenario definitions. Each one builds its world from the primitives in
 * world.js and brings sensible defaults (drone, pattern, height, speed) so a
 * single click lands in a meaningful situation.
 */
import { LAND } from './world.js';
import { rng, clamp } from './util.js';

/** Closed, slightly irregular loop - used for forest roads and over-water circuits. */
function wobblyLoop(cx, cz, r, rand, step = 18) {
  const pts = [];
  const a1 = rand() * 6;
  const a2 = rand() * 6;
  const n = Math.ceil((2 * Math.PI * r) / step);
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const rr = r * (1 + 0.18 * Math.sin(3 * t + a1) + 0.08 * Math.sin(5 * t + a2));
    pts.push([cx + Math.cos(t) * rr, cz + Math.sin(t) * rr]);
  }
  pts.push(pts[0]);
  return pts;
}

/** Point on a polyline closest to (x, z). */
function nearestOn(points, x, z) {
  let best = null;
  let bd = Infinity;
  for (let k = 0; k + 1 < points.length; k++) {
    const [ax, az] = points[k];
    const [bx, bz] = points[k + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d < bd) {
      bd = d;
      best = [px, pz];
    }
  }
  return best;
}

/** Trees along a polyline at a lateral offset, with gaps. */
function treeLine(w, points, offset, spacing, rand, hBase, keep = 0.8) {
  for (let k = 0; k + 1 < points.length; k++) {
    const [ax, az] = points[k];
    const [bx, bz] = points[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / len;
    const nz = (bx - ax) / len;
    for (let s = spacing / 2; s < len; s += spacing) {
      if (rand() > keep) continue;
      const t = s / len;
      for (const side of offset) {
        const x = ax + (bx - ax) * t + nx * side + (rand() - 0.5) * 2;
        const z = az + (bz - az) * t + nz * side + (rand() - 0.5) * 2;
        const land = w.landAt(x, z);
        if (land === LAND.BUILDING || land === LAND.WATER || land === LAND.ROAD) continue;
        w.tree(x, z, hBase * (0.8 + 0.4 * rand()), 3 + 2 * rand(), rand() < 0.3 ? 0 : 1);
      }
    }
  }
}

/** Street grid with blocks of buildings. Returns street centre lines for routing. */
function cityGrid(w, rect, o, rand) {
  const [x0, z0, x1, z1] = rect;
  const pitch = o.block + o.street;
  const xs = [];
  const zs = [];
  for (let x = x0 + o.street / 2; x <= x1; x += pitch) xs.push(x);
  for (let z = z0 + o.street / 2; z <= z1; z += pitch) zs.push(z);
  w.paint(xs[0] - o.street / 2, zs[0] - o.street / 2, xs[xs.length - 1] + o.street / 2, zs[zs.length - 1] + o.street / 2, LAND.STREET, false);
  for (let j = 0; j + 1 < zs.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const bx0 = xs[i] + o.street / 2;
      const bx1 = xs[i + 1] - o.street / 2;
      const bz0 = zs[j] + o.street / 2;
      const bz1 = zs[j + 1] - o.street / 2;
      const cx = (bx0 + bx1) / 2;
      const cz = (bz0 + bz1) / 2;
      const roll = rand();
      if (roll < o.park) {
        w.paint(bx0, bz0, bx1, bz1, LAND.PARK, false);
        for (let t = 0; t < 14; t++) {
          w.tree(bx0 + 6 + rand() * (bx1 - bx0 - 12), bz0 + 6 + rand() * (bz1 - bz0 - 12), 12 + rand() * 8, 3.5 + rand() * 2.5, rand() < 0.3 ? 0 : 1);
        }
        continue;
      }
      if (roll < o.park + o.plaza) continue;
      const boost = o.centre ? 1 + o.centre.gain * Math.exp(-((cx - o.centre.x) ** 2 + (cz - o.centre.z) ** 2) / (2 * o.centre.r ** 2)) : 1;
      const nx = rand() < 0.25 ? 1 : 2;
      const nz = rand() < 0.25 ? 1 : 2;
      const lw = (bx1 - bx0) / nx;
      const lh = (bz1 - bz0) / nz;
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < nz; b++) {
          let h = o.median * boost * Math.exp(o.sigma * (rand() + rand() + rand() - 1.5) * 1.4);
          h = clamp(h, o.hMin, o.hMax);
          if (rand() < o.tower) h = o.towerMin + rand() * (o.towerMax - o.towerMin);
          const g = o.gap / 2;
          w.building(bx0 + a * lw + g, bz0 + b * lh + g, bx0 + (a + 1) * lw - g, bz0 + (b + 1) * lh - g, h, rand());
        }
      }
    }
  }
  return { xs, zs };
}

/** Residential lots: houses with gardens and garden trees. */
function suburbGrid(w, rect, o, rand) {
  const [x0, z0, x1, z1] = rect;
  const xs = [];
  const zs = [];
  for (let x = x0; x <= x1; x += o.bx + o.street) xs.push(x + o.street / 2);
  for (let z = z0; z <= z1; z += o.bz + o.street) zs.push(z + o.street / 2);
  const streets = [];
  for (const x of xs) streets.push([[x, zs[0]], [x, zs[zs.length - 1]]]);
  for (const z of zs) streets.push([[xs[0], z], [xs[xs.length - 1], z]]);
  for (const s of streets) w.road(s, o.street, LAND.STREET);
  for (let j = 0; j + 1 < zs.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const bx0 = xs[i] + o.street / 2;
      const bx1 = xs[i + 1] - o.street / 2;
      const bz0 = zs[j] + o.street / 2;
      const bz1 = zs[j + 1] - o.street / 2;
      const special = o.specials.find((s) => s.i === i && s.j === j);
      if (special?.type === 'park') {
        w.paint(bx0, bz0, bx1, bz1, LAND.PARK, false);
        for (let t = 0; t < 10; t++) w.tree(bx0 + 8 + rand() * (bx1 - bx0 - 16), bz0 + 8 + rand() * (bz1 - bz0 - 16), 10 + rand() * 8, 3 + rand() * 2.5);
        continue;
      }
      if (special?.type === 'commercial') {
        w.paint(bx0, bz0, bx1, bz1, LAND.STREET, false);
        const n = Math.max(1, Math.floor((bx1 - bx0) / 45));
        const lw = (bx1 - bx0) / n;
        for (let a = 0; a < n; a++) w.building(bx0 + a * lw + 4, bz0 + 6, bx0 + (a + 1) * lw - 4, bz1 - 6, 9 + rand() * 7, rand());
        continue;
      }
      w.paint(bx0, bz0, bx1, bz1, LAND.GARDEN, false);
      const nLots = Math.max(1, Math.floor((bx1 - bx0) / o.lot));
      const lw = (bx1 - bx0) / nLots;
      for (const row of [0, 1]) {
        const rz0 = row === 0 ? bz0 : (bz0 + bz1) / 2;
        const rz1 = row === 0 ? (bz0 + bz1) / 2 : bz1;
        const front = row === 0 ? rz0 : rz1;
        for (let a = 0; a < nLots; a++) {
          const lx = bx0 + (a + 0.5) * lw;
          const hw = 4.5 + rand() * 1.5;
          const hd = 5 + rand() * 1.5;
          const zc = front + (row === 0 ? 1 : -1) * (6 + hd);
          w.building(lx - hw, zc - hd, lx + hw, zc + hd, 6.5 + rand() * 3.5, rand());
          const nt = Math.floor(rand() * 3);
          for (let t = 0; t < nt; t++) {
            const tz = (rz0 + rz1) / 2 + (row === 0 ? 1 : -1) * (rand() * 0.35 * (rz1 - rz0));
            w.tree(lx + (rand() - 0.5) * (lw - 6), tz, 8 + rand() * 9, 2.5 + rand() * 2.5, rand() < 0.25 ? 0 : 1);
          }
        }
      }
    }
  }
  for (const s of streets) treeLine(w, s, [-(o.street / 2 + 2.5), o.street / 2 + 2.5], 20, rand, 11, 0.55);
  return { xs, zs };
}

export const SCENARIOS = [
  {
    id: 'open',
    name: 'Open farmland · high altitude',
    blurb: 'Gentle hills, fields, small woods and a lake. Clear LOS: climbing tames ground reflection and scattering.',
    size: 4000,
    seed: 1101,
    terrainExag: 1.5,
    view: { gain: 1, h0: 15 },
    defaults: { drone: 'enterprise', pattern: 'climb', height: 400, speed: 5, size: 800, center: [-450, 450] },
    build(w) {
      const rand = rng(77);
      w.terrain((x, z) => 40 * w.noise(0, x, z, 1600, 4) + 30 * Math.exp(-((x - 700) ** 2 + (z + 300) ** 2) / (2 * 700 ** 2)));
      w.lake(1050, -850, 320, 210, 0.4);
      const roadA = [[-2000, 1180], [-1200, 1200], [-400, 1110], [400, 1150], [1200, 1050], [2000, 1090]];
      const roadB = [[-650, 2000], [-600, 1150], [-520, 300], [-330, -600], [-380, -2000]];
      w.road(roadA, 7);
      w.road(roadB, 6);
      w.fieldPatchwork(260);
      w.building(-600, 1215, -566, 1238, 9, 0.2);
      w.building(-545, 1222, -505, 1248, 7, 0.6);
      w.building(-612, 1256, -584, 1282, 6, 0.4);
      w.forest((x, z) => w.noise(1, x, z, 520, 3) > 0.3, (x, z) => 19 + 6 * w.noise(2, x, z, 200, 2));
      treeLine(w, roadA, [-9, 9], 13, rand, 9, 0.6);
      treeLine(w, roadB, [8], 14, rand, 10, 0.5);
      w.pilot = { x: -1250, z: 1150, h: 1.5 };
      w.clearing(w.pilot.x, w.pilot.z, 45);
      w.cellSite = { x: 450, z: 1320, h: 35, model: 'RMa', isd: 1732 };
      w.route = [[-1150, 1000], [1300, 1000], [1300, 600], [-1150, 600], [-1150, 200], [1300, 200], [1300, -200], [-1150, -200], [-1150, 1000]];
      w.routeAgl = 120;
    },
  },
  {
    id: 'forest',
    name: 'Forest · through the woods',
    blurb: 'Mixed forest on rolling hills with a forest road. Fly under the canopy or just above it.',
    size: 2000,
    seed: 2203,
    terrainExag: 1.5,
    view: { gain: 1, h0: 12 },
    defaults: { drone: 'mini', pattern: 'route', height: 6, speed: 6, size: 500, center: [60, -40] },
    build(w) {
      const rand = rng(9);
      w.terrain((x, z) => 35 * w.noise(0, x, z, 900, 4));
      const loop = wobblyLoop(60, -40, 420, rand);
      w.road(loop, 9, LAND.TRAIL);
      const pilotPt = nearestOn(loop, -420, 320);
      w.road([[pilotPt[0], pilotPt[1]], [-640, 520], [-1000, 620]], 8, LAND.TRAIL);
      w.forest((x, z) => w.noise(1, x, z, 700, 3) > -0.5, (x, z) => 21 + 6 * w.noise(2, x, z, 160, 3));
      w.clearing(pilotPt[0] - 25, pilotPt[1] + 15, 50);
      w.clearing(420, 380, 70);
      w.clearing(780, -760, 45);
      w.pilot = { x: pilotPt[0] - 22, z: pilotPt[1] + 18, h: 1.5 };
      w.cellSite = { x: 780, z: -760, h: 40, model: 'RMa', isd: 2000 };
      w.route = loop;
      w.routeAgl = 6;
    },
  },
  {
    id: 'urban',
    name: 'City · street canyons',
    blurb: 'Dense blocks with a few towers. Street flights switch between LOS and NLOS at every corner.',
    size: 1600,
    seed: 3307,
    terrainExag: 1,
    view: { gain: 1.3, h0: 15 },
    defaults: { drone: 'prosumer', pattern: 'route', height: 15, speed: 8, size: 400, center: [-60, -60] },
    build(w) {
      const rand = rng(31);
      w.terrain((x, z) => 6 * w.noise(0, x, z, 800, 3));
      const rect = [-700, -700, 600, 560];
      w.flatten(rect, 160);
      w.lake(0, 720, 1300, 70, 0.02);
      const grid = cityGrid(w, rect, {
        block: 84, street: 22, park: 0.05, plaza: 0.04, gap: 4,
        median: 20, sigma: 0.35, hMin: 9, hMax: 48, tower: 0.06, towerMin: 60, towerMax: 125,
        centre: { x: -80, z: -120, r: 330, gain: 0.7 },
      }, rand);
      w.forest((x, z) => w.noise(1, x, z, 380, 3) > 0.35, (x, z) => 18 + 5 * w.noise(2, x, z, 150, 2));
      const { xs, zs } = grid;
      for (let k = 2; k < xs.length; k += 3) treeLine(w, [[xs[k], zs[0]], [xs[k], zs[zs.length - 1]]], [-8, 8], 16, rand, 11, 0.7);
      const P = (i, j) => [xs[i], zs[j]];
      const pi = 3;
      const pj = 8;
      w.pilot = { x: xs[pi] + 2, z: zs[pj] + 2, h: 1.5 };
      // serving cell on the roof of the tallest building near the centre
      let best = null;
      for (const b of w.buildings) {
        const cx = (b.x0 + b.x1) / 2;
        const cz = (b.z0 + b.z1) / 2;
        if (Math.hypot(cx - 120, cz + 160) < 240 && (!best || b.h > best.h)) best = b;
      }
      w.cellSite = { x: (best.x0 + best.x1) / 2, z: (best.z0 + best.z1) / 2, h: best.h + 4, model: 'UMa', isd: 500, roof: best.h };
      w.route = [P(3, 8), P(6, 8), P(6, 5), P(4, 5), P(4, 3), P(8, 3), P(8, 8), P(7, 8), P(7, 10), P(3, 10), P(3, 8)];
      w.routeAgl = 15;
    },
  },
  {
    id: 'suburban',
    name: 'Suburb · houses & gardens',
    blurb: 'Low-rise houses, gardens and street trees. Scattering everywhere, LOS mostly from 30 m up.',
    size: 2000,
    seed: 4409,
    terrainExag: 1.5,
    view: { gain: 0.8, h0: 15 },
    defaults: { drone: 'prosumer', pattern: 'orbit', height: 40, speed: 10, size: 420, center: [180, -60] },
    build(w) {
      const rand = rng(57);
      w.terrain((x, z) => 18 * w.noise(0, x, z, 1000, 4));
      w.fieldPatchwork(220);
      const grid = suburbGrid(w, [-760, -620, 720, 640], {
        bx: 140, bz: 74, street: 12, lot: 26,
        specials: [{ i: 2, j: 6, type: 'park' }, { i: 5, j: 2, type: 'commercial' }, { i: 6, j: 2, type: 'commercial' }, { i: 1, j: 2, type: 'park' }],
      }, rand);
      w.forest((x, z) => w.noise(1, x, z, 420, 3) > 0.3, (x, z) => 20 + 5 * w.noise(2, x, z, 150, 2));
      const { xs, zs } = grid;
      w.pilot = { x: (xs[2] + xs[3]) / 2, z: (zs[6] + zs[7]) / 2, h: 1.5 };
      w.clearTrees(w.pilot.x, w.pilot.z, 30);
      w.cellSite = { x: 420, z: -420, h: 30, model: 'UMa', isd: 800 };
      w.route = [[xs[1], zs[7]], [xs[6], zs[7]], [xs[6], zs[3]], [xs[3], zs[3]], [xs[3], zs[1]], [xs[8], zs[1]], [xs[8], zs[5]], [xs[1], zs[5]], [xs[1], zs[7]]];
      w.routeAgl = 25;
    },
  },
  {
    id: 'valley',
    name: 'Hills & valley · terrain shadowing',
    blurb: 'A forested ridge between pilot and village. Low flights diffract over the crest; climbing restores LOS.',
    size: 4000,
    seed: 5501,
    terrainExag: 1.6,
    view: { gain: 1, h0: 15 },
    defaults: { drone: 'vtol', pattern: 'line', height: 80, speed: 20, size: 2500, center: [1150, 250] },
    build(w) {
      const rand = rng(13);
      const ridgeX = (z) => 140 * Math.sin(z / 800) + 40;
      w.terrain((x, z) => {
        const base = 55 * w.noise(0, x, z, 1400, 4);
        const rx = x - ridgeX(z);
        const saddle = 1 - 0.45 * Math.exp(-(((z - 700) / 320) ** 2));
        const ridge = 220 * saddle * Math.exp(-((rx / 430) ** 2));
        const valleys = -45 * (Math.exp(-(((x + 1150) / 520) ** 2)) + Math.exp(-(((x - 1150) / 520) ** 2)));
        return base + ridge + valleys;
      });
      w.fieldPatchwork(240);
      const road = [[-2000, 500], [-1150, 560], [-600, 680], [ridgeX(700), 700], [600, 640], [1150, 420], [2000, 380]];
      w.road(road, 7);
      w.road([[-1150, -2000], [-1180, -600], [-1150, 560], [-1120, 2000]], 6);
      for (let k = 0; k < 34; k++) {
        const x = 1060 + (k % 6) * 34 + rand() * 6;
        const z = 120 + Math.floor(k / 6) * 40 + rand() * 6;
        w.building(x, z, x + 11 + rand() * 4, z + 12 + rand() * 4, 6 + rand() * 5, rand());
      }
      w.forest((x, z) => {
        const rx = Math.abs(x - ridgeX(z));
        return rx < 520 && w.noise(1, x, z, 500, 3) > -0.25;
      }, (x, z) => 22 + 5 * w.noise(2, x, z, 180, 2));
      w.forest((x, z) => w.noise(3, x, z, 450, 3) > 0.42, () => 20);
      w.pilot = { x: -1150, z: 620, h: 1.5 };
      w.clearing(w.pilot.x, w.pilot.z, 50);
      w.cellSite = { x: ridgeX(-1300), z: -1300, h: 40, model: 'RMa', isd: 2500 };
      w.route = [[-1100, 600], [-600, 690], [ridgeX(700), 710], [600, 640], [1150, 420], [1250, 150], [600, 120], [ridgeX(200), 300], [-600, 420], [-1100, 600]];
      w.routeAgl = 60;
    },
  },
  {
    id: 'lake',
    name: 'Lake · over-water reflection',
    blurb: 'Calm water is a near-perfect mirror: the two-ray interference pattern dominates at low height.',
    size: 3000,
    seed: 6607,
    terrainExag: 1.5,
    view: { gain: 1, h0: 15 },
    defaults: { drone: 'enterprise', pattern: 'line', height: 30, speed: 12, size: 1900, center: [700, 0] },
    build(w) {
      const rand = rng(21);
      w.terrain((x, z) => 26 * w.noise(0, x, z, 1200, 4) + 18 * Math.exp(-((x - 1350) ** 2 + (z + 300) ** 2) / (2 * 300 ** 2)));
      w.lake(0, 0, 1060, 640, 0.12);
      w.fieldPatchwork(250);
      w.forest((x, z) => (z < -480 && w.noise(1, x, z, 420, 3) > -0.35) || w.noise(3, x, z, 380, 3) > 0.45, (x, z) => 20 + 5 * w.noise(2, x, z, 150, 2));
      for (let k = 0; k < 22; k++) {
        const x = 1180 + (k % 5) * 30 + rand() * 6;
        const z = 260 + Math.floor(k / 5) * 34 + rand() * 6;
        if (w.landAt(x, z) === LAND.WATER) continue;
        w.building(x, z, x + 10 + rand() * 4, z + 11 + rand() * 4, 6 + rand() * 4, rand());
      }
      let px = -1160;
      while (w.landAt(px, 0) === LAND.WATER || w.landAt(px, 0) === LAND.SAND) px -= 8;
      w.pilot = { x: px, z: 0, h: 1.5 };
      w.clearing(px, 0, 45);
      w.cellSite = { x: 1350, z: -300, h: 30, model: 'RMa', isd: 1732 };
      w.route = [[px + 40, 0], [800, -60], [900, 200], [-200, 380], [-900, 250], [px + 40, 0]];
      w.routeAgl = 30;
    },
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
