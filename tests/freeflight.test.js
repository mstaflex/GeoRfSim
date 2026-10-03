import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../app/js/world.js';
import { SCENARIO_BY_ID } from '../app/js/scenarios.js';
import { DRONE_BY_ID, G } from '../app/js/flight.js';
import { createFree, freeStep, NO_INPUT } from '../app/js/freeflight.js';
import { Simulation } from '../app/js/sim.js';
import { sanitizeProfile } from '../app/js/profiles.js';
import { TECHS } from '../app/js/rf/tech.js';

const worlds = new Map();
const world = (id) => {
  if (!worlds.has(id)) worlds.set(id, new World(SCENARIO_BY_ID[id]));
  return worlds.get(id);
};
const DEG = Math.PI / 180;
const H = 0.02;
const fly = (f, inp, drone, w, sec) => {
  let bump = false;
  for (let t = 0; t < sec; t += H) bump = freeStep(f, inp, drone, w, H).bump || bump;
  return bump;
};
const at = (w, x, z, agl) => ({ x, z, y: w.elevAt(x, z) + agl, heading: 0 });

test('multirotor in position mode: full stick reaches vMax at full tilt, centred sticks hold position', () => {
  const w = world('open');
  const d = DRONE_BY_ID.prosumer;
  const f = createFree(at(w, 0, 0, 60));
  const y0 = f.y;
  fly(f, { ...NO_INPUT, pitch: 1 }, d, w, 8);
  assert.ok(Math.abs(Math.hypot(f.vx, f.vz) - d.vMax) < 0.2, `speed ${Math.hypot(f.vx, f.vz)}`);
  assert.ok(Math.abs(f.pitch - d.maxTilt * DEG) < 1.5 * DEG, `pitch ${f.pitch / DEG}°`);
  assert.ok(f.vx > 0 && Math.abs(f.vz) < 1e-9, 'flies along its heading');
  assert.ok(Math.abs(f.y - y0) < 1e-6, 'altitude held');
  fly(f, NO_INPUT, d, w, 6);
  assert.ok(Math.hypot(f.vx, f.vz) < 1e-6, 'stops');
  assert.ok(Math.abs(f.pitch) < 2 * DEG, 'levels out');
  // stopping distance follows the acceleration limit: v²/2a
  const g = createFree(at(w, 0, 0, 60));
  fly(g, { ...NO_INPUT, pitch: 1 }, d, w, 8);
  const x1 = g.x;
  fly(g, NO_INPUT, d, w, 8);
  const stop = (d.vMax * d.vMax) / (2 * d.accel);
  assert.ok(Math.abs(g.x - x1 - stop) < 2, `stopping distance ${g.x - x1} vs ${stop}`);
  // climbs at the climb rate, yaw turns the heading
  const c = createFree(at(w, 0, 0, 20));
  fly(c, { ...NO_INPUT, thr: 1, yaw: 1 }, d, w, 5);
  assert.ok(Math.abs(c.vy - d.climb) < 1e-6);
  assert.ok(c.yaw > 1, 'turned right');
});

test('ground and buildings are solid', () => {
  const o = world('open');
  const d = DRONE_BY_ID.prosumer;
  const f = createFree(at(o, 100, 100, 10));
  fly(f, { ...NO_INPUT, thr: -1 }, d, o, 10);
  assert.ok(f.onGround);
  assert.ok(Math.abs(f.y - (o.elevAt(f.x, f.z) + 0.2)) < 0.05, 'sits on the ground');
  // fly from a free spot in the street into the side of a city building
  const u = world('urban');
  const b = u.buildings.find((x) => x.h > 20 && x.z1 - x.z0 > 20 && u.obstacleTop(x.x0 - 25, (x.z0 + x.z1) / 2, 4) === 0);
  assert.ok(b, 'a building with a street in front');
  const z = (b.z0 + b.z1) / 2;
  const g = createFree(at(u, b.x0 - 25, z, 8));
  const bump = fly(g, { ...NO_INPUT, pitch: 1 }, d, u, 10);
  assert.ok(bump, 'bumped');
  assert.ok(g.x < b.x0 + 1, `stopped at the wall (x ${g.x} vs wall ${b.x0})`);
  assert.ok(g.y - u.elevAt(g.x, g.z) < 9, 'still at street level');
  assert.equal(u.bldgAt(g.x, g.z), 0, 'not inside');
});

