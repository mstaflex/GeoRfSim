import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../app/js/world.js';
import { SCENARIO_BY_ID } from '../app/js/scenarios.js';
import { buildPath, samplePath, DRONE_BY_ID } from '../app/js/flight.js';
import {
  sanitizeDrone, sanitizeProfile, encodeDrone, decodeDrone, encodeProfile, decodeProfile, importJson, exportJson,
  profileStats, profileFromPath, profileFromTrack, droneFigures,
} from '../app/js/profiles.js';

const worlds = new Map();
const world = (id) => {
  if (!worlds.has(id)) worlds.set(id, new World(SCENARIO_BY_ID[id]));
  return worlds.get(id);
};
const square = (end, extra = {}) => sanitizeProfile({
  name: 'Square',
  scenario: 'open',
  end,
  waypoints: [
    { x: -200, z: -200, h: 40, v: 10 },
    { x: 200, z: -200, h: 80, v: 10, hold: 4 },
    { x: 200, z: 200, h: 80, v: 6 },
    { x: -200, z: 200, h: 40, v: 10 },
  ],
  ...extra,
});
const cfg = (profile) => ({ pattern: 'custom', profile, center: [0, 0], size: 400, height: 60, speed: 10, heading: 0, avoid: false });

test('drone profiles are clamped, typed and keep a valid id', () => {
  const d = sanitizeDrone({ id: 'evil"><script>', name: '  ', type: 'fixed', vMax: 500, vCruise: -3, climb: 'x', span: 0.01 });
  assert.match(d.id, /^u_[a-z0-9]+$/);
  assert.equal(d.name, 'Custom drone');
  assert.equal(d.vMax, 100);
  assert.ok(d.vMin >= 3 && d.vMin < d.vMax, 'fixed wing gets a stall speed');
  assert.ok(d.vCruise >= d.vMin && d.vCruise <= d.vMax);
  assert.equal(d.climb, 5);
  assert.equal(d.span, 0.1);
  assert.equal(d.model, 'plane');
  assert.equal(sanitizeDrone({ type: 'multi', vMin: 9 }).vMin, 0, 'multirotors have no stall speed');
  assert.equal(sanitizeDrone({ airAnt: 'nonsense' }).airAnt, 'auto');
  const f = droneFigures(DRONE_BY_ID.prosumer);
  assert.ok(f.turnMax > f.turnCruise && f.stop > 0 && f.dopplerMax(2.4e9) > 100);
});

test('drones and flight profiles survive the link encoding', () => {
  const d = sanitizeDrone({ id: 'u_abc123', name: 'My ~quad; v2, fast', type: 'vtol', vMax: 31, vCruise: 20.25, climb: 4, accel: 3, maxBank: 28, maxTilt: 12, span: 2.2, airAnt: 'auto' });
  const d2 = decodeDrone(encodeDrone(d));
  assert.equal(d2.id, d.id);
  assert.equal(d2.name, 'My  quad  v2  fast');
  for (const k of ['type', 'vMax', 'vCruise', 'climb', 'accel', 'maxBank', 'maxTilt', 'span']) assert.equal(d2[k], d[k], k);
  assert.equal(decodeDrone('a~b'), null);
  assert.equal(decodeDrone(42), null);

  const p = square('reverse', { id: 'p_xyz' });
  const p2 = decodeProfile(encodeProfile(p));
  assert.deepEqual(p2, p);
  assert.equal(decodeProfile('garbage'), null);
  const bad = decodeProfile('p_1~n~loop~open~1,2,3,4,5;x,y;9,9,9999,0.01,-5');
  assert.equal(bad.waypoints.length, 2, 'non-numeric waypoint dropped');
  assert.deepEqual(bad.waypoints[1], { x: 9, z: 9, h: 1000, v: 0.5, hold: 0 }, 'numbers clamped');
});

test('profiles: sanitizing and JSON import', () => {
  const many = sanitizeProfile({ waypoints: Array.from({ length: 400 }, (_, i) => ({ x: i, z: 0 })) });
  assert.equal(many.waypoints.length, 250);
  assert.equal(many.end, 'loop');
  const p = square('stop');
  assert.deepEqual(importJson(exportJson('flights', [p]), 'flights')[0].waypoints, p.waypoints);
  assert.equal(importJson(JSON.stringify([p, p]), 'flights').length, 2, 'bare array');
  assert.equal(importJson(JSON.stringify(p), 'flights').length, 1, 'single object');
  assert.throws(() => importJson('{', 'flights'), /JSON/);
  assert.throws(() => importJson(exportJson('drones', [{}]), 'flights'), /drones/);
  assert.throws(() => importJson(JSON.stringify({ waypoints: [] }), 'flights'), /waypoints/);
  const ds = importJson(exportJson('drones', [{ name: 'A' }, { name: 'B', type: 'fixed' }]), 'drones');
  assert.deepEqual(ds.map((d) => d.type), ['multi', 'fixed']);
});

