import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../app/js/world.js';
import { SCENARIO_BY_ID } from '../app/js/scenarios.js';
import { buildPath, DRONE_BY_ID } from '../app/js/flight.js';
import { createFree, freeStep, NO_INPUT } from '../app/js/freeflight.js';
import { Simulation } from '../app/js/sim.js';
import { sanitizeProfile } from '../app/js/profiles.js';

const valley = new World(SCENARIO_BY_ID.valley);
const quad = DRONE_BY_ID.prosumer;
const eHome = valley.elevAt(valley.pilot.x, valley.pilot.z);
// the valley scenario's range test runs from the pilot over a forested ridge
const cfg = { ...SCENARIO_BY_ID.valley.defaults, speed: 10, heading: 0, clearance: 10 };

function stats(path) {
  const out = { minAgl: Infinity, maxAgl: -Infinity, alts: [] };
  for (let i = 0; i < path.x.length; i++) {
    const e = valley.elevAt(path.x[i], path.z[i]);
    out.minAgl = Math.min(out.minAgl, path.agl[i]);
    out.maxAgl = Math.max(out.maxAgl, path.agl[i]);
    out.alts.push(e + path.agl[i] - eHome);
  }
  out.alts.sort((a, b) => a - b);
  return out;
}

test('AGL follows the terrain; barometric holds the altitude above take-off', () => {
  const agl = stats(buildPath(valley, quad, { ...cfg, height: 150, altRef: 'agl', avoid: false }));
  assert.ok(agl.minAgl === 150 && agl.maxAgl === 150, 'constant height above ground');
  assert.ok(agl.alts[agl.alts.length - 1] - agl.alts[0] > 150, 'so the altitude follows the ridge');

  const baro = stats(buildPath(valley, quad, { ...cfg, height: 150, altRef: 'baro', avoid: false }));
  const median = baro.alts[Math.floor(baro.alts.length / 2)];
  assert.ok(Math.abs(median - 150) < 1e-6, `held at 150 m above take-off (median ${median})`);
  assert.ok(baro.alts[0] >= 150 - 1e-6, 'never below the commanded altitude');
  assert.ok(baro.maxAgl > 160, 'higher above the valley floor than commanded');
});

test('barometric: rises only where the ground closes in, early enough for the climb rate', () => {
  const p = buildPath(valley, quad, { ...cfg, height: 60, altRef: 'baro', avoid: false });
  const s = stats(p);
  assert.ok(s.minAgl >= 10 - 1e-6, `keeps the clearance (${s.minAgl.toFixed(1)} m)`);
  const top = s.alts[s.alts.length - 1];
  assert.ok(top > 150, `climbed over the ridge (${top.toFixed(0)} m above take-off)`);
  // the rest of the flight stays at the commanded altitude
  const held = s.alts.filter((a) => Math.abs(a - 60) < 1e-6).length;
  assert.ok(held > s.alts.length * 0.25, `${held} of ${s.alts.length} samples at 60 m`);
  // no climb steeper than the airframe can fly at this speed
  const maxStep = ((quad.climb * 0.8) / 10) * p.ds * 1.5 + 1e-9;
  for (let i = 1; i < p.x.length; i++) {
    const a0 = valley.elevAt(p.x[i - 1], p.z[i - 1]) + p.agl[i - 1];
    const a1 = valley.elevAt(p.x[i], p.z[i]) + p.agl[i];
    assert.ok(a1 - a0 <= maxStep, `climb step ${(a1 - a0).toFixed(2)} m at sample ${i}`);
  }
  // with avoidance tree crowns count as ground closing in
  const avoid = stats(buildPath(valley, quad, { ...cfg, height: 60, altRef: 'baro', avoid: true }));
  assert.ok(avoid.alts[avoid.alts.length - 1] > top + 5, 'higher over the forested ridge');
  // a low commanded altitude is respected where the ground does not come closer
  const low = stats(buildPath(valley, quad, { ...cfg, height: 4, altRef: 'baro', avoid: false, clearance: 30 }));
  assert.ok(low.minAgl >= 4 - 1e-6 && low.minAgl < 30, 'clearance only up to the commanded height');
});

