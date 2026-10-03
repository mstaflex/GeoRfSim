import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heightMapping, mapHeight } from '../app/js/gfx/heightmap.js';
import { SCENARIOS } from '../app/js/scenarios.js';

const display = (m, e, agl) => e * m.terrK + mapHeight(m, agl);

test('log scale: continuous and monotonic, log near the ground, linear above the knee', () => {
  for (const s of SCENARIOS) {
    const m = heightMapping({ mode: 'log', h0: s.view.h0, gain: s.view.gain, terrK: s.terrainExag, S: s.size });
    const [hc, yc] = m.knee;
    assert.ok(hc > 20 && hc < 150, `${s.id}: knee at ${hc.toFixed(0)} m`);
    assert.ok(Math.abs(mapHeight(m, hc) - yc) < 1e-9, 'continuous at the knee');
    // the log part magnifies near the ground: 2 m is far more than 2 m × the terrain exaggeration
    assert.ok(mapHeight(m, 2) > 2 * m.terrK * 2, `${s.id}: low heights magnified`);
    let prev = -Infinity;
    for (let h = 0; h <= 1000; h += 0.5) {
      const y = mapHeight(m, h);
      assert.ok(y > prev, `${s.id}: monotonic at ${h} m`);
      prev = y;
    }
    assert.equal(mapHeight(m, -30), -mapHeight(m, 30));
  }
});

test('a constant altitude above the knee is drawn level over hills; climbs stay climbs', () => {
  const s = SCENARIOS.find((x) => x.id === 'valley');
  const m = heightMapping({ mode: 'log', h0: s.view.h0, gain: s.view.gain, terrK: s.terrainExag, S: s.size });
  // 300 m above take-off over terrain from 0 to 180 m: the old pure-log mapping rose by > 100 display units
  const alt = 300;
  const ys = [0, 60, 120, 180].map((e) => display(m, e, alt - e));
  for (const y of ys) assert.ok(Math.abs(y - ys[0]) < 1e-6, `level: ${ys.map((v) => v.toFixed(1)).join(', ')}`);
  // a real climb of 50 m shows up as 50 m × the exaggeration
  assert.ok(Math.abs(display(m, 100, 250) - display(m, 100, 200) - 50 * m.terrK) < 1e-6);
  // linear and true scale: level at every height
  for (const mode of ['lin', 'true']) {
    const n = heightMapping({ mode, h0: 15, gain: 1, terrK: 1.6, S: 4000 });
    assert.ok(Math.abs(display(n, 0, 40) - display(n, 30, 10)) < 1e-9, mode);
  }
  assert.equal(heightMapping({ mode: 'true', terrK: 2.5 }).terrK, 1, 'true scale has no terrain exaggeration');
});