test('fixed wing: coordinated turns and no stall', () => {
  const w = world('open');
  const d = DRONE_BY_ID.fixedwing;
  const f = createFree({ ...at(w, 0, 0, 120), vx: d.vCruise });
  fly(f, { ...NO_INPUT, thr: -1, roll: 1 }, d, w, 6);
  assert.ok(f.airspeed >= d.vMin - 1e-9, 'never below stall speed');
  assert.ok(Math.abs(f.bank - d.maxBank * DEG) < 1e-6, 'full bank');
  const y0 = f.yaw;
  fly(f, { ...NO_INPUT, thr: -1, roll: 1 }, d, w, 1);
  let turned = f.yaw - y0;
  if (turned < 0) turned += 2 * Math.PI;
  const expected = (G * Math.tan(d.maxBank * DEG)) / f.airspeed;
  assert.ok(Math.abs(turned - expected) < 0.02, `turn rate ${turned} vs ${expected}`);
  // full throttle: accelerates to vMax
  fly(f, { ...NO_INPUT, thr: 1 }, d, w, 10);
  assert.ok(Math.abs(f.airspeed - d.vMax) < 1e-6);
});

test('simulation: free flight takes over in the air and hands back to the pattern', () => {
  const w = world('open');
  const sim = new Simulation(w, { ...SCENARIO_BY_ID.open.defaults, drone: 'prosumer', pattern: 'orbit', height: 50, size: 300 });
  for (let i = 0; i < 40; i++) sim.step(0.05);
  const before = { ...sim.dr };
  sim.startFree();
  assert.ok(sim.free);
  sim.step(0.05);
  assert.ok(Math.hypot(sim.dr.x - before.x, sim.dr.z - before.z) < 2, 'continues from where it was');
  sim.input = { ...NO_INPUT, pitch: 1 };
  for (let i = 0; i < 200; i++) sim.step(0.05);
  assert.ok(Math.hypot(sim.dr.x - before.x, sim.dr.z - before.z) > 100, 'flew away');
  assert.ok(sim.recentPer(0) >= 0 && sim.recentPer(0) <= 1);
  const away = { ...sim.dr };
  sim.stopFree();
  assert.equal(sim.free, null);
  assert.ok(sim.freeEndT > sim.freeStartT);
  assert.ok(Math.hypot(sim.dr.x - away.x, sim.dr.z - away.z) < 1e-6, 'no jump when the pattern takes over');
  // it flies back to the pattern instead: never faster than its speed plus the glide over
  let step = 0;
  for (let i = 0; i < 1200 && sim.rejoin; i++) {
    const a = { ...sim.dr };
    sim.step(0.05);
    step = Math.max(step, Math.hypot(sim.dr.x - a.x, sim.dr.z - a.z) / 0.05);
  }
  assert.equal(sim.rejoin, null, 'back on the pattern');
  assert.ok(step < sim.flySpeed * 1.9, `moved at most ${step.toFixed(1)} m/s`);
});

test('changing speed, size or the height reference in flight never makes the drone jump', () => {
  const v = world('valley');
  for (const change of [{ speed: 28 }, { speed: 6 }, { size: 1200 }, { altRef: 'baro' }]) {
    const sim = new Simulation(v, { ...SCENARIO_BY_ID.valley.defaults });
    for (let i = 0; i < 1200; i++) sim.step(0.05);
    const a = { ...sim.dr };
    sim.configure(change);
    assert.ok(Math.hypot(sim.dr.x - a.x, sim.dr.z - a.z) < 1e-6, `${JSON.stringify(change)}: same place right after the change`);
    for (let i = 0; i < 400; i++) {
      const b = { ...sim.dr };
      sim.step(0.05);
      const step = Math.hypot(sim.dr.x - b.x, sim.dr.z - b.z);
      assert.ok(step < 0.05 * 2 * Math.max(sim.flySpeed, 20), `${JSON.stringify(change)}: smooth (${step.toFixed(2)} m per step)`);
    }
  }
});

