import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrbitCamera } from '../app/js/gfx/camera.js';
import { transformPoint } from '../app/js/gfx/mat.js';

const ASPECT = 2;
// a link node on the valley floor and a flight 2.4 km out along a diagonal, up to 300 m above it
const u = [Math.SQRT1_2, -Math.SQRT1_2];
const SEC = { a: [100, 20, 200], u, s0: -50, s1: 2400, lo: 0, hi: 320, front: 120, top: 0.12, bottom: 0.4 };
const along = (s, y, depth = 0) => [SEC.a[0] + u[0] * s - u[1] * depth, y, SEC.a[2] + u[1] * s + u[0] * depth];

function sideCamera() {
  const cam = new OrbitCamera();
  cam.frame(4000, [0, 0, 0]);
  cam.setMode('side');
  cam.frameSection(SEC, ASPECT);
  cam.update(ASPECT, {}, 0);
  return cam;
}

test('the side view stands still while the drone flies through it', () => {
  const cam = sideCamera();
  const vp = Array.from(cam.vp);
  for (let i = 0; i < 200; i++) {
    const drone = along(i * 12, 150 + i, 30);
    cam.update(ASPECT, { drone, heading: 0.4, pilot: SEC.a }, 1 / 60);
  }
  assert.deepEqual(Array.from(cam.vp), vp);
});

test('the side view frames the node on the left, the flight on the right, between the overlays', () => {
  const cam = sideCamera();
  const node = transformPoint(cam.vp, SEC.a);
  const far = transformPoint(cam.vp, along(SEC.s1, SEC.hi));
  assert.ok(node[0] < far[0], 'node left of the far end');
  for (const p of [node, far, transformPoint(cam.vp, along(SEC.s0, SEC.lo)), transformPoint(cam.vp, along(SEC.s1, SEC.hi, SEC.front))]) {
    assert.ok(p[0] > -1 && p[0] < 1, `x inside: ${p[0]}`);
    // NDC y runs from -1 (bottom) to 1 (top): keep clear of the minimap at the bottom and the HUD at the top
    assert.ok(p[1] > -1 + 2 * SEC.bottom && p[1] < 1 - 2 * SEC.top, `y between the overlays: ${p[1]}`);
    assert.ok(p[2] > -1 && p[2] < 1, `not cut away: ${p[2]}`);
  }
  // further towards the viewer than the flight goes is cut away
  assert.ok(transformPoint(cam.vp, along(1000, 100, SEC.front + 80))[2] < -1, 'foreground cut');
});
