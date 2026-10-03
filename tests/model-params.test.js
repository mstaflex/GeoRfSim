import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../app/js/world.js';
import { SCENARIO_BY_ID } from '../app/js/scenarios.js';
import { Simulation } from '../app/js/sim.js';
import { TECHS } from '../app/js/rf/tech.js';
import {
  MODEL, DEFAULT_MODEL, ENVS, DEFAULT_ENVS, MODEL_SPECS, ENV_SPECS, vegetationLoss, roughnessFactor, kFactorDb,
  setModelParam, setEnvParam, getEnvParam, resetModel, modelChanges, encodeModel, decodeModel,
} from '../app/js/rf/models.js';

const worlds = new Map();
const world = (id) => {
  if (!worlds.has(id)) worlds.set(id, new World(SCENARIO_BY_ID[id]));
  return worlds.get(id);
};
const idx = (id) => TECHS.findIndex((t) => t.id === id);

afterEach(() => resetModel());

test('every tunable parameter has a sane spec and default', () => {
  for (const s of MODEL_SPECS) {
    assert.ok(s.key in MODEL && s.id && s.label && s.help, s.key);
    if (s.type !== 'check') assert.ok(s.min <= DEFAULT_MODEL[s.key] && DEFAULT_MODEL[s.key] <= s.max, `${s.key} default in range`);
  }
  for (const env of Object.keys(ENVS)) {
    for (const s of ENV_SPECS) {
      const v = getEnvParam(env, s.key);
      assert.ok(Number.isFinite(v) && v >= s.min && v <= s.max, `${env}.${s.key} = ${v} in [${s.min}, ${s.max}]`);
    }
  }
  assert.equal(new Set(MODEL_SPECS.map((s) => s.id)).size, MODEL_SPECS.length, 'unique link codes');
});

test('vegetation, roughness and K follow their knobs', () => {
  const f = 2.4e9;
  const base = vegetationLoss(f, 20);
  setModelParam('foliage', 2);
  assert.ok(vegetationLoss(f, 20) > base, 'more foliage attenuation');
  setModelParam('foliageMax', 0.5);
  const capped = vegetationLoss(f, 400);
  setModelParam('foliageMax', 1);
  assert.ok(vegetationLoss(f, 400) > capped, 'saturation scales');
  resetModel();
  const r1 = roughnessFactor(0.3, f, 0.2);
  setModelParam('roughness', 3);
  assert.ok(roughnessFactor(0.3, f, 0.2) < r1, 'rougher ground mirrors less');
  const k = kFactorDb(10, 'urban', f);
  setEnvParam('urban', 'k0', -10);
  assert.ok(kFactorDb(10, 'urban', f) < k - 5, 'lower K = more scattering in town');
  setModelParam('foliage', 99);
  assert.equal(MODEL.foliage, 3, 'clamped to the range');
  setEnvParam('urban', 'ds', -5);
  assert.equal(ENVS.urban.ds, 5);
  resetModel();
  assert.deepEqual(ENVS, DEFAULT_ENVS);
  assert.deepEqual(MODEL, DEFAULT_MODEL);
});

test('canopy density scales the foliage depth of a ray', () => {
  const f = world('forest');
  // a low ray through the woods
  let ray = null;
  for (let x = -800; x < 800 && !ray; x += 50) {
    const r = f.profile(x, f.elevAt(x, 0) + 5, 0, x + 300, f.elevAt(x + 300, 0) + 5, 0);
    if (r.vegDepth > 20) ray = x;
  }
  assert.ok(ray !== null);
  const depth = () => f.profile(ray, f.elevAt(ray, 0) + 5, 0, ray + 300, f.elevAt(ray + 300, 0) + 5, 0).vegDepth;
  const d0 = depth();
  setModelParam('canopyDensity', 0.425);
  assert.ok(Math.abs(depth() - d0 / 2) < 1e-9, 'half the density, half the foliage depth');
});

test('the link responds: buildings, street canyons, reflection, noise rise', () => {
  const u = world('urban');
  const sim = new Simulation(u, { ...SCENARIO_BY_ID.urban.defaults });
  const wifi = idx('wifi24');
  // find a moment in NLOS behind buildings
  let ls = null;
  for (let i = 0; i < 2000 && !ls; i++) {
    sim.step(0.05);
    const l = sim.techStates[wifi].ls;
    if (l.nuB > 1) ls = l;
  }
  assert.ok(ls, 'NLOS behind buildings found');
  const lB = ls.lB;
  setModelParam('buildings', 0);
  sim.step(0.01);
  assert.equal(sim.techStates[wifi].ls.lB, 0, 'rooftop diffraction off');
  resetModel();
  setModelParam('buildings', 2);
  setModelParam('nlosCap', false);
  sim.step(0.01);
  assert.ok(sim.techStates[wifi].ls.lB > lB, 'uncapped and doubled: more loss');
  resetModel();
  setModelParam('ismRise', 0);
  sim.step(0.01);
  assert.equal(sim.techStates[wifi].ls.rise, 0, 'no unlicensed noise rise');

  // ground reflection over the lake: find a moment and a link where the mirror matters
  const l = world('lake');
  const s2 = new Simulation(l, { ...SCENARIO_BY_ID.lake.defaults });
  let k = -1;
  for (let i = 0; i < 400 && k < 0; i++) {
    s2.step(0.05);
    k = s2.techStates.findIndex((t) => Math.hypot(t.ls.gr, t.ls.gi) > 0.1);
  }
  assert.ok(k >= 0, 'a link with a noticeable ground reflection');
  const refl = () => {
    s2.step(0.001);
    const v = s2.techStates[k].ls;
    return Math.hypot(v.gr, v.gi);
  };
  const g1 = refl();
  assert.ok(g1 > 0.05, 'reflection present');
  setModelParam('reflection', 0);
  assert.equal(refl(), 0, 'reflection off');
  setModelParam('reflection', 1.5);
  const g15 = refl();
  assert.ok(g15 >= g1 * 0.98 && g15 <= g1 * 1.5 * 1.02, `stronger, but the coefficient stays ≤ 1 (${g1} → ${g15})`);
});

test('model changes travel in a compact link string', () => {
  assert.equal(encodeModel(), '');
  setModelParam('canopyDensity', 0.5);
  setModelParam('nlosCap', false);
  setEnvParam('urban', 'k0', -6);
  setEnvParam('forest', 'fdEnv', 5);
  const str = encodeModel();
  assert.equal(modelChanges().length, 4);
  assert.match(str, /cd:0\.5/);
  assert.match(str, /nc:0/);
  assert.match(str, /u\.k0:-6/);
  assert.match(str, /f\.fd:5/);
  resetModel();
  assert.equal(decodeModel(str), 4);
  assert.equal(MODEL.canopyDensity, 0.5);
  assert.equal(MODEL.nlosCap, false);
  assert.equal(ENVS.urban.k0, -6);
  assert.equal(ENVS.forest.fdEnv, 5);
  // hostile input: clamped, unknown and broken entries skipped, everything else back to defaults
  assert.equal(decodeModel('cd:1e9,zz:4,u.qq:1,x.k0:3,fo:abc,,:,s.k0:-999'), 2);
  assert.equal(MODEL.canopyDensity, 1);
  assert.equal(ENVS.suburban.k0, -15);
  assert.equal(ENVS.urban.k0, DEFAULT_ENVS.urban.k0);
  assert.equal(decodeModel(null), 0);
  assert.deepEqual(MODEL, DEFAULT_MODEL);
});
