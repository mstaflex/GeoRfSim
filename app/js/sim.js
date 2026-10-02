/*
 * Simulation engine. Per sub-step (≤ 50 ms of flight time) it moves the drone,
 * analyses the geometry towards both ground nodes (pilot, cell site) once,
 * evaluates the large-scale link of every technology from the established
 * models, and then draws fading samples at FS Hz. Samples feed rolling 5 s
 * windows (distribution, PER, throughput) and a 30 s history.
 *
 * Model chain per technology:
 *   P_mean = P_tx + G_gs + G_air − FSPL − L_terrain − L_buildings − L_veg − L_gas − L_pol + shadowing
 *   r(t)   = √(P_mean·K/(K+1)) · (1 + Γ·e^{−jkΔ(t)}) · e^{jφ_LOS(t)} + √(P_mean/(K+1)) · g(t)
 * with Γ the rough-surface Fresnel reflection, Δ the two-ray path difference
 * and g(t) unit-power sum-of-sinusoids scattering.
 */
import { World } from './world.js';
import { DRONE_BY_ID, buildPath, samplePath, attitude, bodyAxes, canHover } from './flight.js';
import { TECHS, pickMode, modeRate, perAt, impairments, noiseFloor, judge } from './rf/tech.js';
import {
  ANTENNAS, axesFromAzTilt, gainWorld, sectorGain, mountAxes, branchesOf, polOf, polLoss, reflectionPol,
} from './rf/antennas.js';
import {
  ENVS, fspl, knifeEdge, vegetationLoss, groundReflection, roughnessFactor, kFactorDb, delaySpread,
  shadowSigma, gasAttenuation, gpp, alHourani,
} from './rf/models.js';
import { FadingProcess, estimateK } from './rf/fading.js';
import { neighbourInterference } from './rf/interference.js';
import { C0, DEG, TAU, rng, gauss, clamp, hashString } from './util.js';

export const FS = 400;
export const WINDOW_S = 5;
export const HIST_S = 30;
const HIST_DECIM = 4;
const W = FS * WINDOW_S;
const H = (FS / HIST_DECIM) * HIST_S;
const SUBBANDS = 4;
const MAX_SUB = 0.05;

export const STATE = { LOS: 0, FRESNEL: 1, VEG: 2, NLOS_T: 3, NLOS_B: 4 };
export const STATE_LABELS = ['LOS', 'Fresnel zone clipped', 'Through vegetation', 'NLOS · terrain', 'NLOS · buildings'];

export const DEFAULT_CFG = {
  drone: 'prosumer',
  pattern: 'orbit',
  speed: 10,
  height: 60,
  size: 400,
  heading: 0,
  center: [0, 0],
  avoid: true,
  region: 'eu',
  gsAnt: 'auto',
  airAnt: 'auto',
  pilotH: 1.5,
  interference: true,
  load: 0.5,
  shadowing: true,
  fading: true,
};

const ENV_RANK = { water: 0, open: 1, forest: 2, suburban: 3, urban: 4, dense: 5 };
const worse = (a, b) => (ENV_RANK[a] >= ENV_RANK[b] ? a : b);
const better = (a, b) => (ENV_RANK[a] <= ENV_RANK[b] ? a : b);
const ISM_FACTOR = { 24: 1, 58: 0.5, sub: 0.6 };

/** Growable flight track with per-technology link margin for colouring. */
class Track {
  constructor(nTech, cap = 30000) {
    this.nTech = nTech;
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.e = new Float32Array(cap);
    this.agl = new Float32Array(cap);
    this.t = new Float32Array(cap);
    this.margin = new Float32Array(cap * nTech);
    this.state = new Uint8Array(cap * 2);
    this.clear();
  }

  clear() {
    this.n = 0;
    this.version = (this.version || 0) + 1;
  }

  push(p, margins, sPilot, sCell) {
    if (this.n >= this.cap) {
      const keep = Math.floor(this.cap / 2);
      const off = this.n - keep;
      for (const a of [this.x, this.z, this.e, this.agl, this.t]) a.copyWithin(0, off, this.n);
      this.margin.copyWithin(0, off * this.nTech, this.n * this.nTech);
      this.state.copyWithin(0, off * 2, this.n * 2);
      this.n = keep;
      this.version++;
    }
    const i = this.n++;
    this.x[i] = p.x;
    this.z[i] = p.z;
    this.e[i] = p.e;
    this.agl[i] = p.agl;
    this.t[i] = p.t;
    for (let k = 0; k < this.nTech; k++) this.margin[i * this.nTech + k] = margins[k];
    this.state[i * 2] = sPilot;
    this.state[i * 2 + 1] = sCell;
  }
}

