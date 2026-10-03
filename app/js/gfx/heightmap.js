/*
 * Display mapping of heights (the shaders in gl.js implement the same).
 *   'log'  - logarithmic near the ground, y = H·log10(1 + h/h0), so a pilot at
 *            1.5 m and a drone at 400 m both stay readable; above the knee, where
 *            the log curve has become as flat as the terrain's exaggeration,
 *            heights continue linearly with that slope. A constant altitude is
 *            therefore drawn level over hills, and a climb looks like a climb.
 *   'lin'  - terrain and heights share one exaggeration (the terrain relief).
 *   'true' - 1:1 throughout.
 * A display height is terrK·elevation + mapHeight(height above ground).
 */

/** Mapping parameters for a world of size S. */
export function heightMapping({ mode = 'log', h0 = 15, gain = 1, terrK = 1.5, S = 2000 }) {
  const H = gain * S * 0.1;
  const tk = mode === 'true' ? 1 : terrK;
  const hc = Math.max(0, H / (Math.LN10 * tk) - h0);
  return { mode: mode === 'log' ? 0 : 1, H, h0, k: tk, terrK: tk, knee: [hc, H * Math.log10(1 + hc / h0)] };
}

/** Display height of a height above ground h (negative h maps symmetrically). */
export function mapHeight(m, h) {
  if (m.mode === 0) {
    const a = Math.abs(h);
    const y = a <= m.knee[0] ? m.H * Math.log10(1 + a / m.h0) : m.knee[1] + (a - m.knee[0]) * m.terrK;
    return h < 0 ? -y : y;
  }
  return h * m.k;
}