test('flight profiles and the simulation use the height reference', () => {
  const profile = sanitizeProfile({
    end: 'reverse',
    waypoints: [{ x: valley.pilot.x + 50, z: valley.pilot.z, h: 80, v: 12 }, { x: 1100, z: 250, h: 80, v: 12 }],
  });
  const p = buildPath(valley, quad, { ...cfg, pattern: 'custom', profile, altRef: 'baro', avoid: false });
  const s = stats(p);
  assert.ok(Math.abs(s.alts[0] - 80) < 1e-6 && s.alts[s.alts.length - 1] > 150, 'profile altitudes are barometric too');

  const sim = new Simulation(valley, { ...cfg, drone: 'prosumer', height: 150, altRef: 'baro', avoid: false });
  const alts = [];
  let minAgl = Infinity;
  for (let i = 0; i < 2400; i++) {
    sim.step(0.05);
    alts.push(sim.dr.y - sim.homeElev);
    minAgl = Math.min(minAgl, sim.dr.agl);
  }
  alts.sort((a, b) => a - b);
  assert.ok(Math.abs(alts[1200] - 150) < 0.5, `flies at 150 m above take-off (median ${alts[1200].toFixed(1)})`);
  assert.ok(minAgl > 8, `clear of the ridge (${minAgl.toFixed(1)} m)`);
  // switching the reference in flight is smooth: no jump
  const y0 = sim.dr.y;
  sim.configure({ altRef: 'agl', height: 150 });
  sim.step(0.05);
  assert.ok(Math.abs(sim.dr.y - y0) < 1, 'continues from the current altitude');
});

test('free flight: AGL hold follows the ground, barometric hold rises only when it closes in', () => {
  const p = valley.pilot;
  // direction of the steepest rise from the pilot
  let best = { a: 0, rise: -Infinity };
  for (let a = 0; a < Math.PI * 2; a += 0.1) {
    let rise = -Infinity;
    for (let r = 0; r < 1500; r += 20) rise = Math.max(rise, valley.elevAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r) - eHome);
    if (rise > best.rise) best = { a, rise };
  }
  assert.ok(best.rise > 100);
  const fly = (altRef) => {
    const f = createFree({ x: p.x, z: p.z, y: eHome + 30, heading: best.a });
    const r = { minAgl: Infinity, maxAgl: 0, flatAlt: null };
    for (let t = 0; t < 80; t += 0.02) {
      freeStep(f, { ...NO_INPUT, pitch: 0.6 }, quad, valley, 0.02, { altRef, clearance: 10 });
      const agl = f.y - valley.elevAt(f.x, f.z);
      r.minAgl = Math.min(r.minAgl, agl);
      r.maxAgl = Math.max(r.maxAgl, agl);
      if (Math.abs(t - 10) < 0.01) r.flatAlt = f.y - eHome;
    }
    r.endAlt = f.y - eHome;
    return r;
  };
  const baro = fly('baro');
  assert.ok(Math.abs(baro.flatAlt - 30) < 0.5, 'holds the altitude while the ground stays away');
  assert.ok(baro.minAgl > 9, `rises before the ground comes closer than ~10 m (${baro.minAgl.toFixed(1)})`);
  assert.ok(baro.endAlt > 60, 'and climbs with it');
  const agl = fly('agl');
  assert.ok(agl.minAgl > 29 && agl.maxAgl < 45, `terrain following around 30 m (${agl.minAgl.toFixed(1)} … ${agl.maxAgl.toFixed(1)})`);
  // a deliberate descent still lands, and centred sticks keep it on the ground
  const f = createFree({ x: p.x + 40, z: p.z, y: valley.elevAt(p.x + 40, p.z) + 20, heading: 0 });
  for (let t = 0; t < 12; t += 0.02) freeStep(f, { ...NO_INPUT, thr: -1 }, quad, valley, 0.02, { altRef: 'baro', clearance: 10 });
  assert.ok(f.onGround);
  for (let t = 0; t < 3; t += 0.02) freeStep(f, NO_INPUT, quad, valley, 0.02, { altRef: 'baro', clearance: 10 });
  assert.ok(f.onGround, 'stays landed');
});