function makeTechState(tech, idx, seed) {
  const rand = rng(seed + idx * 7919);
  const procs = [];
  for (let b = 0; b < 2; b++) {
    const row = [];
    for (let l = 0; l < SUBBANDS; l++) row.push(new FadingProcess(rand, 8));
    procs.push(row);
  }
  return {
    tech,
    idx,
    procs,
    brOff: [0, rand() * TAU],
    losPhase: 0,
    prevPm: null,
    ls: null,
    eff: new Float32Array(W),
    nb: new Float32Array(W),
    per: new Float32Array(W),
    thr: new Float32Array(W),
    perUl: new Float32Array(W),
    thrUl: new Float32Array(W),
    head: 0,
    count: 0,
    hist: new Float32Array(H),
    histMean: new Float32Array(H),
    histHead: 0,
    histCount: 0,
    decim: 0,
    stats: null,
    statsT: -1,
  };
}

export class Simulation {
  constructor(world, cfg = {}) {
    this.cfg = { ...DEFAULT_CFG, ...cfg };
    this.seed = hashString('georfsim');
    this.techStates = TECHS.map((t, i) => makeTechState(t, i, this.seed));
    this.track = new Track(TECHS.length);
    this.re = [0, 1].map(() => Array.from({ length: SUBBANDS }, () => new Float64Array(4096)));
    this.im = [0, 1].map(() => Array.from({ length: SUBBANDS }, () => new Float64Array(4096)));
    this.deltaBuf = { pilot: new Float64Array(4096), cell: new Float64Array(4096) };
    this.geo = { pilot: { prof: {} }, cell: { prof: {} } };
    this.shadowZ = { pilot: 0, cell: 0 };
    this.noiseRand = rng(this.seed ^ 0xabcdef);
    this.setWorld(world);
  }

  // ------------------------------------------------------------------ configuration

  setWorld(world) {
    this.world = world;
    this.reset();
    this.rebuild();
  }

  /** Merge config; rebuild the path when flight parameters change. */
  configure(partial) {
    const prev = this.cfg;
    this.cfg = { ...prev, ...partial };
    const pathKeys = ['drone', 'pattern', 'speed', 'height', 'size', 'heading', 'center', 'avoid'];
    if (pathKeys.some((k) => k in partial && JSON.stringify(partial[k]) !== JSON.stringify(prev[k]))) this.rebuild();
    else this.#aimAntennas();
  }

  get drone() {
    return DRONE_BY_ID[this.cfg.drone];
  }

  /** Speed actually flown (clamped to the airframe's envelope). */
  get flySpeed() {
    const d = this.drone;
    return clamp(this.cfg.speed, d.vMin || 0, d.vMax);
  }

  rebuild() {
    const d = this.drone;
    const v = Math.max(this.flySpeed, canHover(d) ? 0.5 : d.vMin);
    this.path = buildPath(this.world, d, { ...this.cfg, speed: v });
    if (this.path.len > 0) this.s = ((this.s || 0) % this.path.len + this.path.len) % this.path.len;
    else this.s = 0;
    this.#aimAntennas();
    this.dr = null;
    this.#updateDrone(0);
    this.prevDr = { ...this.dr };
  }

