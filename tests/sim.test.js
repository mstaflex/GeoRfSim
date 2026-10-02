import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../app/js/world.js';
import { SCENARIOS, SCENARIO_BY_ID } from '../app/js/scenarios.js';
import { Simulation, STATE } from '../app/js/sim.js';
import { buildPath, DRONE_BY_ID, PATTERNS, samplePath } from '../app/js/flight.js';
import { TECHS, perAt, pickMode, judge, TECH_BY_ID } from '../app/js/rf/tech.js';

const worlds = new Map();
const world = (id) => {
  if (!worlds.has(id)) worlds.set(id, new World(SCENARIO_BY_ID[id]));
  return worlds.get(id);
};

test('PER waterfall and link adaptation', () => {
  assert.ok(Math.abs(perAt(5, 5, 1.5) - 0.1) < 1e-12, 'PER is 10 % at the threshold');
  assert.ok(perAt(10, 5, 1.5) < 0.001);
  assert.ok(perAt(0, 5, 1.5) > 0.9);
  const wifi = TECH_BY_ID.wifi24;
  assert.equal(pickMode(wifi, 100), wifi.modes.length - 1);
  assert.equal(pickMode(wifi, -20), 0);
  const mid = pickMode(wifi, 16);
  assert.ok(wifi.modes[mid].snr <= 16 - wifi.laMargin);
});

test('verdicts span the scale', () => {
  const t = TECH_BY_ID.elrs24;
  const bad = judge(t, { snrMean: -20, snr10: -30, per: 1, thr: 0, outage: 1, losses: [] });
  const good = judge(t, { snrMean: 40, snr10: 35, per: 0, thr: 16e3, outage: 0, losses: [] });
  assert.equal(bad.level, 0);
  assert.equal(good.level, 4);
  assert.ok(good.reasons.length > 0);
});

test('worlds are deterministic', () => {
  const a = new World(SCENARIO_BY_ID.valley);
  const b = new World(SCENARIO_BY_ID.valley);
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.elev.length; i += 97) {
    sa += a.elev[i];
    sb += b.elev[i];
  }
  assert.equal(sa, sb);
  assert.equal(a.trees.count, b.trees.count);
  assert.equal(a.buildings.length, b.buildings.length);
});

test('obstruction profile sees buildings, terrain and canopy', () => {
  const u = world('urban');
  const b = u.buildings.find((x) => x.h > 25);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  // ray through the middle of a tall building at 5 m height
  const e = u.elevAt(cx, cz);
  const p = u.profile(cx - 120, e + 5, cz, cx + 120, e + 5, cz);
  assert.ok(p.kB > 0, 'blocked by the building');
  assert.ok(u.requiredAgl(cx, cz, 10) > b.h, 'avoidance climbs over the roof');
  // high ray over the open lake is clear
  const l = world('lake');
  const q = l.profile(-200, l.elevAt(-200, 0) + 200, 0, 200, l.elevAt(200, 0) + 200, 0);
  assert.ok(q.kT < 0 && q.kB < 0 && q.vegDepth === 0, 'clear over water');
  // a low ray through the forest accumulates foliage
  const f = world('forest');
  let found = false;
  for (let x = -800; x < 800 && !found; x += 50) {
    const r = f.profile(x, f.elevAt(x, 0) + 5, 0, x + 300, f.elevAt(x + 300, 0) + 5, 0);
    if (r.vegDepth > 20) found = true;
  }
  assert.ok(found, 'foliage depth along a forest ray');
});

test('every pattern builds a closed, finite path for every airframe', () => {
  const w = world('suburban');
  for (const d of Object.values(DRONE_BY_ID)) {
    for (const p of PATTERNS) {
      const path = buildPath(w, d, { pattern: p.id, center: [100, 0], size: 400, height: 60, speed: d.vCruise, heading: 20, avoid: true });
      assert.ok(Number.isFinite(path.len), `${d.id}/${p.id} length`);
      for (let s = 0; s < path.len; s += Math.max(path.len / 50, 1)) {
        const q = samplePath(path, s);
        assert.ok(Number.isFinite(q.x) && Number.isFinite(q.z) && q.agl > 0, `${d.id}/${p.id} at ${s}`);
      }
    }
  }
});

test('all scenarios simulate without NaN and produce statistics', () => {
  for (const scn of SCENARIOS) {
    const sim = new Simulation(world(scn.id), { ...scn.defaults });
    for (let i = 0; i < 300; i++) sim.step(1 / 30);
    assert.ok(sim.track.n > 3, `${scn.id}: track recorded`);
    TECHS.forEach((t, i) => {
      const ls = sim.techStates[i].ls;
      for (const k of ['lFs', 'lT', 'lB', 'lV', 'prx', 'sinrLsDb', 'fLos', 'fdMax', 'ds']) {
        assert.ok(Number.isFinite(ls[k]), `${scn.id}/${t.id}: ${k} = ${ls[k]}`);
      }
      const st = sim.stats(i);
      assert.ok(st && Number.isFinite(st.snrMean) && st.per >= 0 && st.per <= 1, `${scn.id}/${t.id}: stats`);
      assert.ok(typeof st.verdict.label === 'string');
    });
  }
});

test('physics sanity: altitude clears the forest, receding drones see negative Doppler', () => {
  const f = world('forest');
  const low = new Simulation(f, { ...SCENARIO_BY_ID.forest.defaults, pattern: 'hover', height: 4, center: [300, 200] });
  const high = new Simulation(f, { ...SCENARIO_BY_ID.forest.defaults, pattern: 'hover', height: 300, center: [300, 200] });
  for (let i = 0; i < 60; i++) {
    low.step(0.05);
    high.step(0.05);
  }
  const i24 = TECHS.findIndex((t) => t.id === 'elrs24');
  assert.ok(low.techStates[i24].ls.lV > high.techStates[i24].ls.lV + 10, 'less foliage on the ray when high');
  assert.ok(high.techStates[i24].ls.kDb > low.techStates[i24].ls.kDb, 'more Rician when high');

  const l = world('lake');
  const sim = new Simulation(l, { ...SCENARIO_BY_ID.lake.defaults });
  for (let i = 0; i < 100; i++) sim.step(0.05);
  const g = sim.geo.pilot;
  const ls = sim.techStates[i24].ls;
  if (g.vRad > 1) assert.ok(ls.fLos < 0, 'receding → negative shift');
  assert.ok(ls.state === STATE.LOS, 'over water the path is clear');
});
