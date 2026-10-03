/*
 * Free (manual) flight. Sticks are normalised to −1…1:
 *   thr   +1 climb / −1 descend (multirotor), airspeed vMin…vMax (fixed wing)
 *   yaw   +1 turn right
 *   pitch +1 forward (multirotor) / dive (fixed wing)
 *   roll  +1 right
 * Multirotors fly like a GPS drone in position mode: the sticks command
 * velocities, the airframe accelerates towards them within its acceleration
 * limit and tilts accordingly; centred sticks hold position and altitude.
 * Fixed wings fly coordinated turns (turn rate = g·tan φ / v) and never stall
 * below vMin. With the throttle (fixed wing: pitch) centred the altitude is
 * held - above the terrain ('agl', terrain following) or barometrically above
 * take-off ('baro'), where the drone only rises when the ground closes in.
 * Ground and buildings are solid; tree crowns are not.
 */
import { clamp, DEG, TAU } from './util.js';
import { G, minTurnRadius } from './flight.js';

export const NO_INPUT = Object.freeze({ thr: 0, yaw: 0, pitch: 0, roll: 0 });

/** Free-flight state taken over from the current drone state. */
export function createFree(dr) {
  return {
    x: dr.x,
    z: dr.z,
    y: dr.y,
    vx: dr.vx || 0,
    vz: dr.vz || 0,
    vy: dr.vy || 0,
    yaw: dr.heading || 0,
    pitch: dr.pitch || 0,
    roll: dr.roll || 0,
    bank: dr.roll || 0,
    airspeed: Math.hypot(dr.vx || 0, dr.vz || 0),
    onGround: false,
  };
}

/**
 * Advances the state by h seconds; returns { bump, ground } events.
 * opts: { altRef: 'baro' (default) | 'agl', clearance: m (default 10) }.
 */
export function freeStep(f, inp, drone, world, h, opts = {}) {
  const ev = { bump: false, ground: false };
  if (drone.type === 'fixed') stepFixed(f, inp, drone, world, h, ev, opts);
  else stepMulti(f, inp, drone, world, h, ev, opts);
  return ev;
}

/**
 * Vertical speed set-point. Off centre the stick commands a climb or descent
 * rate (so you can always land); centred, the altitude is held. 'agl' keeps
 * the height above the terrain it had when the stick was released; 'baro'
 * keeps the altitude and rises only where the terrain ahead comes closer than
 * the clearance - or than the height it was holding, if that was lower - and
 * sinks back to its altitude afterwards.
 */
function verticalTarget(f, cmd, climb, world, opts, sink = 0.8) {
  if (Math.abs(cmd) > 0.05) {
    f.hold = null;
    return cmd >= 0 ? cmd * climb : cmd * climb * sink;
  }
  const ground = (t) => world.elevAt(f.x + f.vx * t, f.z + f.vz * t);
  const g0 = ground(0);
  if (!f.hold) f.hold = { y: f.y, agl: f.y - g0 };
  let ahead = g0;
  for (const t of [0.5, 1, 1.5, 2.5]) ahead = Math.max(ahead, ground(t));
  const keep = Math.min(opts.clearance ?? 10, f.hold.agl);
  const want = opts.altRef === 'agl' ? ahead + f.hold.agl : Math.max(f.hold.y, ahead + keep);
  return clamp((want - f.y) * 1.5, -climb * sink, climb);
}