  #aimAntennas() {
    const w = this.world;
    const [cx, cz] = this.cfg.center;
    const p = w.pilot;
    const az = (Math.atan2(cz - p.z, cx - p.x) / DEG + 360) % 360;
    const dist = Math.max(30, Math.hypot(cx - p.x, cz - p.z));
    const tilt = clamp(Math.atan2(this.cfg.height * 0.6 - this.cfg.pilotH, dist) / DEG, 0, 45);
    this.pilotAxes = axesFromAzTilt(az, tilt);
    this.pilotAim = { az, tilt };
    const c = w.cellSite;
    this.cellAz0 = (Math.atan2(cz - c.z, cx - c.x) / DEG + 360) % 360;
  }

  reset() {
    this.t = 0;
    this.s = 0;
    this.sampleCarry = 0;
    this.distSinceTrack = 1e9;
    this.timeSinceTrack = 1e9;
    this.shadowZ = { pilot: gauss(this.noiseRand) * 0.5, cell: gauss(this.noiseRand) * 0.5 };
    this.track.clear();
    for (const ts of this.techStates) {
      ts.head = 0;
      ts.count = 0;
      ts.histHead = 0;
      ts.histCount = 0;
      ts.prevPm = null;
      ts.stats = null;
      ts.statsT = -1;
    }
    this.lastHeading = 0;
    this.att = { pitch: 0, roll: 0 };
    this.aglCur = undefined;
    this.dr = null;
  }

  // ------------------------------------------------------------------ stepping

  /** Advance by dt seconds of flight time. */
  step(dt) {
    let rem = Math.min(dt, 2);
    while (rem > 1e-9) {
      const h = Math.min(rem, MAX_SUB);
      this.#advance(h);
      rem -= h;
    }
  }

  #advance(h) {
    this.prevDr = { ...this.dr };
    this.t += h;
    const path = this.path;
    if (path.len > 0) {
      const v = path.vertical ? Math.min(this.flySpeed, this.drone.climb) : this.flySpeed;
      this.s = (this.s + v * h) % path.len;
    }
    this.#updateDrone(h);
    this.#largeScale(h);
    // fading samples
    const exact = h * FS + this.sampleCarry;
    const count = Math.floor(exact);
    this.sampleCarry = exact - count;
    if (count > 0) this.#samples(count);
    // track
    const moved = Math.hypot(this.dr.x - this.prevDr.x, this.dr.z - this.prevDr.z, this.dr.agl - this.prevDr.agl);
    this.distSinceTrack += moved;
    this.timeSinceTrack += h;
    if (this.distSinceTrack >= 3 || this.timeSinceTrack >= 0.5) {
      const margins = this.techStates.map((ts) => (ts.ls ? ts.ls.margin : 0));
      this.track.push(
        { x: this.dr.x, z: this.dr.z, e: this.dr.e, agl: this.dr.agl, t: this.t },
        margins,
        this.geo.pilot.state ?? 0,
        this.geo.cell.state ?? 0,
      );
      this.distSinceTrack = 0;
      this.timeSinceTrack = 0;
    }
  }

  #updateDrone(h) {
    const d = this.drone;
    const p = samplePath(this.path, this.s, this.ps || (this.ps = {}));
    let x = p.x;
    let z = p.z;
    let agl = p.agl;
    // climb/descend towards a new height setpoint at the airframe's climb rate
    if (this.aglCur === undefined) this.aglCur = agl;
    else if (h > 0) {
      const up = d.climb * 1.2 * h;
      this.aglCur += clamp(agl - this.aglCur, -1.5 * up, up);
    }
    agl = this.aglCur;
    if (this.path.hover) {
      const t = this.t;
      x += 0.35 * Math.sin(0.71 * t) + 0.1 * Math.sin(2.3 * t);
      z += 0.35 * Math.cos(0.53 * t) + 0.1 * Math.cos(1.9 * t);
      agl += 0.15 * Math.sin(0.93 * t);
    }
    const e = this.world.elevAt(x, z);
    const y = e + agl;
    const prev = this.dr;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (prev && h > 0) {
      vx = (x - prev.x) / h;
      vy = (y - prev.y) / h;
      vz = (z - prev.z) / h;
    }
    const vh = Math.hypot(vx, vz);
    let heading = this.lastHeading;
    if (!this.path.vertical && !this.path.hover && Math.hypot(p.dx, p.dz) > 1e-6) heading = Math.atan2(p.dz, p.dx);
    else if (this.path.vertical || this.path.hover) {
      const w = this.world.pilot;
      heading = Math.atan2(w.z - z, w.x - x);
    }
    // smooth heading and attitude
    const k = h > 0 ? 1 - Math.exp(-h / 0.25) : 1;
    let dh = heading - this.lastHeading;
    if (dh > Math.PI) dh -= TAU;
    if (dh < -Math.PI) dh += TAU;
    const hd = prev ? this.lastHeading + dh * k : heading;
    this.lastHeading = hd;
    const target = attitude(d, this.path.vertical ? 0 : vh, this.path.hover || this.path.vertical ? 0 : p.curv, vy);
    if (!prev) this.att = { ...target };
    this.att.pitch += (target.pitch - this.att.pitch) * k;
    this.att.roll += (target.roll - this.att.roll) * k;
    this.dr = {
      x, z, e, agl, y, vx, vy, vz,
      speed: Math.hypot(vx, vy, vz),
      heading: hd,
      pitch: this.att.pitch,
      roll: this.att.roll,
      body: bodyAxes(hd, this.att.pitch, this.att.roll),
      t: this.t,
    };
  }

  // ------------------------------------------------------------------ geometry & large scale

  #nodeOf(key) {
    const w = this.world;
    if (key === 'pilot') return { x: w.pilot.x, z: w.pilot.z, h: this.cfg.pilotH };
    return { x: w.cellSite.x, z: w.cellSite.z, h: w.cellSite.h };
  }

  #geometry(key, h) {
    const w = this.world;
    const d = this.dr;
    const g = this.geo[key];
    const n = this.#nodeOf(key);
    const eN = w.elevAt(n.x, n.z);
    const ny = eN + n.h;
    g.node = { x: n.x, y: ny, z: n.z, h: n.h, e: eN };
    w.profile(n.x, ny, n.z, d.x, d.y, d.z, g.prof);
    const dx = d.x - n.x;
    const dy = d.y - ny;
    const dz = d.z - n.z;
    const d2 = Math.hypot(dx, dz);
    const d3 = Math.max(Math.hypot(d2, dy), 0.5);
    g.d2 = d2;
    g.d3 = d3;
    g.k = [dx / d3, dy / d3, dz / d3];
    g.elev = Math.atan2(dy, d2) / DEG;

    // specular reflection on the local ground plane (two iterations to find its height)
    let ep = 0.5 * (eN + d.e);
    let valid = true;
    let px = n.x;
    let pz = n.z;
    let h1 = 0;
    let h2 = 0;
    for (let it = 0; it < 2; it++) {
      h1 = ny - ep;
      h2 = d.y - ep;
      if (h1 < 0.3 || h2 < 0.3) {
        valid = false;
        break;
      }
      const d1 = d2 > 1e-3 ? (d2 * h1) / (h1 + h2) : 0;
      px = d2 > 1e-3 ? n.x + (dx / d2) * d1 : n.x;
      pz = d2 > 1e-3 ? n.z + (dz / d2) * d1 : n.z;
      ep = w.elevAt(px, pz);
    }
    const refl = g.refl || (g.refl = {});
    refl.valid = valid;
    if (valid) {
      h1 = ny - ep;
      h2 = d.y - ep;
      refl.ep = ep;
      refl.h1 = h1;
      refl.px = px;
      refl.pz = pz;
      refl.psi = Math.atan2(h1 + h2, Math.max(d2, 1e-3));
      const rDir = Math.hypot(d2, h2 - h1);
      const rRef = Math.hypot(d2, h1 + h2);
      refl.ratio = rDir / rRef;
      refl.delta = rRef - rDir;
      refl.surface = w.surfaceAt(px, pz);
      const a = Math.hypot(px - n.x, ep - ny, pz - n.z) || 1;
      refl.dirTx = [(px - n.x) / a, (ep - ny) / a, (pz - n.z) / a];
      const b = Math.hypot(px - d.x, ep - d.y, pz - d.z) || 1;
      refl.dirRx = [(px - d.x) / b, (ep - d.y) / b, (pz - d.z) / b];
    }

    // environment around both terminals
    const envN = w.envAt(n.x, n.z);
    const envD = w.envAt(d.x, d.z);
    const clD = w.clutterAt(d.x, d.z);
    const clN = w.clutterAt(n.x, n.z);
    const droneIn = d.agl < clD + 15;
    const nodeIn = n.h < clN + 3;
    let env;
    if (droneIn && nodeIn) env = worse(envD, envN);
    else if (droneIn) env = envD;
    else if (nodeIn) env = envN;
    else env = better(envD, envN);
    g.env = env;
    g.envDrone = envD;
    g.envNode = envN;
    g.clutterDrone = clD;
    g.immersion = droneIn ? 6 * clamp(1 - d.agl / (clD + 15), 0, 1) : 0;

    // shadowing: unit Gauss-Markov process over distance travelled (Gudmundson)
    const moved = this.prevDr ? Math.hypot(d.x - this.prevDr.x, d.z - this.prevDr.z, d.y - this.prevDr.y) : 0;
    if (h > 0) {
      const rho = Math.exp(-moved / ENVS[env].dcorr);
      this.shadowZ[key] = rho * this.shadowZ[key] + Math.sqrt(1 - rho * rho) * gauss(this.noiseRand);
    }
    g.shadowZ = this.shadowZ[key];

    // drone velocity along the ray (positive = receding)
    g.vRad = d.vx * g.k[0] + d.vy * g.k[1] + d.vz * g.k[2];
    g.state = STATE.LOS;
    return g;
  }

  #largeScale(h) {
    this.#geometry('pilot', h);
    this.#geometry('cell', h);
    const statePerNode = { pilot: -1, cell: -1 };
    for (const ts of this.techStates) {
      ts.ls = this.#techLink(ts);
      const node = ts.tech.node;
      // node state from the 2.4 GHz-ish reference: take the first tech evaluated per node
      if (statePerNode[node] < 0) statePerNode[node] = ts.ls.state;
    }
    this.geo.pilot.state = statePerNode.pilot;
    this.geo.cell.state = statePerNode.cell;
  }

  #gsAntenna(tech) {
    if (tech.node === 'cell') return ANTENNAS[tech.gsAnt];
    return ANTENNAS[this.cfg.gsAnt === 'auto' ? tech.gsAnt : this.cfg.gsAnt] || ANTENNAS[tech.gsAnt];
  }

  #airAntenna(tech) {
    return ANTENNAS[this.cfg.airAnt === 'auto' ? tech.airAnt : this.cfg.airAnt] || ANTENNAS[tech.airAnt];
  }

  /** Large-scale link of one technology; everything the sampler and the UI need. */
  #techLink(ts) {
    const tech = ts.tech;
    const cfg = this.cfg;
    const g = this.geo[tech.node];
    const d = this.dr;
    const f = tech.f[cfg.region];
    const lambda = C0 / f;
    const tx = tech.tx[cfg.region];
    const gsAnt = this.#gsAntenna(tech);
    const airAnt = this.#airAntenna(tech);
    const k = g.k;
    const back = [-k[0], -k[1], -k[2]];

    // ground antenna orientation and gains
    let gsAxes;
    if (gsAnt.sectors) {
      const sg = sectorGain(gsAnt, this.cellAz0, k);
      gsAxes = axesFromAzTilt(sg.az, gsAnt.tilt || 0);
    } else if (gsAnt.tracking) {
      gsAxes = axesFromAzTilt(Math.atan2(k[2], k[0]) / DEG + 1.5, Math.asin(clamp(k[1], -1, 1)) / DEG - 1.5);
    } else if (gsAnt.kind === 'dir' || gsAnt.kind === 'steer') {
      gsAxes = this.pilotAxes;
    } else {
      gsAxes = axesFromAzTilt(0, 0);
    }
    const gGs = gainWorld(gsAnt, gsAxes, k);
    const gsPol = polOf(gsAnt, gsAxes);
    const refl = g.refl;
    const gGsRef = refl.valid ? gainWorld(gsAnt, gsAxes, refl.dirTx) : -99;

    // airborne branches
    const branches = branchesOf(airAnt).map((b) => {
      const axes = mountAxes(b.mount, d.body);
      const pol = polOf(airAnt, axes);
      return {
        axes,
        g: gainWorld(airAnt, axes, back),
        gRef: refl.valid ? gainWorld(airAnt, axes, refl.dirRx) : -99,
        pol,
        lPol: polLoss(gsPol, pol, k),
      };
    });

    // path losses
    const lFs = fspl(g.d3, f);
    const nuT = g.prof.kT * Math.sqrt(2 / lambda);
    const nuB = g.prof.kB * Math.sqrt(2 / lambda);
    const lT = knifeEdge(nuT);
    const hBs = g.node.h;
    const ref3 = gpp(this.world.cellSite.model || 'UMa', g.d2, Math.max(hBs, 1.5), d.agl, f);
    const lBraw = knifeEdge(nuB);
    const lB = lBraw > 0 ? Math.min(lBraw, Math.max(6, ref3.plNlos - lFs)) : 0;
    const lV = vegetationLoss(f, g.prof.vegDepth);
    const lGas = (gasAttenuation(f) * g.d3) / 1000;
    let state = STATE.LOS;
    if (nuB > 0 && lB >= lT) state = STATE.NLOS_B;
    else if (nuT > 0) state = STATE.NLOS_T;
    else if (nuB > 0) state = STATE.NLOS_B;
    else if (g.prof.vegDepth > 1.5) state = STATE.VEG;
    else if (nuT > -0.78 || nuB > -0.78) state = STATE.FRESNEL;
    const obstructed = state === STATE.NLOS_B || state === STATE.NLOS_T;

    // Rician K: unobstructed value for the elevation, minus what attenuates the coherent part
    let kDb = kFactorDb(g.elev, g.env, f) - g.immersion - lT - lB - 0.8 * lV;
    if (nuT > 1 || nuB > 1) kDb = -Infinity;
    const K = kDb < -15 ? 0 : Math.pow(10, kDb / 10);

    // shadowing (same unit process for all bands of a node → correlated)
    const sigma = cfg.shadowing ? shadowSigma(g.env, obstructed, d.agl, lV) : 0;
    const shadow = sigma * g.shadowZ;

    // ground reflection coefficient (relative to the direct ray, incl. antenna gains)
    let gr = 0;
    let gi = 0;
    if (refl.valid && K > 0) {
      const pol = reflectionPol(gsPol, branches[0].pol);
      const [rr, ri] = groundReflection(refl.psi, f, refl.surface.epsR, refl.surface.sigma, pol);
      const rho = roughnessFactor(refl.psi, f, refl.surface.rough) * refl.surface.factor * (obstructed || state === STATE.VEG ? 0.3 : 1);
      const amp = rho * refl.ratio * Math.pow(10, (gGsRef - gGs + branches[0].gRef - branches[0].g) / 20);
      gr = rr * amp;
      gi = ri * amp;
    }

    // noise, unlicensed noise rise and cellular interference
    const nDbm = noiseFloor(tech.bw, tech.nf);
    let rise = 0;
    if (cfg.interference && tech.ism) {
      const rxAir = tech.rx === 'air';
      const envRx = rxAir ? g.envDrone : g.envNode;
      const hRx = rxAir ? d.agl : g.node.h;
      const [r0, r1] = ENVS[envRx].ism;
      rise = (r0 + r1 * Math.log10(Math.max(1, hRx / 10))) * ISM_FACTOR[tech.ism];
    }
    const nLin = Math.pow(10, (nDbm + rise) / 10);
    let iLin = 0;
    if (cfg.interference && tech.node === 'cell') {
      const site = this.world.cellSite;
      iLin = neighbourInterference({
        site: [site.x, site.z],
        isd: site.isd || 500,
        model: site.model || 'UMa',
        hBS: Math.max(site.h, 10),
        ant: gsAnt,
        txDbm: tx,
        f,
        load: cfg.load,
        drone: [d.x, d.agl, d.z],
        airGain: (dir) => gainWorld(airAnt, branches[0].axes, dir),
      });
      // the virtual neighbours are statistical (3GPP) and know no forest: a drone inside the
      // canopy also sees their low-elevation signals through the trees
      if (g.envDrone === 'forest' && d.agl < g.clutterDrone) {
        iLin *= Math.pow(10, -vegetationLoss(f, 60 * (1 - d.agl / g.clutterDrone)) / 10);
      }
    }

    // Doppler and delay spread
    const fLos = -g.vRad / lambda;
    const envMin = g.env === 'forest' ? 3 : g.env === 'urban' || g.env === 'dense' ? 1 : 0.3;
    const fdMax = d.speed / lambda + envMin;
    const ds = delaySpread(g.env, obstructed, d.agl, g.clutterDrone) * (airAnt.narrowBeam || gsAnt.narrowBeam ? 0.3 : 1);
    const bc = 1 / (5 * ds);
    const L = clamp(Math.round(tech.bw / bc), 1, SUBBANDS);

    // mean received power per branch
    const base = tx + gGs - lFs - lT - lB - lV - lGas + shadow;
    const pm = branches.map((b) => base + b.g - b.lPol);
    // large-scale (fading-free) SINR including the current two-ray state
    const ph = (TAU * (refl.valid ? refl.delta : 0)) / lambda;
    const twr = 1 + gr * Math.cos(ph) + gi * Math.sin(ph);
    const twi = gi * Math.cos(ph) - gr * Math.sin(ph);
    const tw2 = twr * twr + twi * twi;
    const twoRayDb = 10 * Math.log10((K * tw2 + 1) / (K + 1));
    let bestPm = -Infinity;
    let bestB = 0;
    pm.forEach((p, i) => {
      if (p > bestPm) {
        bestPm = p;
        bestB = i;
      }
    });
    const sLin = Math.pow(10, (bestPm + twoRayDb) / 10);
    const snrLs = sLin / nLin;
    const sinrLs = sLin / (nLin + iLin);
    const mode0 = tech.modes[pickMode(tech, 10 * Math.log10(sinrLs))];
    const imp = impairments(tech, mode0, fdMax, K, ds);
    const sinrLsImp = 1 / (1 / sinrLs + imp.total);
    const sinrLsDb = 10 * Math.log10(sinrLsImp);
    const modeIdx = pickMode(tech, sinrLsDb);
    const mode = tech.modes[modeIdx];
    const minSnr = Math.min(...tech.modes.map((m) => m.snr));

    // up-link of cellular links: same channel, different budget
    let ul = null;
    if (tech.ul) {
      const gainDb = tech.ul.tx - tx + 10 * Math.log10(tech.bw / tech.ul.bw) + tech.nf - tech.ul.nf - tech.ul.iot;
      const ulLsDb = 10 * Math.log10(1 / (1 / (snrLs * Math.pow(10, gainDb / 10)) + imp.total));
      ul = { gainLin: Math.pow(10, gainDb / 10), lsDb: ulLsDb, mode: tech.modes[pickMode(tech, ulLsDb)] };
    }

    const alh = alHourani(g.env === 'dense' ? 'dense' : g.env === 'urban' ? 'urban' : 'suburban', Math.max(g.elev, 0), g.d3, f);
    const hybridPl = lFs + lT + lB + lV + lGas - twoRayDb - shadow;

    const kc = K / (K + 1);
    const g2 = gr * gr + gi * gi;
    const compTotal = kc + kc * g2 + 1 / (K + 1);

    return {
      f, lambda, tx, gsAnt, airAnt, gGs, gsAxes, branches, bestB, pm,
      lFs, lT, lB, lV, lGas, nuT, nuB, state, obstructed,
      K, kDb, shadow, sigma, gr, gi, twoRayDb,
      nDbm, rise, nLin, iLin, interfDb: 10 * Math.log10((nLin + iLin) / Math.pow(10, nDbm / 10)),
      sirDb: iLin > 0 ? 10 * Math.log10(sLin / iLin) : Infinity,
      fLos, fdMax, ds, bc, L, imp, impDb: 10 * Math.log10(sinrLs / sinrLsImp),
      snrLsDb: 10 * Math.log10(snrLs), sinrLsDb, mode, modeIdx, minSnr, margin: sinrLsDb - minSnr,
      ul, ref3, alh, hybridPl,
      prx: bestPm + twoRayDb,
      comp: { direct: kc / compTotal, specular: (kc * g2) / compTotal, diffuse: 1 / (K + 1) / compTotal },
    };
  }

  // ------------------------------------------------------------------ samples

  #samples(count) {
    count = Math.min(count, 4096);
    const prev = this.prevDr;
    const cur = this.dr;
    // two-ray path difference per sample and node (drone position interpolated)
    for (const key of ['pilot', 'cell']) {
      const g = this.geo[key];
      const buf = this.deltaBuf[key];
      if (!g.refl.valid) {
        buf.fill(0, 0, count);
        continue;
      }
      const { h1, ep } = g.refl;
      const nx = g.node.x;
      const nz = g.node.z;
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / count;
        const x = prev.x + (cur.x - prev.x) * t;
        const z = prev.z + (cur.z - prev.z) * t;
        const y = prev.y + (cur.y - prev.y) * t;
        const dd = Math.hypot(x - nx, z - nz);
        const h2 = Math.max(y - ep, 0.3);
        buf[i] = Math.hypot(dd, h1 + h2) - Math.hypot(dd, h2 - h1);
      }
    }
    const fading = this.cfg.fading;
    const dt = 1 / FS;
    for (const ts of this.techStates) {
      const ls = ts.ls;
      const tech = ts.tech;
      const nb = ls.branches.length;
      const L = ls.L;
      const prevPm = ts.prevPm || ls.pm;
      const K = ls.K;
      const kc = K / (K + 1);
      const kd = 1 / (K + 1);
      const delta = this.deltaBuf[tech.node];
      const kw = TAU / ls.lambda;
      const nLin = ls.nLin;
      const iOverN = ls.iLin / nLin;
      const imp = ls.imp.total;
      const slope = tech.slope;
      const mode = ls.mode;
      const rate = modeRate(tech, mode);
      const ul = ls.ul;
      const ulRate = ul ? ul.mode.eff * tech.ul.bw * tech.ul.overhead : 0;
      if (fading) {
        for (let b = 0; b < nb; b++) for (let l = 0; l < L; l++) ts.procs[b][l].generate(ls.fdMax, dt, count, this.re[b][l], this.im[b][l]);
      }
      const dphi = TAU * ls.fLos * dt;
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / count;
        const ph = kw * delta[i];
        const c = Math.cos(ph);
        const s = Math.sin(ph);
        const twr = 1 + ls.gr * c + ls.gi * s;
        const twi = ls.gi * c - ls.gr * s;
        ts.losPhase += dphi;
        let best = 0;
        let nbPow = 0;
        for (let b = 0; b < nb; b++) {
          const pmDb = prevPm[b] + (ls.pm[b] - prevPm[b]) * t;
          const pLin = Math.pow(10, pmDb / 10);
          let snrEff;
          if (fading) {
            const ac = Math.sqrt(pLin * kc);
            const ad = Math.sqrt(pLin * kd);
            const lp = ts.losPhase + ts.brOff[b];
            const cl = Math.cos(lp);
            const sl = Math.sin(lp);
            const cr = ac * (twr * cl - twi * sl);
            const ci = ac * (twr * sl + twi * cl);
            let cap = 0;
            const re = this.re[b];
            const im = this.im[b];
            for (let l = 0; l < L; l++) {
              const rr = cr + ad * re[l][i];
              const ri = ci + ad * im[l][i];
              const p = rr * rr + ri * ri;
              if (b === 0 && l === 0) nbPow = p;
              cap += Math.log2(1 + p / nLin);
            }
            snrEff = Math.pow(2, cap / L) - 1;
          } else {
            const p = pLin * (kc * (twr * twr + twi * twi) + kd);
            if (b === 0) nbPow = p;
            snrEff = p / nLin;
          }
          if (snrEff > best) best = snrEff;
        }
        const sinr = 1 / ((1 + iOverN) / Math.max(best, 1e-30) + imp);
        const sinrDb = 10 * Math.log10(sinr);
        const per = perAt(sinrDb, mode.snr, slope);
        const h = ts.head;
        ts.eff[h] = sinrDb;
        // narrow-band, single antenna, same interference and impairments: differs only by diversity
        ts.nb[h] = 10 * Math.log10(1 / ((1 + iOverN) / Math.max(nbPow / nLin, 1e-30) + imp));
        ts.per[h] = per;
        ts.thr[h] = rate * (1 - per);
        if (ul) {
          const ulS = 1 / (1 / Math.max(best * ul.gainLin, 1e-30) + imp);
          const ulDb = 10 * Math.log10(ulS);
          const perUl = perAt(ulDb, ul.mode.snr, slope);
          ts.perUl[h] = perUl;
          ts.thrUl[h] = ulRate * (1 - perUl);
        }
        ts.head = (h + 1) % W;
        if (ts.count < W) ts.count++;
        if (++ts.decim >= HIST_DECIM) {
          ts.decim = 0;
          ts.hist[ts.histHead] = sinrDb;
          ts.histMean[ts.histHead] = ls.sinrLsDb;
          ts.histHead = (ts.histHead + 1) % H;
          if (ts.histCount < H) ts.histCount++;
        }
      }
      ts.losPhase %= TAU;
      ts.prevPm = ls.pm.slice();
    }
  }

  // ------------------------------------------------------------------ read-out

  /** Chronological copy of the 5 s window (effective SINR and narrow-band single-antenna SNR, dB). */
  window(idx) {
    const ts = this.techStates[idx];
    const n = ts.count;
    const eff = new Float32Array(n);
    const nb = new Float32Array(n);
    const start = (ts.head - n + W) % W;
    for (let i = 0; i < n; i++) {
      eff[i] = ts.eff[(start + i) % W];
      nb[i] = ts.nb[(start + i) % W];
    }
    return { eff, nb, fs: FS };
  }

  /** Chronological 30 s history at FS/HIST_DECIM Hz. */
  history(idx) {
    const ts = this.techStates[idx];
    const n = ts.histCount;
    const v = new Float32Array(n);
    const m = new Float32Array(n);
    const start = (ts.histHead - n + H) % H;
    for (let i = 0; i < n; i++) {
      v[i] = ts.hist[(start + i) % H];
      m[i] = ts.histMean[(start + i) % H];
    }
    return { v, m, rate: FS / HIST_DECIM };
  }

  /** 5 s statistics of a technology (cached per sim time). */
  stats(idx) {
    const ts = this.techStates[idx];
    if (ts.statsT === this.t && ts.stats) return ts.stats;
    const n = ts.count;
    const ls = ts.ls;
    if (!n || !ls) return null;
    const BIN = 0.25;
    const LO = -80;
    const NB = 800;
    const hist = new Uint32Array(NB);
    const histNb = new Uint32Array(NB);
    let lin = 0;
    let per = 0;
    let thr = 0;
    let perUl = 0;
    let thrUl = 0;
    let out = 0;
    const nbLin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const e = ts.eff[i];
      lin += Math.pow(10, e / 10);
      per += ts.per[i];
      thr += ts.thr[i];
      perUl += ts.perUl[i];
      thrUl += ts.thrUl[i];
      if (e < ls.minSnr) out++;
      hist[clamp(Math.floor((e - LO) / BIN), 0, NB - 1)]++;
      histNb[clamp(Math.floor((ts.nb[i] - LO) / BIN), 0, NB - 1)]++;
      nbLin[i] = Math.pow(10, ts.nb[i] / 10);
    }
    const pct = (hst, q) => {
      const target = q * n;
      let acc = 0;
      for (let b = 0; b < NB; b++) {
        acc += hst[b];
        if (acc >= target) return LO + (b + 0.5) * BIN;
      }
      return LO + NB * BIN;
    };
    const snr10 = pct(hist, 0.1);
    const nb50 = pct(histNb, 0.5);
    const s = {
      n,
      snrMean: 10 * Math.log10(lin / n),
      snr1: pct(hist, 0.01),
      snr10,
      snr50: pct(hist, 0.5),
      per: per / n,
      thr: thr / n,
      outage: out / n,
      fadeDepth: nb50 - pct(histNb, 0.01),
      kFit: estimateK(nbLin, n),
      interfDb: ls.interfDb,
      sirDb: ls.sirDb,
      riseDb: ls.rise,
      imp: ls.imp,
      impDb: ls.impDb,
      pathLoss: ls.hybridPl,
    };
    s.effFade = s.snr50 - s.snr1;
    if (ts.tech.ul) {
      s.perUl = perUl / n;
      s.thrUl = thrUl / n;
    }
    s.losses = [
      { label: 'buildings', value: ls.lB },
      { label: 'terrain', value: ls.lT },
      { label: 'vegetation', value: ls.lV },
    ];
    s.verdict = judge(ts.tech, s);
    ts.stats = s;
    ts.statsT = this.t;
    return s;
  }
}

export { World };
