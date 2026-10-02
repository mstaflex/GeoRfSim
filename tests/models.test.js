import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fspl, knifeEdge, fresnelNu, weissberger, vegetationLoss, p833MaxAttenuation, groundReflection,
  roughnessFactor, kFactorDb, gpp, alHourani, delaySpread, gasAttenuation,
} from '../app/js/rf/models.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('free-space path loss matches Friis', () => {
  near(fspl(1000, 2.4e9), 100.05, 0.05, '1 km @ 2.4 GHz');
  near(fspl(100, 868e6), 71.2, 0.1, '100 m @ 868 MHz');
  near(fspl(2000, 2.4e9) - fspl(1000, 2.4e9), 6.02, 0.01, 'doubling distance');
});

test('knife-edge diffraction (ITU-R P.526)', () => {
  assert.equal(knifeEdge(-1), 0);
  near(knifeEdge(-0.78), 0, 0.05, 'J(-0.78)');
  near(knifeEdge(0), 6.0, 0.1, 'grazing incidence');
  near(knifeEdge(2.4), 20.6, 0.4, 'J(2.4)');
  let prev = -1;
  for (let nu = -0.7; nu < 10; nu += 0.3) {
    const j = knifeEdge(nu);
    assert.ok(j > prev, 'monotonic');
    prev = j;
  }
  near(fresnelNu(10, 500, 500, 0.125), 10 * Math.sqrt(2000 / (0.125 * 250000)), 1e-9, 'nu definition');
});

test('vegetation: Weissberger depth law with P.833 saturation', () => {
  near(weissberger(1e9, 13.999), weissberger(1e9, 14), 0.05, 'continuous at 14 m');
  assert.ok(vegetationLoss(2.4e9, 50) > vegetationLoss(2.4e9, 20));
  assert.ok(vegetationLoss(5.8e9, 30) > vegetationLoss(868e6, 30), 'higher frequency, more loss');
  for (const f of [433e6, 868e6, 2.4e9]) assert.ok(vegetationLoss(f, 400) < p833MaxAttenuation(f));
  assert.equal(vegetationLoss(2.4e9, 0), 0);
});

test('ground reflection: Fresnel coefficients and roughness', () => {
  const mag = ([re, im]) => Math.hypot(re, im);
  for (const pol of ['V', 'H']) near(mag(groundReflection(0.001, 2.4e9, 15, 0.005, pol)), 1, 0.02, `grazing ${pol}`);
  // circular polarisation: same-sense reflection vanishes at normal incidence
  near(mag(groundReflection(Math.PI / 2, 2.4e9, 15, 0.005, 'CP')), 0, 0.01, 'CP normal incidence');
  // vertical polarisation has a Brewster minimum, horizontal does not
  const v = mag(groundReflection(0.25, 2.4e9, 15, 0.005, 'V'));
  const h = mag(groundReflection(0.25, 2.4e9, 15, 0.005, 'H'));
  assert.ok(v < h, 'V weaker than H near Brewster angle');
  assert.equal(roughnessFactor(0, 5.8e9, 0.1), 1);
  assert.ok(roughnessFactor(0.2, 5.8e9, 0.1) < roughnessFactor(0.2, 868e6, 0.1), 'rougher at higher frequency');
  assert.ok(roughnessFactor(0.4, 2.4e9, 0.1) < roughnessFactor(0.05, 2.4e9, 0.1), 'rougher at steeper angle');
});

test('K-factor grows with elevation, clutter lowers it', () => {
  assert.ok(kFactorDb(60, 'open', 2.4e9) > kFactorDb(5, 'open', 2.4e9));
  assert.ok(kFactorDb(30, 'urban', 2.4e9) < kFactorDb(30, 'open', 2.4e9));
});

test('3GPP aerial models (TR 36.777) and terrestrial fallback (TR 38.901)', () => {
  const r = gpp('UMa', 500, 25, 150, 2e9);
  assert.equal(r.pLos, 1, 'UMa-AV above 100 m is always LOS');
  near(r.plLos, 28 + 22 * Math.log10(r.d3D) + 20 * Math.log10(2), 1e-9, 'UMa-AV LOS formula');
  for (const model of ['UMa', 'UMi', 'RMa']) {
    for (const h of [1.5, 15, 50, 200]) {
      const g = gpp(model, 800, 25, h, 2.4e9);
      assert.ok(g.plNlos >= g.plLos, `${model} NLOS ≥ LOS at ${h} m`);
      assert.ok(g.pLos >= 0 && g.pLos <= 1);
    }
  }
  assert.ok(gpp('UMa', 800, 25, 1.5, 2e9).pLos < gpp('UMa', 800, 25, 60, 2e9).pLos, 'LOS more likely higher up');
});

test('Al-Hourani LOS probability rises with elevation angle', () => {
  const a = alHourani('urban', 10, 1000, 2e9);
  const b = alHourani('urban', 60, 1000, 2e9);
  assert.ok(b.pLos > a.pLos);
  assert.ok(a.plMean > fspl(1000, 2e9));
});

test('delay spread shrinks above the clutter; gas absorption only matters at mmWave', () => {
  assert.ok(delaySpread('urban', true, 5, 20) > delaySpread('urban', false, 5, 20));
  assert.ok(delaySpread('urban', false, 300, 20) < delaySpread('urban', false, 5, 20));
  assert.ok(gasAttenuation(26e9) > 10 * gasAttenuation(2.4e9));
});