test('return to home climbs over the city and lands next to the pilot', () => {
  const u = world('urban');
  const sim = new Simulation(u, { ...SCENARIO_BY_ID.urban.defaults, drone: 'prosumer' });
  sim.step(0.1);
  sim.startFree();
  // put it low in a street 300 m away
  const p = u.pilot;
  let spot = null;
  for (let r = 300; r < 600 && !spot; r += 20) {
    for (let a = 0; a < 2 * Math.PI && !spot; a += 0.2) {
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      if (Math.abs(x) < u.half - 50 && Math.abs(z) < u.half - 50 && u.obstacleTop(x, z, 6) === 0) spot = { x, z };
    }
  }
  assert.ok(spot, 'found a street');
  Object.assign(sim.free, { x: spot.x, z: spot.z, y: u.elevAt(spot.x, spot.z) + 5, vx: 0, vz: 0, vy: 0 });
  sim.setRth(true);
  const phases = new Set();
  let maxAgl = 0;
  for (let i = 0; i < 4000 && sim.rth.phase !== 'landed'; i++) {
    sim.step(0.05);
    phases.add(sim.rth.phase);
    maxAgl = Math.max(maxAgl, sim.dr.agl);
  }
  assert.equal(sim.rth.phase, 'landed');
  assert.deepEqual([...phases].slice(0, 2), ['climb', 'return']);
  assert.ok(maxAgl >= 39, `climbed to the return height (${maxAgl})`);
  const d = Math.hypot(sim.dr.x - p.x, sim.dr.z - p.z);
  assert.ok(d > 2 && d < 9, `landed beside the pilot, not on them (${d.toFixed(1)} m)`);
  assert.ok(sim.dr.agl < 0.5);
});

test('flight profiles in the simulation: holds are held, hairpins are flown to the end', () => {
  const w = world('open');
  const profile = sanitizeProfile({
    end: 'reverse',
    waypoints: [{ x: -300, z: 0, h: 30, v: 12 }, { x: 0, z: 0, h: 30, v: 12, hold: 4 }, { x: 300, z: 0, h: 30, v: 12 }],
  });
  const sim = new Simulation(w, { ...SCENARIO_BY_ID.open.defaults, drone: 'prosumer', pattern: 'custom', profile, avoid: false });
  let held = 0;
  let minEndDist = Infinity;
  let maxV = 0;
  for (let i = 0; i < 2400; i++) {
    sim.step(0.05);
    if (sim.holdLeft > 0) held += 0.05;
    minEndDist = Math.min(minEndDist, Math.hypot(sim.dr.x - 300, sim.dr.z));
    maxV = Math.max(maxV, sim.vCur);
  }
  // 120 s: out (≈ 300/12 + 4 + 300/12), stop at the end, back with the hold again
  assert.ok(held > 7 && held < 9.5, `held ${held.toFixed(1)} s`);
  assert.ok(minEndDist < 2, `reached the far waypoint (${minEndDist.toFixed(1)} m)`);
  assert.ok(Math.abs(maxV - 12) < 1e-6, 'leg speed');
});

test('the failsafe signal: recent PER reflects a lost link', () => {
  const u = world('urban');
  const sim = new Simulation(u, { ...SCENARIO_BY_ID.urban.defaults, drone: 'prosumer' });
  sim.step(0.1);
  sim.startFree();
  // far away, low, behind the blocks
  Object.assign(sim.free, { x: u.half - 60, z: -u.half + 60, y: u.elevAt(u.half - 60, -u.half + 60) + 2 });
  for (let i = 0; i < 60; i++) sim.step(0.05);
  const wifi = TECHS.findIndex((t) => t.id === 'wifi24');
  assert.ok(sim.recentPer(wifi, 1) > 0.9, `Wi-Fi lost (${sim.recentPer(wifi, 1)})`);
});