function stepMulti(f, inp, d, world, h, ev, opts) {
  const tilt = (d.maxTilt || 30) * DEG;
  const vMax = d.vMax;
  const a = d.accel || 5;
  const yawRate = d.model === 'fpv' ? 4 : 1.7;
  f.yaw = wrap(f.yaw + inp.yaw * yawRate * h);
  const cf = Math.cos(f.yaw);
  const sf = Math.sin(f.yaw);
  // stick → velocity set-point in the heading frame (forward, right)
  const vf = inp.pitch * vMax;
  const vr = inp.roll * vMax * 0.75;
  let dx = cf * vf - sf * vr - f.vx;
  let dz = sf * vf + cf * vr - f.vz;
  const dl = Math.hypot(dx, dz);
  const lim = a * h;
  if (dl > lim) {
    dx *= lim / dl;
    dz *= lim / dl;
  }
  f.vx += dx;
  f.vz += dz;
  const vyT = verticalTarget(f, inp.thr, d.climb, world, opts);
  f.vy += clamp(vyT - f.vy, -a * h, a * h);
  // attitude: tilt balances acceleration plus drag (drag tuned so vMax needs the full tilt)
  const kd = (Math.tan(tilt) * G) / (vMax * vMax);
  const ax = h > 0 ? dx / h : 0;
  const az = h > 0 ? dz / h : 0;
  const vF = cf * f.vx + sf * f.vz;
  const vR = -sf * f.vx + cf * f.vz;
  const aF = cf * ax + sf * az;
  const aR = -sf * ax + cf * az;
  const pitchT = clamp(Math.atan((aF + kd * vF * Math.abs(vF)) / G), -tilt, tilt);
  const rollT = clamp(Math.atan((aR + kd * vR * Math.abs(vR)) / G), -tilt, tilt);
  const k = 1 - Math.exp(-h / 0.15);
  f.pitch += (pitchT - f.pitch) * k;
  f.roll += (rollT - f.roll) * k;
  move(f, world, h, ev, 0.2);
  if (f.onGround && inp.thr <= 0.05) {
    // standing on the ground: no sliding, motors idle
    f.vx = 0;
    f.vz = 0;
    f.pitch *= 0.5;
    f.roll *= 0.5;
  }
}

function stepFixed(f, inp, d, world, h, ev, opts) {
  const vMin = d.vMin || 10;
  const vMax = Math.max(d.vMax, vMin + 1);
  const a = d.accel || 2.5;
  f.airspeed = clamp(f.airspeed || d.vCruise, vMin, vMax);
  const vT = vMin + ((inp.thr + 1) / 2) * (vMax - vMin);
  f.airspeed += clamp(vT - f.airspeed, -a * h, a * h);
  const bankMax = (d.maxBank || 35) * DEG;
  f.bank += clamp(inp.roll * bankMax - f.bank, -1.6 * h, 1.6 * h);
  f.yaw = wrap(f.yaw + ((G * Math.tan(f.bank)) / f.airspeed + inp.yaw * 0.25) * h);
  const vyT = verticalTarget(f, -inp.pitch, d.climb, world, opts, 1);
  f.vy += clamp(vyT - f.vy, -3 * h, 3 * h);
  f.vy = clamp(f.vy, -0.6 * f.airspeed, 0.6 * f.airspeed);
  const vh = Math.sqrt(Math.max(f.airspeed * f.airspeed - f.vy * f.vy, 1));
  f.vx = Math.cos(f.yaw) * vh;
  f.vz = Math.sin(f.yaw) * vh;
  f.roll = f.bank;
  f.pitch = -(3 * DEG + Math.atan2(f.vy, vh));
  move(f, world, h, ev, 1);
  if (ev.bump) f.yaw = wrap(f.yaw + Math.PI); // bounced off a wall: turn around
  if (ev.ground) f.vy = Math.max(f.vy, 1.5); // a wing cannot sit on the ground: pull up
}