test('profile statistics follow the end mode', () => {
  const d = DRONE_BY_ID.prosumer;
  const loop = profileStats(square('loop'), d);
  const stop = profileStats(square('stop'), d);
  const back = profileStats(square('reverse'), d);
  assert.equal(Math.round(loop.len), 1600);
  assert.equal(Math.round(stop.len), 1200);
  assert.equal(Math.round(back.len), 2400);
  assert.ok(Math.abs(stop.time - (400 / 10 + 400 / 10 + 400 / 6 + 4)) < 1e-9, 'legs at their speeds plus the hold');
  assert.ok(loop.maxClimb > 0);
  const fw = profileStats(square('stop'), DRONE_BY_ID.fixedwing);
  assert.ok(Math.abs(fw.time - (400 / 11 + 400 / 11 + 400 / 11)) < 1e-9, 'stall speed floor, no holds for a fixed wing');
});

test('a flight profile becomes a path through its waypoints', () => {
  const w = world('open');
  const quad = DRONE_BY_ID.prosumer;
  const near = (path, wp) => {
    let best = Infinity;
    for (let i = 0; i < path.x.length; i++) best = Math.min(best, Math.hypot(path.x[i] - wp.x, path.z[i] - wp.z));
    return best;
  };
  // loop: closed, rounded corners, per-leg speeds and the hold at waypoint 2
  const loop = buildPath(w, quad, cfg(square('loop')));
  assert.ok(!loop.open);
  assert.ok(loop.len > 1500 && loop.len < 1600, `rounded corners cut a little: ${loop.len}`);
  assert.equal(loop.holds.length, 1);
  assert.equal(loop.holds[0].wp, 1);
  assert.ok(near(loop, { x: 200, z: -200 }) < 1, 'multirotor stops sharp at the hold point');
  const q = samplePath(loop, loop.holds[0].s);
  assert.ok(Math.hypot(q.x - 200, q.z + 200) < 3, 'hold sits on its waypoint');
  assert.ok(Math.abs(q.agl - 80) < 2, 'at the waypoint height');
  assert.ok(loop.speed.some((v) => Math.abs(v - 6) < 1e-9) && loop.speed.some((v) => Math.abs(v - 10) < 1e-9), 'leg speeds');
  // stop: open path ending at the last waypoint
  const stop = buildPath(w, quad, cfg(square('stop')));
  assert.ok(stop.open);
  const end = samplePath(stop, stop.len);
  assert.ok(Math.hypot(end.x + 200, end.z - 200) < 1, 'ends on the last waypoint');
  // back & forth: turns round at the last waypoint and comes back over the same legs
  const back = buildPath(w, quad, cfg(square('reverse')));
  assert.ok(!back.open);
  assert.ok(near(back, { x: -200, z: 200 }) < 2, 'reaches the far end before turning');
  assert.equal(back.holds.filter((h) => h.t > 0).length, 2, 'the hold is flown both ways');
  assert.deepEqual(back.holds.filter((h) => h.t === 0).map((h) => h.wp), [0, 3], 'a multirotor stops where it turns back');
  for (const h of back.holds) assert.ok(h.s >= 0 && h.s <= back.len);
  // a fixed wing cannot stop or hold: it loops without holds
  const fw = buildPath(w, DRONE_BY_ID.fixedwing, cfg(square('stop')));
  assert.ok(!fw.open);
  assert.equal(fw.holds.length, 0);
  // one waypoint: hover there (multirotor), circle (fixed wing)
  const one = sanitizeProfile({ waypoints: [{ x: 50, z: 60, h: 30, v: 8 }] });
  const hov = buildPath(w, quad, cfg(one));
  assert.ok(hov.hover && hov.len === 0);
  const circ = buildPath(w, DRONE_BY_ID.fixedwing, cfg(one));
  assert.ok(circ.len > 100);
});

test('patterns and flown tracks turn into editable profiles', () => {
  const w = world('suburban');
  const quad = DRONE_BY_ID.prosumer;
  const survey = buildPath(w, quad, { pattern: 'survey', center: [0, 0], size: 300, height: 50, speed: 8, heading: 0, avoid: false });
  const p = profileFromPath(survey, { name: 'Survey', scenario: 'suburban', speed: 8 });
  assert.equal(p.end, 'loop');
  assert.ok(p.waypoints.length >= 6 && p.waypoints.length <= 120, `${p.waypoints.length} waypoints`);
  const again = buildPath(w, quad, cfg(p));
  assert.ok(Math.abs(again.len - survey.len) / survey.len < 0.05, `same length within 5 %: ${again.len} vs ${survey.len}`);

  // synthetic track: straight out, climb, back
  const n = 200;
  const track = { n, x: new Float32Array(n), z: new Float32Array(n), agl: new Float32Array(n), t: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    track.t[i] = i * 0.5;
    track.x[i] = i < 100 ? i * 4 : 400;
    track.z[i] = i < 100 ? 0 : (i - 100) * 3;
    track.agl[i] = i < 100 ? 20 : 20 + (i - 100) * 0.5;
  }
  const rec = profileFromTrack(track, 0, { name: 'Rec', scenario: 'open' });
  assert.equal(rec.end, 'stop');
  assert.ok(rec.waypoints.length >= 3 && rec.waypoints.length <= 6, `${rec.waypoints.length} waypoints`);
  assert.ok(Math.abs(rec.waypoints[0].v - 8) < 0.2, 'speed of the first leg (4 m per 0.5 s)');
  const part = profileFromTrack(track, 10, { t1: 40 });
  assert.ok(part.waypoints.every((wp) => wp.z === 0 && wp.x >= 79 && wp.x <= 321), 'only the chosen time window');
  assert.equal(profileFromTrack(track, 1e6), null);
});