/** Integrates the position with map bounds, a 1 km ceiling, solid ground and buildings. */
function move(f, world, h, ev, clearance) {
  const half = world.half - 5;
  let nx = f.x + f.vx * h;
  let nz = f.z + f.vz * h;
  if (Math.abs(nx) > half) {
    nx = clamp(nx, -half, half);
    f.vx = 0;
  }
  if (Math.abs(nz) > half) {
    nz = clamp(nz, -half, half);
    f.vz = 0;
  }
  let ny = f.y + f.vy * h;
  const roof = world.bldgAt(nx, nz);
  if (roof > 0 && ny < world.elevAt(nx, nz) + roof - 0.3) {
    // flew into a wall: stay where we were
    nx = f.x;
    nz = f.z;
    f.vx = 0;
    f.vz = 0;
    ev.bump = true;
  }
  const ground = world.elevAt(nx, nz) + world.bldgAt(nx, nz) + clearance;
  f.onGround = false;
  if (ny <= ground) {
    if (f.vy < -2.5) ev.bump = true;
    ny = ground;
    f.vy = Math.max(f.vy, 0);
    f.onGround = true;
    ev.ground = true;
  }
  const ceiling = world.elevAt(nx, nz) + 1000;
  if (ny > ceiling) {
    ny = ceiling;
    f.vy = Math.min(f.vy, 0);
  }
  f.x = nx;
  f.z = nz;
  f.y = ny;
}

/**
 * Return-to-home autopilot: climb to a safe height (and over obstacles ahead),
 * fly back, then descend and land next to the pilot. Fixed wings circle the
 * pilot instead. `st` carries the phase and the return height between calls:
 * st.alt above the ground ('agl') or st.yAlt as altitude ('baro', where the
 * ground and obstacles ahead only lift it when they come closer).
 */
export function rthInput(f, drone, home, world, st, opts = {}) {
  const dx = home.x - f.x;
  const dz = home.z - f.z;
  const dist = Math.hypot(dx, dz);
  const e = world.elevAt(f.x, f.z);
  const want = Math.atan2(dz, dx);
  const err = wrap(want - f.yaw);
  const inp = { thr: 0, yaw: 0, pitch: 0, roll: 0 };
  const baro = opts.altRef === 'baro' && Number.isFinite(st.yAlt);
  if (drone.type === 'fixed') {
    const R = Math.max(minTurnRadius(drone, f.airspeed || drone.vCruise) * 1.4, 40);
    inp.roll = dist < R * 1.6 ? 0.8 : clamp(err * 1.5, -1, 1);
    const yT = baro ? Math.max(st.yAlt, e + Math.min(opts.clearance ?? 10, 40)) : e + st.alt;
    inp.pitch = clamp((f.y - yT) / 25, -1, 1);
    st.phase = dist < R * 1.6 ? 'circle' : 'return';
    return inp;
  }
  // clear whatever stands in the next 40 m towards home (and right here)
  let top = e + world.obstacleTop(f.x, f.z);
  for (const d of [15, 30, 45]) {
    const x = f.x + Math.cos(want) * d;
    const z = f.z + Math.sin(want) * d;
    top = Math.max(top, world.elevAt(x, z) + world.obstacleTop(x, z));
  }
  const target = Math.max(baro ? st.yAlt : e + st.alt, top + 6);
  if (st.phase === 'climb' && f.y >= target - 1.5) st.phase = 'return';
  if (st.phase === 'return' && dist < 3) st.phase = 'land';
  if (st.phase === 'return' && f.y < target - 6) st.phase = 'climb';
  if (st.phase === 'climb') {
    inp.thr = 1;
    return inp;
  }
  if (st.phase === 'return') {
    inp.yaw = clamp(err * 2, -1, 1);
    inp.pitch = Math.cos(err) > 0.85 ? clamp(dist / 40, 0.05, 1) * (drone.vCruise / drone.vMax) : 0;
    inp.thr = clamp((target - f.y) / 8, -1, 1);
    return inp;
  }
  // land: creep onto the spot, then descend
  const cf = Math.cos(f.yaw);
  const sf = Math.sin(f.yaw);
  inp.pitch = clamp((cf * dx + sf * dz) / 15, -0.15, 0.15);
  inp.roll = clamp((-sf * dx + cf * dz) / 15, -0.15, 0.15);
  inp.thr = f.onGround ? 0 : f.y - e > 8 ? -1 : -0.4;
  if (f.onGround) st.phase = 'landed';
  return inp;
}

function wrap(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}
