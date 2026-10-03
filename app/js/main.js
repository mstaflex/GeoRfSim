/* GeoRfSim – application controller: state, controls, render loop, panels. */
import { World } from './world.js';
import { SCENARIOS, SCENARIO_BY_ID } from './scenarios.js';
import { DRONES, DRONE_BY_ID, PATTERNS, PATTERN_BY_ID, canHover } from './flight.js';
import { Simulation, STATE_LABELS, HIST_S } from './sim.js';
import {
  loadCustomDrones, customDrones, registerDrone, saveCustomDrones, encodeProfile, decodeProfile, encodeDrone, decodeDrone,
} from './profiles.js';
import { FlightEditor } from './ui/flight-editor.js';
import { DroneEditor } from './ui/drone-editor.js';
import { PilotUI } from './ui/pilot.js';
import { ModelPanel } from './ui/model-panel.js';
import { $, el } from './ui/dom.js';
import { BUILD } from './version.js';
import { TECHS } from './rf/tech.js';
import {
  ANTENNAS, GROUND_ANTENNA_IDS, AIR_ANTENNA_IDS, axesFromAzTilt, gainWorld, gainLocal, airGainBody, sectorGain,
} from './rf/antennas.js';
import { ENVS, encodeModel, decodeModel, modelChanges } from './rf/models.js';
import { Renderer } from './gfx/renderer.js';
import { OrbitCamera, CameraControls } from './gfx/camera.js';
import { rampColor } from './gfx/meshes.js';
import { DistChart, HistoryChart, PolarChart, Minimap, COL } from './charts.js';
import { clamp, fmtHz, fmtRate, fmtDist, fmtPct } from './util.js';

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
const css = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
const sign = (v, d = 1) => (Number.isFinite(v) ? `${v > 0.049 ? '+' : v < -0.049 ? '−' : ''}${Math.abs(v).toFixed(d)}` : '–');
const num = (v, d = 1) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}` : '–');

const WARPS = [0.25, 0.5, 1, 2, 5, 10, 20];
const HEIGHT_PRESETS = [2, 10, 30, 60, 120, 300];
const STATE_COLORS = [COL.s1, COL.s2, COL.s3, COL.s4, COL.s5];
const MARGIN_BUCKETS = [
  [6, COL.good, '≥ 6 dB'],
  [0, COL.warning, '0 … 6 dB'],
  [-6, COL.serious, '−6 … 0 dB'],
  [-Infinity, COL.critical, '< −6 dB'],
];
const ANT_ID = new Map(Object.entries(ANTENNAS).map(([k, v]) => [v, k]));
const CAMS = [['orbit', 'Orbit'], ['follow', 'Follow'], ['chase', 'Chase'], ['top', 'Top'], ['pilot', 'Pilot view'], ['fpv', 'FPV']];
const PLACES = [['center', 'Pattern centre'], ['pilot', 'Pilot'], ['cell', 'Cell site']];

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: settings simply aren't remembered */
    }
  },
};

const DEFAULT_VIEW = {
  scale: 'log', h0: null, gain: null, terrK: null, treeScale: 1, trackColor: 'margin', dpr: 2,
  layers: { trees: true, buildings: true, track: true, drops: true, los: true, refl: true, lobes: true, grid: true, xray: true, labels: true },
};

const savedView = store.get('georfsim.view', {});
let modelPanel = null; // settings → model parameters (built with the settings drawer)
const state = {
  scenario: 'urban',
  primary: 'wifi24',
  playing: true,
  warp: 1,
  camMode: 'follow',
  place: null,
  cfg: {
    drone: 'prosumer', pattern: 'route', speed: 8, height: 15, size: 400, heading: 0, center: [0, 0], avoid: true, profileId: null, profile: null,
    altRef: 'agl', clearance: 10,
    region: 'eu', gsAnt: 'auto', airAnt: 'auto', pilotH: 1.5, interference: true, load: 0.5, shadowing: true, fading: true,
  },
  view: { ...DEFAULT_VIEW, ...savedView, layers: { ...DEFAULT_VIEW.layers, ...(savedView.layers || {}) } },
};

// ------------------------------------------------------------------ URL state (shareable links)

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const out = { cfg: {} };
  // a custom drone or flight profile may travel inside the link
  if (h.has('dc')) {
    const d = decodeDrone(h.get('dc'));
    if (d) {
      registerDrone(d);
      saveCustomDrones();
    }
  }
  if (h.has('fp')) {
    const p = decodeProfile(h.get('fp'));
    if (p && p.waypoints.length) out.profile = p;
  }
  const s = h.get('s');
  if (s && SCENARIO_BY_ID[s]) out.scenario = s;
  const map = { d: 'drone', p: 'pattern', ga: 'gsAnt', aa: 'airAnt', r: 'region' };
  for (const [k, key] of Object.entries(map)) if (h.has(k)) out.cfg[key] = h.get(k);
  const nums = { v: 'speed', h: 'height', z: 'size', hd: 'heading', ph: 'pilotH', cl: 'clearance' };
  for (const [k, key] of Object.entries(nums)) if (h.has(k) && Number.isFinite(+h.get(k))) out.cfg[key] = +h.get(k);
  if (h.has('c')) {
    const c = h.get('c').split(',').map(Number);
    if (c.length === 2 && c.every(Number.isFinite)) out.cfg.center = c;
  }
  if (out.cfg.drone && !DRONE_BY_ID[out.cfg.drone]) delete out.cfg.drone;
  if (out.cfg.pattern && !PATTERN_BY_ID[out.cfg.pattern]) delete out.cfg.pattern;
  if (out.cfg.pattern === 'custom') {
    if (out.profile) Object.assign(out.cfg, { profileId: out.profile.id, profile: out.profile });
    else delete out.cfg.pattern;
  }
  if (out.cfg.gsAnt && out.cfg.gsAnt !== 'auto' && !GROUND_ANTENNA_IDS.includes(out.cfg.gsAnt)) delete out.cfg.gsAnt;
  if (out.cfg.airAnt && out.cfg.airAnt !== 'auto' && !AIR_ANTENNA_IDS.includes(out.cfg.airAnt)) delete out.cfg.airAnt;
  if (out.cfg.region && !['eu', 'us'].includes(out.cfg.region)) delete out.cfg.region;
  if (h.get('ar') === 'baro') out.cfg.altRef = 'baro';
  if ('clearance' in out.cfg) out.cfg.clearance = clamp(out.cfg.clearance, 1, 100);
  if (h.has('m')) decodeModel(h.get('m'));
  const t = h.get('t');
  if (t && TECHS.some((x) => x.id === t)) out.primary = t;
  return out;
}

/** Hash parameters of a setup; `,` `;` `~` stay readable (they are legal in a fragment). */
function hashOf({ scenario = state.scenario, cfg = state.cfg, primary = state.primary } = {}) {
  const c = cfg;
  const p = {
    s: scenario, d: c.drone, p: c.pattern, v: +c.speed.toFixed(1), h: +c.height.toFixed(1), z: Math.round(c.size),
    hd: Math.round(c.heading), c: c.center.map((v) => Math.round(v)).join(','), t: primary, r: c.region,
    ga: c.gsAnt, aa: c.airAnt, ph: c.pilotH,
  };
  if (c.altRef === 'baro') p.ar = 'baro';
  if (c.clearance !== 10) p.cl = c.clearance;
  const model = encodeModel();
  if (model) p.m = model;
  const drone = DRONE_BY_ID[c.drone];
  if (drone?.custom) p.dc = encodeDrone(drone);
  if (c.pattern === 'custom' && c.profile) p.fp = encodeProfile(c.profile);
  return Object.entries(p)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3B/gi, ';').replace(/%3A/gi, ':')}`)
    .join('&');
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, '', `#${hashOf()}`), 250);
}

const linkWith = (over) => `${location.origin}${location.pathname}#${hashOf(over)}`;

function saveView() {
  store.set('georfsim.view', state.view);
}

// ------------------------------------------------------------------ setup

const canvas = $('gl');
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  const f = $('fatal');
  f.hidden = false;
  f.textContent = `The 3-D view needs WebGL2, which this browser could not provide (${err.message}).`;
  throw err;
}
const cam = new OrbitCamera();
const worlds = new Map();
function getWorld(id) {
  if (!worlds.has(id)) {
    const w = new World(SCENARIO_BY_ID[id]);
    w.pilot0 = { ...w.pilot };
    w.cellSite0 = { ...w.cellSite };
    worlds.set(id, w);
    if (worlds.size > 3) worlds.delete(worlds.keys().next().value);
  }
  return worlds.get(id);
}

loadCustomDrones();
const fromHash = readHash();
if (fromHash.scenario) state.scenario = fromHash.scenario;
const scn0 = SCENARIO_BY_ID[state.scenario];
applyScenarioDefaults(scn0);
Object.assign(state.cfg, fromHash.cfg);
if (fromHash.primary) state.primary = fromHash.primary;
else state.primary = defaultPrimary(state.scenario);

const sim = new Simulation(getWorld(state.scenario), state.cfg);

// what the editors and the free-flight UI may use (functions are hoisted; nothing runs before the page is set up)
const ui = {
  sim,
  state,
  get flightEditor() {
    return flightEditor;
  },
  setCfg: (partial, restart) => setCfg(partial, restart),
  setCam: (mode) => setCam(mode),
  syncControls: () => syncControls(),
  toast: (msg) => toast(msg),
  markDirty: () => {
    dirty = true;
  },
  drone: () => DRONE_BY_ID[state.cfg.drone],
  droneOf: () => DRONE_BY_ID[state.cfg.drone],
  pick: (x, y) => renderer.pick(x, y),
  project: (x, z, agl) => renderer.project(renderer.display(x, z, sim.world.elevAt(x, z), agl)),
  canvasRect: () => canvas.getBoundingClientRect(),
  onDrawer: (name, open) => onDrawer(name, open),
  flyProfile: (p) => flyProfile(p),
  profileEdited: (p) => profileEdited(p),
  profileRemoved: (id) => profileRemoved(id),
  refreshPatterns: () => refreshPatterns(),
  linkFor: (p) => linkWith({
    scenario: SCENARIO_BY_ID[p.scenario] ? p.scenario : state.scenario,
    cfg: { ...state.cfg, pattern: 'custom', profileId: p.id, profile: p },
  }),
  setDrone: (id) => setDrone(id),
  droneEdited: (d) => droneEdited(d),
  droneRemoved: (id) => droneRemoved(id),
  refreshDrones: () => refreshDrones(),
  linkForDrone: (d) => linkWith({ cfg: { ...state.cfg, drone: d.id, speed: d.vCruise } }),
};
const flightEditor = new FlightEditor(ui);
const droneEditor = new DroneEditor(ui);
const pilot = new PilotUI(ui);
if (fromHash.profile) flightEditor.upsert(fromHash.profile);
const distChart = new DistChart($('chart-dist'), $('tip-dist'));
const histChart = new HistoryChart($('chart-hist'), $('tip-hist'));
const polarChart = new PolarChart($('chart-polar'));
const minimap = new Minimap($('minimap'), (x, z) => {
  if (state.place) placeAt(x, z);
  else if (flightEditor.mapEdit) flightEditor.addAt(x, z);
  else {
    const w = sim.world;
    cam.mode = 'orbit';
    state.camMode = 'orbit';
    cam.target = renderer.display(x, z, w.elevAt(x, z), 0);
    syncCamButtons();
  }
  dirty = true;
});
let dirty = true;

function applyScenarioDefaults(scn) {
  const d = scn.defaults;
  Object.assign(state.cfg, {
    drone: d.drone, pattern: d.pattern, height: d.height, speed: d.speed, size: d.size, center: d.center.slice(), heading: 0,
  });
}

function defaultPrimary(id) {
  return { open: 'video58', forest: 'elrs24', urban: 'wifi24', suburban: 'video58', valley: 'lte800', lake: 'video58' }[id] || 'wifi24';
}

function primaryIdx() {
  return Math.max(0, TECHS.findIndex((t) => t.id === state.primary));
}

function applyMapping() {
  const v = state.view;
  const scn = SCENARIO_BY_ID[state.scenario];
  renderer.setMapping({
    mode: v.scale, h0: v.h0 ?? scn.view.h0, gain: v.gain ?? scn.view.gain, terrK: v.terrK ?? scn.terrainExag, treeScale: v.treeScale,
  });
  renderer.layers = { ...v.layers };
  renderer.maxDpr = v.dpr;
  dirty = true;
}

function loadScenario(id, { defaults = true } = {}) {
  state.scenario = id;
  const scn = SCENARIO_BY_ID[id];
  const world = getWorld(id);
  world.pilot = { ...world.pilot0 };
  world.cellSite = { ...world.cellSite0 };
  if (defaults) {
    applyScenarioDefaults(scn);
    state.view.terrK = null;
    state.view.gain = null;
    state.view.h0 = null;
    state.primary = defaultPrimary(id);
  }
  sim.cfg = { ...sim.cfg, ...state.cfg };
  sim.setWorld(world);
  renderer.setWorld(world);
  applyMapping();
  minimap.setWorld(world, renderer.texImage);
  const [cx, cz] = state.cfg.center;
  cam.frame(world.S, renderer.display(cx, cz, world.elevAt(cx, cz), 0));
  cam.dist = world.S * (state.camMode === 'follow' ? 0.38 : 0.75);
  cam.mode = state.camMode;
  refreshPatterns();
  if (flightEditor.isOpen) flightEditor.render();
  syncControls();
  writeHash();
  dirty = true;
}

/** Flight/radio config change. restart = new flight (track cleared). */
function setCfg(partial, restart = false) {
  Object.assign(state.cfg, partial);
  if (restart) {
    sim.cfg = { ...sim.cfg, ...state.cfg };
    sim.reset();
    sim.rebuild();
  } else {
    sim.configure(partial);
  }
  if (flightEditor.isOpen && ('altRef' in partial || 'clearance' in partial)) flightEditor.render();
  syncControls();
  writeHash();
  dirty = true;
}

// the simulation flies its own copy, so edits only take effect through setCfg
const cloneProfile = (p) => ({ ...p, waypoints: p.waypoints.map((w) => ({ ...w })) });

/** Flies a flight profile; one made for another map switches there first (keeping the drone). */
function flyProfile(p) {
  if (!p || !p.waypoints.length) return;
  if (SCENARIO_BY_ID[p.scenario] && p.scenario !== state.scenario) {
    const drone = state.cfg.drone;
    loadScenario(p.scenario);
    state.cfg.drone = drone;
  }
  setCfg({ pattern: 'custom', profileId: p.id, profile: cloneProfile(p) }, true);
  toast(`Flying “${p.name}”`);
}

function profileEdited(p) {
  if (state.cfg.pattern === 'custom' && state.cfg.profileId === p.id) setCfg({ profile: cloneProfile(p) });
  refreshPatterns();
}

function profileRemoved(id) {
  if (state.cfg.pattern === 'custom' && state.cfg.profileId === id) {
    setCfg({ pattern: SCENARIO_BY_ID[state.scenario].defaults.pattern, profileId: null, profile: null }, true);
  }
}

function setDrone(id) {
  const d = DRONE_BY_ID[id];
  if (!d) return;
  // in free flight the new airframe takes over in the air
  setCfg({ drone: d.id, speed: d.vCruise }, !sim.free);
  toast(`${d.name}: cruise ${d.vCruise} m/s, max ${d.vMax} m/s`);
  if (droneEditor.isOpen) droneEditor.render();
  if (flightEditor.isOpen) flightEditor.render();
}

/** A custom drone changed in the editor: if it is flying, its path and limits follow at once. */
function droneEdited(d) {
  if (state.cfg.drone !== d.id) return;
  state.cfg.speed = clamp(state.cfg.speed, d.vMin || 0, d.vMax);
  sim.configure({ speed: state.cfg.speed });
  sim.rebuild();
  if (flightEditor.isOpen) flightEditor.render();
  syncControls();
  writeHash();
  dirty = true;
}

function droneRemoved(id) {
  if (state.cfg.drone === id) setDrone(SCENARIO_BY_ID[state.scenario].defaults.drone);
}

// ------------------------------------------------------------------ top-bar controls

const selScenario = $('sel-scenario');
const selDrone = $('sel-drone');
const selPattern = $('sel-pattern');
const rngSpeed = $('rng-speed');
const rngHeight = $('rng-height');
const rngSize = $('rng-size');
const selWarp = $('sel-warp');
const selPrimary = $('sel-primary');

SCENARIOS.forEach((s, i) => {
  const o = new Option(`${i + 1} · ${s.name}`, s.id);
  o.title = s.blurb;
  selScenario.append(o);
});
function optgroup(label, options) {
  const g = document.createElement('optgroup');
  g.label = label;
  g.append(...options);
  return g;
}

function refreshDrones() {
  selDrone.textContent = '';
  const builtIn = DRONES.map((d) => new Option(d.name, d.id));
  const customs = customDrones();
  if (customs.length) selDrone.append(optgroup('Built-in', builtIn), optgroup('Custom', customs.map((d) => new Option(d.name, d.id))));
  else selDrone.append(...builtIn);
  selDrone.value = state.cfg.drone;
}

/** Patterns, then the flight profiles of this map, then those made for other maps. */
function refreshPatterns() {
  selPattern.textContent = '';
  selPattern.append(optgroup('Patterns', PATTERNS.map((p) => new Option(p.name, p.id))));
  const opt = (p, suffix = '') => {
    const o = new Option(`${p.name}${suffix}${p.waypoints.length ? '' : ' (no waypoints)'}`, `fp:${p.id}`);
    o.disabled = !p.waypoints.length;
    return o;
  };
  const here = flightEditor.profiles.filter((p) => !SCENARIO_BY_ID[p.scenario] || p.scenario === state.scenario);
  const other = flightEditor.profiles.filter((p) => SCENARIO_BY_ID[p.scenario] && p.scenario !== state.scenario);
  if (here.length) selPattern.append(optgroup('Flight profiles', here.map((p) => opt(p))));
  if (other.length) selPattern.append(optgroup('Flight profiles · other maps', other.map((p) => opt(p, ` · ${SCENARIO_BY_ID[p.scenario].name.split(' ·')[0]}`))));
  syncPatternValue();
}

function syncPatternValue() {
  const c = state.cfg;
  selPattern.value = c.pattern === 'custom' ? `fp:${c.profileId}` : c.pattern;
}

refreshDrones();
refreshPatterns();
WARPS.forEach((w) => selWarp.append(new Option(`×${w}`, String(w))));
for (const group of [...new Set(TECHS.map((t) => t.group))]) {
  const og = document.createElement('optgroup');
  og.label = group;
  for (const t of TECHS.filter((x) => x.group === group)) og.append(new Option(t.name, t.id));
  selPrimary.append(og);
}
const chips = $('height-chips');
for (const h of HEIGHT_PRESETS) {
  const b = el('button', '', `${h}`);
  b.type = 'button';
  b.title = `${h} m above ground`;
  b.addEventListener('click', () => setCfg({ height: h }));
  chips.append(b);
}

const heightToSlider = (h) => (1000 * Math.log10(clamp(h, 1, 1000))) / 3;
const sliderToHeight = (v) => {
  const h = Math.pow(1000, v / 1000);
  return h < 10 ? Math.round(h * 2) / 2 : h < 100 ? Math.round(h) : Math.round(h / 5) * 5;
};

selScenario.addEventListener('change', () => loadScenario(selScenario.value));
selDrone.addEventListener('change', () => setDrone(selDrone.value));
selPattern.addEventListener('change', () => {
  const v = selPattern.value;
  if (v.startsWith('fp:')) flyProfile(flightEditor.byId(v.slice(3)));
  else setCfg({ pattern: v, profileId: null, profile: null }, true);
  syncPatternValue();
});
rngSpeed.addEventListener('input', () => setCfg({ speed: +rngSpeed.value }));
rngHeight.addEventListener('input', () => setCfg({ height: sliderToHeight(+rngHeight.value) }));
rngSize.addEventListener('input', () => setCfg({ size: +rngSize.value }));
selWarp.addEventListener('change', () => {
  state.warp = +selWarp.value;
});
selPrimary.addEventListener('change', () => setPrimary(selPrimary.value));
$('btn-play').addEventListener('click', togglePlay);
$('btn-restart').addEventListener('click', restart);
$('btn-free').addEventListener('click', () => pilot.toggle());
for (const b of $('alt-ref').querySelectorAll('button')) b.addEventListener('click', () => setAltRef(b.dataset.ref));

/** AGL (terrain following) or barometric (altitude above take-off, rising only where the ground closes in). */
function setAltRef(ref) {
  if (ref === state.cfg.altRef) return;
  setCfg({ altRef: ref });
  toast(ref === 'baro'
    ? `Barometric: altitude above take-off; climbs only where the ground comes within ${state.cfg.clearance} m`
    : 'AGL: height above the ground - the drone follows the terrain');
}

function togglePlay() {
  state.playing = !state.playing;
  syncControls();
}
/** New flight from the pattern's start; a free flight starts again from there too. */
function restart() {
  const free = pilot.active;
  sim.reset();
  sim.rebuild();
  if (free) {
    sim.startFree();
    pilot.failsafe = false;
  }
  syncControls();
  dirty = true;
}
function setPrimary(id) {
  state.primary = id;
  syncControls();
  writeHash();
  dirty = true;
  updatePanel();
  updateTable();
}

function syncControls() {
  const c = state.cfg;
  const d = DRONE_BY_ID[c.drone];
  const pat = PATTERN_BY_ID[c.pattern];
  const free = !!sim.free;
  // a flight profile brings its own heights and speeds; in free flight the sticks decide
  const own = free || c.pattern === 'custom';
  selScenario.value = state.scenario;
  selDrone.value = c.drone;
  syncPatternValue();
  rngSpeed.min = String(d.vMin || 0);
  rngSpeed.max = String(d.vMax);
  rngSpeed.value = String(c.speed);
  const flown = sim.flySpeed;
  const ownText = free ? 'manual' : 'per waypoint';
  $('out-speed').textContent = own ? ownText : `${flown.toFixed(flown < 10 ? 1 : 0)} m/s${c.pattern === 'climb' && canHover(d) ? ' ↕' : ''}`;
  rngHeight.value = String(heightToSlider(c.height));
  $('out-height').textContent = own ? ownText : `${c.height < 10 ? c.height.toFixed(1) : Math.round(c.height)} m`;
  const baro = c.altRef === 'baro';
  $('lbl-height').textContent = baro ? 'Altitude (baro)' : 'Height AGL';
  $('ctl-height').title = baro ? `Altitude above the take-off point; the drone rises where the ground comes within ${c.clearance} m` : 'Height above the ground below the drone';
  for (const b of $('alt-ref').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.ref === c.altRef));
  for (const b of chips.querySelectorAll('button')) b.title = `${b.textContent} m above ${baro ? 'the take-off point' : 'ground'}`;
  rngSize.value = String(c.size);
  $('out-size').textContent = fmtDist(c.size);
  $('lbl-size').textContent = pat.size || 'Size';
  const off = { 'ctl-speed': own, 'ctl-height': own, 'ctl-size': !pat.size || free };
  for (const [id, isOff] of Object.entries(off)) {
    $(id).classList.toggle('is-off', isOff);
    for (const i of $(id).querySelectorAll('input, button')) i.disabled = isOff;
  }
  const freeBtn = $('btn-free');
  freeBtn.setAttribute('aria-pressed', String(free));
  freeBtn.textContent = free ? 'Exit free flight' : 'Free flight';
  $('osd').hidden = !free;
  $('viewport').classList.toggle('is-free', free);
  syncDrawerButtons();
  selWarp.value = String(state.warp);
  const play = $('btn-play');
  play.textContent = state.playing ? '❚❚' : '▶';
  play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  selPrimary.value = state.primary;
  $('sel-gsant').value = c.gsAnt;
  $('sel-airant').value = c.airAnt;
  for (const b of $('region').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.region === c.region));
  syncCamButtons();
  syncSettings();
}

// camera & place buttons
const camBox = $('cam-modes');
for (const [mode, label] of CAMS) {
  const b = el('button', '', label);
  b.type = 'button';
  b.dataset.mode = mode;
  b.addEventListener('click', () => setCam(mode));
  camBox.append(b);
}
const placeBox = $('place-modes');
placeBox.append(el('span', 'card__hint', ' Move: '));
for (const [what, label] of PLACES) {
  const b = el('button', '', label);
  b.type = 'button';
  b.dataset.place = what;
  b.title = `Click, then pick a spot in the 3-D view or on the map`;
  b.addEventListener('click', () => {
    state.place = state.place === what ? null : what;
    syncCamButtons();
  });
  placeBox.append(b);
}
function setCam(mode) {
  state.camMode = mode;
  cam.mode = mode;
  if (mode === 'chase') cam.chaseEye = null;
  if (mode === 'chase' && cam.dist > sim.world.S * 0.2) cam.dist = sim.world.S * 0.06;
  syncCamButtons();
  dirty = true;
}
function syncCamButtons() {
  for (const b of camBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === cam.mode));
  for (const b of placeBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.place === state.place));
  $('viewport').classList.toggle('is-placing', !!state.place);
}

function placeAt(x, z) {
  const w = sim.world;
  const what = state.place;
  state.place = null;
  if (what === 'center') {
    setCfg({ center: [x, z] }, true);
  } else if (what === 'pilot') {
    w.pilot = { ...w.pilot, x, z };
    sim.reset();
    sim.rebuild();
  } else if (what === 'cell') {
    const roof = w.bldgAt(x, z);
    w.cellSite = { ...w.cellSite, x, z, roof: roof || 0, h: roof > 0 ? roof + 4 : Math.max(w.cellSite0.h - (w.cellSite0.roof || 0), 25) };
    sim.reset();
    sim.rebuild();
  }
  toast(`${PLACES.find((p) => p[0] === what)[1]} moved`);
  syncControls();
  writeHash();
  dirty = true;
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 1800);
}

new CameraControls(canvas, cam, {
  onChange: () => {
    dirty = true;
    if (cam.mode !== state.camMode) {
      state.camMode = cam.mode;
      syncCamButtons();
    }
  },
  onDoubleClick: (x, y) => {
    if (flightEditor.mapEdit) return;
    const p = renderer.pick(x, y);
    if (!p) return;
    cam.mode = 'orbit';
    state.camMode = 'orbit';
    cam.target = renderer.display(p.x, p.z, sim.world.elevAt(p.x, p.z), 0);
    syncCamButtons();
    dirty = true;
  },
  onClick: (x, y) => {
    if (state.place) {
      const p = renderer.pick(x, y);
      if (p) placeAt(p.x, p.z);
    } else if (flightEditor.mapEdit) flightEditor.click(x, y);
  },
  // waypoint markers can be dragged while editing on the map; right-click deletes one
  intercept: (e) => flightEditor.intercept(e),
  onContext: (x, y) => {
    if (flightEditor.mapEdit) flightEditor.context(x, y);
  },
});

// antennas
const selGs = $('sel-gsant');
const selAir = $('sel-airant');
selGs.append(new Option('Auto (per technology)', 'auto'));
GROUND_ANTENNA_IDS.forEach((id) => selGs.append(new Option(ANTENNAS[id].name, id)));
selAir.append(new Option('Auto (per technology)', 'auto'));
AIR_ANTENNA_IDS.forEach((id) => selAir.append(new Option(ANTENNAS[id].name, id)));
selGs.addEventListener('change', () => setCfg({ gsAnt: selGs.value }));
selAir.addEventListener('change', () => setCfg({ airAnt: selAir.value }));

for (const b of $('region').querySelectorAll('button')) b.addEventListener('click', () => setCfg({ region: b.dataset.region }));
for (const b of $('dist-mode').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    distChart.mode = b.dataset.mode;
    for (const x of $('dist-mode').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    updatePanel();
  });
}

// ------------------------------------------------------------------ settings drawer

const SETTINGS = [
  { group: 'Height scale' },
  { key: 'view.scale', type: 'select', label: 'Vertical scale', options: [['log', 'Logarithmic'], ['lin', 'Linear, exaggerated'], ['true', 'True scale 1:1']] },
  { key: 'view.h0', type: 'range', label: 'Log knee h₀', min: 2, max: 40, step: 1, fmt: (v) => `${v} m`, dflt: () => SCENARIO_BY_ID[state.scenario].view.h0 },
  { key: 'view.gain', type: 'range', label: 'Height exaggeration', min: 0.4, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)}×`, dflt: () => SCENARIO_BY_ID[state.scenario].view.gain },
  { key: 'view.terrK', type: 'range', label: 'Terrain relief', min: 1, max: 4, step: 0.1, fmt: (v) => `${v.toFixed(1)}×`, dflt: () => SCENARIO_BY_ID[state.scenario].terrainExag },
  { key: 'view.treeScale', type: 'range', label: 'Tree size', min: 0.4, max: 2, step: 0.1, fmt: (v) => `${v.toFixed(1)}×` },
  { group: 'Show' },
  { key: 'view.trackColor', type: 'select', label: 'Colour track by', options: [['margin', 'Link margin'], ['state', 'Path state (LOS/NLOS)'], ['height', 'Height']] },
  { key: 'view.layers.track', type: 'check', label: 'Flight track' },
  { key: 'view.layers.drops', type: 'check', label: 'Drop lines to ground' },
  { key: 'view.layers.los', type: 'check', label: 'Direct ray (coloured by state)' },
  { key: 'view.layers.refl', type: 'check', label: 'Ground-reflection path' },
  { key: 'view.layers.lobes', type: 'check', label: 'Antenna patterns' },
  { key: 'view.layers.trees', type: 'check', label: 'Trees' },
  { key: 'view.layers.buildings', type: 'check', label: 'Buildings' },
  { key: 'view.layers.grid', type: 'check', label: 'Ground grid' },
  { key: 'view.layers.xray', type: 'check', label: 'X-ray hidden drone & rays' },
  { key: 'view.layers.labels', type: 'check', label: 'Labels' },
  { group: 'Flight' },
  { key: 'cfg.heading', type: 'range', label: 'Pattern heading', min: 0, max: 355, step: 5, fmt: (v) => `${v}°` },
  { key: 'cfg.avoid', type: 'check', label: 'Climb over buildings & tree crowns' },
  { key: 'cfg.altRef', type: 'select', label: 'Height reference', options: [['agl', 'AGL: follow the terrain'], ['baro', 'Barometric: hold altitude']] },
  { key: 'cfg.clearance', type: 'range', label: 'Barometric: min. ground clearance', min: 1, max: 60, step: 1, fmt: (v) => `${v} m` },
  { group: 'Radio model' },
  { key: 'cfg.pilotH', type: 'range', label: 'Pilot antenna height', min: 1, max: 15, step: 0.5, fmt: (v) => `${v} m` },
  { key: 'cfg.interference', type: 'check', label: 'Interference (neighbour cells, band noise)' },
  { key: 'cfg.load', type: 'range', label: 'Neighbour-cell load', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)} %` },
  { key: 'cfg.shadowing', type: 'check', label: 'Log-normal shadowing' },
  { key: 'cfg.fading', type: 'check', label: 'Small-scale fading' },
  { group: 'Performance' },
  { key: 'view.dpr', type: 'select', label: 'Render resolution', options: [['1', '1× (fast)'], ['1.5', '1.5×'], ['2', '2× (sharp)']] },
];

const getPath = (path) => path.split('.').reduce((o, k) => o?.[k], state);
function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], state);
  obj[last] = value;
}

const settingInputs = [];
function buildSettings() {
  const body = $('settings-body');
  for (const s of SETTINGS) {
    if (s.group) {
      body.append(el('div', 'set-group', s.group));
      continue;
    }
    const row = el('div', s.type === 'check' ? 'set-row set-row--check' : 'set-row');
    const id = `set-${s.key.replace(/\./g, '-')}`;
    const label = el('label', '', s.label);
    label.htmlFor = id;
    let input;
    if (s.type === 'select') {
      input = el('select');
      for (const [v, t] of s.options) input.append(new Option(t, v));
    } else if (s.type === 'range') {
      input = el('input');
      input.type = 'range';
      input.min = s.min;
      input.max = s.max;
      input.step = s.step;
      const out = el('output');
      label.append(out);
      s.out = out;
    } else {
      input = el('input');
      input.type = 'checkbox';
    }
    input.id = id;
    input.addEventListener(s.type === 'range' ? 'input' : 'change', () => {
      let v = s.type === 'check' ? input.checked : s.type === 'range' ? +input.value : input.value;
      if (s.key === 'view.dpr') v = +v;
      if (s.key.startsWith('cfg.')) {
        setCfg({ [s.key.slice(4)]: v });
      } else {
        setPath(s.key, v);
        applyMapping();
        saveView();
        syncSettings();
      }
    });
    row.append(label, input);
    body.append(row);
    settingInputs.push({ s, input });
  }
  modelPanel = new ModelPanel(body, {
    onChange: () => {
      writeHash();
      syncModelBadge();
      updatePanel();
      updateTable();
      dirty = true;
    },
    currentEnv: () => sim.geo[TECHS[primaryIdx()].node].env,
  });
}

/** The settings button and the influences card show when the model is not the default one. */
function syncModelBadge() {
  const n = modelChanges().length;
  const btn = $('btn-settings');
  btn.classList.toggle('is-tuned', n > 0);
  btn.title = n ? `Display & model settings (S) - ${n} model parameter${n > 1 ? 's' : ''} changed` : 'Display & model settings (S)';
  $('btn-model').textContent = n ? `Model (${n} changed)…` : 'Model…';
}

function syncSettings() {
  for (const { s, input } of settingInputs) {
    let v = getPath(s.key);
    if ((v === null || v === undefined) && s.dflt) v = s.dflt();
    if (s.type === 'check') input.checked = !!v;
    else input.value = String(v);
    if (s.out) s.out.textContent = s.fmt ? s.fmt(+v) : String(v);
  }
  if (modelPanel) modelPanel.sync();
}
buildSettings();
syncModelBadge();

// the drawer opens below the top bar so its buttons stay reachable
const topbar = document.querySelector('.topbar');
new ResizeObserver(() => document.documentElement.style.setProperty('--top', `${topbar.offsetHeight}px`)).observe(topbar);

// settings, flight profiles and drone profiles share the right edge: one drawer at a time
function toggleDrawer(open = $('settings').hidden) {
  if (open) closeDrawers('settings');
  $('settings').hidden = !open;
  if (open) modelPanel.sync(true);
  syncDrawerButtons();
}
/** Opens the settings at the model parameters, on the environment the selected link sees. */
function openModel() {
  toggleDrawer(true);
  modelPanel.sync(true);
  document.querySelector('.set-group--model').scrollIntoView({ block: 'start' });
}
$('btn-model').addEventListener('click', openModel);
function closeDrawers(except) {
  if (except !== 'settings') $('settings').hidden = true;
  if (except !== 'flight' && flightEditor.isOpen) flightEditor.close();
  if (except !== 'drone' && droneEditor.isOpen) droneEditor.close();
  syncDrawerButtons();
}
function onDrawer(name, open) {
  if (open) closeDrawers(name);
  syncDrawerButtons();
}
function syncDrawerButtons() {
  $('btn-settings').setAttribute('aria-expanded', String(!$('settings').hidden));
  $('btn-edit-flight').setAttribute('aria-expanded', String(flightEditor.isOpen));
  $('btn-edit-drone').setAttribute('aria-expanded', String(droneEditor.isOpen));
}
$('btn-settings').addEventListener('click', () => toggleDrawer());
$('btn-settings-close').addEventListener('click', () => toggleDrawer(false));
$('btn-edit-flight').addEventListener('click', () => flightEditor.toggle());
$('btn-edit-drone').addEventListener('click', () => droneEditor.toggle());

// ------------------------------------------------------------------ help

function buildHelp() {
  const b = $('help-body');
  const p = (t) => el('p', '', t);
  const h = (t) => el('h3', '', t);
  b.append(
    p('GeoRfSim flies a drone over a procedurally generated landscape and evaluates every radio link with established, abstracted models instead of ray tracing: geometry decides line of sight, models decide how much each mechanism costs, and a Rician/Rayleigh fading process turns it into a received-signal distribution.'),
    h('Height scale'),
    p('Heights above ground are drawn logarithmically: y = H·log10(1 + h/h₀). Trees, houses and a pilot at 1.5 m stay visible next to a drone at 400 m. Terrain relief itself is linear. The mapping is monotonic per ground point, so "above / below the canopy" is always shown correctly - the direct ray is therefore drawn as a curve. Settings → Height scale switches to linear or true scale.'),
  );
  const keys = [
    ['Space', 'play / pause'], ['R', 'restart the flight (clears the track)'], ['1 … 6', 'scenarios'],
    ['[  ]', 'height down / up'], ['−  =', 'speed down / up'], [',  .', 'time warp slower / faster'],
    ['↑  ↓', 'previous / next technology'], ['C', 'cycle camera: orbit, follow, chase, top, pilot, FPV'], ['F  T  P', 'follow / top / pilot view'],
    ['L', 'log ↔ linear height scale'], ['B', 'height reference: AGL (follow the terrain) ↔ barometric (hold altitude)'],
    ['S', 'settings & model parameters'], ['?', 'this help'], ['Esc', 'close / cancel'],
    ['Mouse', 'drag: orbit · right-drag or Shift: pan · wheel: zoom · double-click: look there'],
    ['E', 'flight profiles: place waypoints on the map (click adds, drag moves, right-click deletes)'], ['Del', 'delete the selected waypoint'],
    ['G', 'free flight on / off'],
    ['W S  A D', 'free flight, multirotor: climb / descend, turn left / right'],
    ['↑ ↓ ← →', 'free flight, multirotor: forward / back, left / right (Shift: fine) · fixed wing: dive / climb, bank'],
    ['H', 'free flight: return home (again to cancel)'],
  ];
  b.append(h('Keys'));
  const t = el('table');
  for (const [k, v] of keys) {
    const tr = el('tr');
    const th = el('th');
    th.append(el('kbd', '', k));
    tr.append(th, el('td', '', v));
    t.append(tr);
  }
  b.append(t);
  const models = [
    ['Free space', 'Friis free-space path loss.'],
    ['Line of sight', 'Geometric: the straight ray is checked against terrain, building and canopy rasters.'],
    ['Terrain', 'Single knife-edge diffraction J(ν), ITU-R P.526, at the dominant obstacle (also counts a clipped Fresnel zone).'],
    ['Buildings', 'Rooftop knife-edge diffraction, capped by the 3GPP TR 36.777 / 38.901 NLOS excess loss (street-canyon multipath).'],
    ['Vegetation', 'Weissberger modified exponential decay over the foliage depth, saturating at the ITU-R P.833 maximum attenuation.'],
    ['Ground reflection', 'Two-ray model with Fresnel coefficients (ITU-R P.527 ground constants) and Ament roughness - "ground scattering" fades with height and grazing angle. Circular polarisation suppresses it at steep angles.'],
    ['Scattering / fading', 'Rician fading, K from the elevation-angle law K(θ) = K₀·exp(2θ/π·ln(K₉₀/K₀)) per clutter class; obstructions eat the coherent part (→ Rayleigh). Sum-of-sinusoids generator (Clarke/Jakes Doppler spectrum).'],
    ['Shadowing', 'Log-normal, σ per 3GPP TR 36.777 (height dependent in LOS), Gudmundson correlation along the flown distance.'],
    ['Antennas', '3GPP TR 38.901 parabolic patterns, half-wave dipole, steerable arrays; polarisation mismatch from the airframe attitude; diversity = selection combining.'],
    ['Cellular', 'Neighbour-cell interference from 18 virtual hexagonal sites with 3GPP LOS-probability-weighted path loss - why drones high up see poor SINR.'],
    ['Wideband & mobility', 'Frequency diversity via MIESM over ~bandwidth/coherence-bandwidth sub-bands; Doppler ICI, channel aging (J0 correlation) and delay spread vs cyclic prefix as SINR ceilings.'],
    ['PER & throughput', 'Mode/MCS tables (LTE/NR CQI, 802.11n, LoRa SF) with link adaptation and a logistic PER waterfall around each threshold.'],
    ['References', 'Al-Hourani et al. 2014 (LAP altitude), 3GPP TR 36.777 (aerial UEs) and TR 38.901 (path loss) are shown alongside for comparison.'],
  ];
  b.append(h('Models'));
  const t2 = el('table');
  for (const [k, v] of models) {
    const tr = el('tr');
    tr.append(el('th', '', k), el('td', '', v));
    t2.append(tr);
  }
  b.append(t2);
  b.append(
    h('Flight profiles, drones & free flight'),
    p('Flight profiles (✎ next to the pattern) are waypoint plans: each waypoint has a height above ground, the speed of the leg that starts there and an optional hold. At the end the drone loops, flies back and forth or stops. Switch on "Edit on map" (E), then click on the ground to add waypoints, drag them, right-click to delete; Top view (T) is easiest. Corners are flown with the turn radius the airframe needs; fixed wings cannot hold. Profiles are stored in this browser and travel as JSON files or inside a link. A pattern or a free flight can be turned into a profile.'),
    p('Height reference (AGL / Baro in the top bar, B): with AGL the heights are above the ground below the drone, so it follows the terrain. Barometric heights are altitudes above the take-off point (the pilot), held like a barometer does: the drone keeps its altitude over valleys and only rises where the ground - with "Climb over buildings & tree crowns" also a roof or a canopy - comes closer than the clearance (Settings → Flight), starting the climb early enough for its climb rate. It applies to patterns, flight profiles and free flight; the HUD then shows the altitude and the height above ground.'),
    p('Drone profiles (✎ next to the drone): duplicate a built-in airframe to edit speeds, climb rate, acceleration, tilt or bank limits, size and the on-board antenna. The editor shows what follows: turn radius, stopping distance, maximum Doppler shift.'),
    p('Free flight (G) hands you the sticks: keyboard in Mode-2 layout, a game pad, or an RC transmitter connected by USB as a joystick (AETR or TAER channel order). Multirotors fly like a GPS drone in position mode; fixed wings fly coordinated turns and cannot stall. Ground and buildings are solid. Return home (H) climbs over obstacles, flies back and lands next to the pilot. With "failsafe RTH" on, the drone stops hearing your sticks and returns home when the chosen control link loses more than 90 % of its packets for a second - the simulated link, not a timer. The FPV camera rides on the airframe.'),
  );
  b.append(
    h('Tuning the model'),
    p('Settings → Model parameters (or "Model…" in the Influences card) exposes the knobs: canopy density and trunk-zone weight, foliage attenuation and its saturation, terrain and rooftop diffraction, whether street canyons cap the building loss, ground reflection strength and roughness, unlicensed-band noise - and per environment class the scattering (Rician K at low and high elevation), delay spread, shadowing σ and decorrelation, moving scatterers and noise rise. Everything acts at once; changed values are marked and can be reset one by one, and the link carries them.'),
  );
  b.append(h('Reading the verdict'), p('Each technology is judged from the last 5 s of samples: the 10 % SINR point against its most robust mode, the packet error rate, and the data rate it needs (video, telemetry, C2). Reasons list what limits it - blockage, interference, Doppler, delay spread or fading. Tx powers follow EU (ETSI) or US (FCC) practice and are assumptions, not certifications.'));
  b.append(el('p', 'help__build', `GeoRfSim · build ${BUILD.version}${BUILD.date ? ` · ${BUILD.date}` : ''}`));
}
buildHelp();
function toggleHelp(open = $('help').hidden) {
  $('help').hidden = !open;
}
$('btn-help').addEventListener('click', () => toggleHelp());
$('btn-help-close').addEventListener('click', () => toggleHelp(false));
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) toggleHelp(false);
});

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  const tgt = e.target;
  if (tgt instanceof HTMLInputElement || tgt instanceof HTMLSelectElement || tgt instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
  // free flight owns W A S D, the arrows, Shift and H while it is on
  if (pilot.keyDown(e)) {
    e.preventDefault();
    return;
  }
  const k = e.key;
  const c = state.cfg;
  const own = !!sim.free || c.pattern === 'custom';
  let handled = true;
  if (k === ' ') togglePlay();
  else if (k === 'r' || k === 'R') restart();
  else if (k >= '1' && k <= '6') loadScenario(SCENARIOS[+k - 1].id);
  else if (own && '[]-=+'.includes(k)) toast(sim.free ? 'In free flight the sticks set height and speed' : 'Heights and speeds come from the flight profile (✎)');
  else if (k === '[') setCfg({ height: Math.max(1, +(c.height / 1.25).toFixed(1)) });
  else if (k === ']') setCfg({ height: Math.min(1000, +(c.height * 1.25).toFixed(1)) });
  else if (k === '-') setCfg({ speed: Math.max(DRONE_BY_ID[c.drone].vMin || 0, c.speed - 1) });
  else if (k === '=' || k === '+') setCfg({ speed: Math.min(DRONE_BY_ID[c.drone].vMax, c.speed + 1) });
  else if (k === 'g' || k === 'G') pilot.toggle();
  else if (k === 'b' || k === 'B') setAltRef(c.altRef === 'baro' ? 'agl' : 'baro');
  else if (k === 'e' || k === 'E') {
    if (!flightEditor.isOpen) flightEditor.open();
    flightEditor.setMapEdit(!flightEditor.mapEdit);
  } else if ((k === 'Delete' || k === 'Backspace') && flightEditor.isOpen && flightEditor.sel >= 0) flightEditor.remove(flightEditor.sel);
  else if (k === ',') state.warp = WARPS[Math.max(0, WARPS.indexOf(state.warp) - 1)];
  else if (k === '.') state.warp = WARPS[Math.min(WARPS.length - 1, WARPS.indexOf(state.warp) + 1)];
  else if (k === 'ArrowUp' || k === 'ArrowDown') {
    const i = primaryIdx() + (k === 'ArrowUp' ? -1 : 1);
    setPrimary(TECHS[(i + TECHS.length) % TECHS.length].id);
  } else if (k === 'c' || k === 'C') setCam(CAMS[(CAMS.findIndex((m) => m[0] === cam.mode) + 1) % CAMS.length][0]);
  else if (k === 'f' || k === 'F') setCam('follow');
  else if (k === 't' || k === 'T') setCam('top');
  else if (k === 'p' || k === 'P') setCam('pilot');
  else if (k === 'l' || k === 'L') {
    state.view.scale = state.view.scale === 'log' ? 'lin' : 'log';
    applyMapping();
    saveView();
    toast(`Height scale: ${state.view.scale === 'log' ? 'logarithmic' : 'linear'}`);
  } else if (k === 's' || k === 'S') toggleDrawer();
  else if (k === '?' || k === 'h' || k === 'H') toggleHelp();
  else if (k === 'Escape') {
    if (flightEditor.mapEdit) flightEditor.setMapEdit(false);
    else {
      state.place = null;
      toggleHelp(false);
      closeDrawers();
    }
  } else handled = false;
  if (handled) {
    e.preventDefault();
    syncControls();
  }
});

// ------------------------------------------------------------------ colours for track & rays

function colorKey() {
  return `${state.view.trackColor}|${state.primary}`;
}

function marginColor(m) {
  for (const [lo, c] of MARGIN_BUCKETS) if (m >= lo) return c;
  return COL.critical;
}

const colorCache = new Map();
function cachedHex(h) {
  if (!colorCache.has(h)) colorCache.set(h, hex(h));
  return colorCache.get(h);
}

function colorOf(i) {
  const t = sim.track;
  const mode = state.view.trackColor;
  if (mode === 'state') {
    const node = TECHS[primaryIdx()].node === 'pilot' ? 0 : 1;
    return cachedHex(STATE_COLORS[t.state[i * 2 + node]] || COL.s1);
  }
  if (mode === 'height') {
    const c = rampColor(Math.log10(Math.max(t.agl[i], 1) / 2) / Math.log10(250));
    return [c[0], c[1], c[2], 1];
  }
  return cachedHex(marginColor(t.margin[i * t.nTech + primaryIdx()]));
}

function updateRays() {
  const lay = state.view.layers;
  const tech = TECHS[primaryIdx()];
  const g = sim.geo[tech.node];
  const w = sim.world;
  const d = sim.dr;
  const lines = [];
  if (lay.los && g.node) {
    const pts = [];
    const N = 72;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = g.node.x + (d.x - g.node.x) * t;
      const z = g.node.z + (d.z - g.node.z) * t;
      const y = g.node.y + (d.y - g.node.y) * t;
      const e = w.elevAt(x, z);
      const agl = y - e;
      let c = STATE_COLORS[0];
      if (agl < 0 && i > 0 && i < N) c = STATE_COLORS[3];
      else {
        const b = w.bldgAt(x, z);
        const cn = w.canopyAt(x, z);
        if (b > 0 && agl < b) c = STATE_COLORS[4];
        else if (cn > 0 && agl < cn) c = STATE_COLORS[2];
      }
      pts.push([x, z, e, agl, cachedHex(c)]);
    }
    lines.push(pts);
  }
  // the drone's own drop line: reads its 3-D position against the ground (not from the drone's own camera)
  const de = w.elevAt(d.x, d.z);
  const white = [1, 1, 1, 0.85];
  if (cam.mode !== 'fpv') lines.push([[d.x, d.z, de, 0, [1, 1, 1, 0.25]], [d.x, d.z, de, d.agl, white]]);
  const ls = sim.techStates[primaryIdx()].ls;
  if (lay.refl && g.refl?.valid && ls) {
    const mag = Math.hypot(ls.gr, ls.gi);
    if (mag > 0.03) {
      const col = hex(COL.ink2, clamp(mag * 1.2, 0.18, 0.85));
      const r = g.refl;
      const seg = (ax, ay, az, bx, by, bz) => {
        const pts = [];
        for (let i = 0; i <= 20; i++) {
          const t = i / 20;
          const x = ax + (bx - ax) * t;
          const z = az + (bz - az) * t;
          const y = ay + (by - ay) * t;
          const e = w.elevAt(x, z);
          pts.push([x, z, e, Math.max(y - e, 0.15), col]);
        }
        return pts;
      };
      lines.push(seg(g.node.x, g.node.y, g.node.z, r.px, r.ep, r.pz));
      lines.push(seg(r.px, r.ep, r.pz, d.x, d.y, d.z));
    }
  }
  renderer.setRays(lines);
}

function buildLobes() {
  if (!state.view.layers.lobes) return [];
  const idx = primaryIdx();
  const tech = TECHS[idx];
  const ls = sim.techStates[idx].ls;
  if (!ls) return [];
  const w = sim.world;
  const S = w.S;
  const out = [];
  const gsAnt = ls.gsAnt;
  const gsId = ANT_ID.get(gsAnt);
  const gsMesh = renderer.lobe(`gs:${gsId}`, (x, y, z) => gainLocal(gsAnt, x, y, z), gsAnt.g);
  if (tech.node === 'cell') {
    const c = w.cellSite;
    const pos = renderer.display(c.x, c.z, w.elevAt(c.x, c.z), c.h);
    const n = gsAnt.sectors || 1;
    for (let k = 0; k < n; k++) out.push({ mesh: gsMesh, pos, axes: axesFromAzTilt(sim.cellAz0 + (k * 360) / n, gsAnt.tilt || 0), scale: S / 18 });
  } else {
    const p = w.pilot;
    out.push({ mesh: gsMesh, pos: renderer.display(p.x, p.z, w.elevAt(p.x, p.z), state.cfg.pilotH), axes: ls.gsAxes, scale: S / 22 });
  }
  const air = ls.airAnt;
  const airId = ANT_ID.get(air);
  const airMesh = renderer.lobe(`air:${airId}`, (x, y, z) => airGainBody(air, [x, y, z]), air.g);
  const d = sim.dr;
  // seen from the drone's own camera its lobe would fill the screen
  if (cam.mode !== 'fpv') out.push({ mesh: airMesh, pos: renderer.display(d.x, d.z, d.e, d.agl), axes: d.body, scale: S / 34 });
  return out;
}

// ------------------------------------------------------------------ labels & HUD

const labelBox = $('labels');
const labels = {
  pilot: el('div', 'lbl'),
  cell: el('div', 'lbl'),
  drone: el('div', 'lbl lbl--drone'),
};
for (const l of Object.values(labels)) labelBox.append(l);

function place(lbl, p, html) {
  if (!p || !state.view.layers.labels || p[0] < -50 || p[1] < -20 || p[0] > canvas.clientWidth + 50 || p[1] > canvas.clientHeight + 40) {
    lbl.hidden = true;
    return;
  }
  lbl.hidden = false;
  lbl.style.left = `${p[0]}px`;
  lbl.style.top = `${p[1]}px`;
  if (lbl.dataset.text !== html) {
    lbl.textContent = '';
    const [a, b] = html.split('|');
    lbl.append(document.createTextNode(a));
    if (b) {
      lbl.append(document.createElement('br'));
      lbl.append(el('small', '', b));
    }
    lbl.dataset.text = html;
  }
}

function updateLabels() {
  const w = sim.world;
  const d = sim.dr;
  const p = w.pilot;
  const c = w.cellSite;
  const ls = sim.techStates[primaryIdx()].ls;
  const pd = renderer.project(renderer.display(d.x, d.z, d.e, d.agl + 3));
  const pp = renderer.project(renderer.display(p.x, p.z, w.elevAt(p.x, p.z), Math.max(state.cfg.pilotH, 2) + 3));
  place(labels.drone, cam.mode === 'fpv' ? null : pd, `${Math.round(d.agl)} m AGL|${ls ? `${num(ls.sinrLsDb, 0)} dB · ${TECHS[primaryIdx()].name}` : ''}`);
  place(labels.pilot, pp, `Pilot|${state.cfg.pilotH} m antenna`);
  // keep the pilot label readable when the drone is right above/next to it
  const close = pd && pp && Math.abs(pd[0] - pp[0]) < 130 && Math.abs(pd[1] - pp[1]) < 44;
  labels.pilot.style.transform = close ? 'translate(-50%, 14px)' : '';
  place(labels.cell, renderer.project(renderer.display(c.x, c.z, w.elevAt(c.x, c.z), c.h + 2)), `Cell site|${Math.round(c.h)} m · ${c.model}`);
}

const hud = $('hud');
const hudItems = {};
for (const [k, label] of [['t', 'time'], ['dist', 'distance'], ['agl', 'height'], ['v', 'speed'], ['elev', 'elevation'], ['env', 'clutter']]) {
  const pill = el('div', 'pill');
  pill.append(el('span', '', label));
  const b = el('b');
  pill.append(b);
  hud.append(pill);
  hudItems[k] = b;
}
function updateHud() {
  const d = sim.dr;
  const tech = TECHS[primaryIdx()];
  const g = sim.geo[tech.node];
  const t = sim.t;
  hudItems.t.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}${state.warp !== 1 ? ` ×${state.warp}` : ''}`;
  hudItems.dist.textContent = `${fmtDist(g.d3 || 0)} to ${tech.node === 'cell' ? 'cell' : 'pilot'}`;
  const aglText = `${d.agl < 10 ? d.agl.toFixed(1) : Math.round(d.agl)} m AGL`;
  hudItems.agl.textContent = state.cfg.altRef === 'baro' ? `${Math.round(d.y - sim.homeElev)} m alt · ${aglText}` : aglText;
  hudItems.v.textContent = `${d.speed.toFixed(1)} m/s`;
  hudItems.elev.textContent = `${num(g.elev ?? 0, 1)}°`;
  hudItems.env.textContent = ENVS[g.env]?.name || '–';
}

$('legend').addEventListener('click', () => {
  state.view.legendOpen = state.view.legendOpen === false;
  saveView();
  updateLegend();
});

function updateLegend() {
  const box = $('legend');
  const mode = state.view.trackColor;
  const open = state.view.legendOpen !== false;
  const key = `${mode}|${state.primary}|${state.view.layers.los}|${open}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.textContent = '';
  box.title = open ? 'Click to collapse' : 'Click to show the legend';
  if (!open) {
    box.append(el('div', 'legend__title', 'Legend ▸'));
    return;
  }
  const tech = TECHS[primaryIdx()];
  const items = (list) => {
    const wrap = el('div', 'legend__items');
    for (const [color, text] of list) {
      const r = el('span', 'legend__row');
      const k = el('i', 'key-line');
      k.style.background = color;
      r.append(k, document.createTextNode(text));
      wrap.append(r);
    }
    box.append(wrap);
  };
  if (mode === 'margin') {
    box.append(el('div', 'legend__title', `Track: link margin · ${tech.name}`));
    const icons = ['✓', '!', '!', '✕'];
    items(MARGIN_BUCKETS.map(([, c, t], i) => [c, `${icons[i]} ${t}`]));
  } else if (mode === 'height') {
    box.append(el('div', 'legend__title', 'Track: height above ground'));
    const ramp = el('div', 'legend__ramp');
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => css(rampColor(t)));
    ramp.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    const ends = el('div', 'legend__ends');
    ends.append(el('span', '', '2 m'), el('span', '', '20 m'), el('span', '', '500 m'));
    box.append(ramp, ends);
  }
  if (mode === 'state' || state.view.layers.los) {
    box.append(el('div', 'legend__title', mode === 'state' ? `Track & direct ray: path state (${tech.node})` : 'Direct ray: path state'));
    items(STATE_LABELS.map((t, i) => [STATE_COLORS[i], t]));
  }
}

// ------------------------------------------------------------------ link panel

const infl = $('influences');
const INFL = [
  ['antGs', 'Ground antenna'], ['antAir', 'Drone antenna'], ['terrain', 'Terrain diffraction'], ['urban', 'Buildings (NLOS)'],
  ['veg', 'Vegetation'], ['refl', 'Ground reflection'], ['shadow', 'Shadowing'], ['pol', 'Polarisation'], ['gas', 'Atmosphere'],
  ['interf', 'Interference / noise'], ['imp', 'Doppler & delay spread'], ['fade', 'Fading (now)'],
];
const inflRows = {};
for (const [k, label] of INFL) {
  const lab = el('div', 'infl__label', label);
  const track = el('div', 'infl__track');
  const bar = el('div', 'infl__bar');
  track.append(bar);
  const val = el('div', 'infl__val');
  infl.append(lab, track, val);
  inflRows[k] = { lab, bar, val };
}
const axis = el('div', 'infl__axis');
axis.append(el('span', '', '−30 dB loss'), el('span', '', '0'), el('span', '', 'gain +30'));
infl.append(el('div'), axis, el('div'));

const COMP = [['direct', 'Direct (LOS)', COL.s1], ['specular', 'Ground reflection', COL.s2], ['diffuse', 'Scattering', COL.s3]];
const compBar = $('comp-bar');
const compLegend = $('comp-legend');
const compParts = {};
for (const [k, label, color] of COMP) {
  const seg = el('span');
  seg.style.background = color;
  compBar.append(seg);
  const item = el('span');
  const key = el('i', 'key-box');
  key.style.background = color;
  const b = el('b');
  item.append(key, document.createTextNode(label), b);
  compLegend.append(item);
  compParts[k] = { seg, b };
}

const facts = $('facts');
const FACTS = [
  ['prx', 'Rx power'], ['pl', 'Path loss'], ['dist', 'Distance'], ['elev', 'Elevation'], ['k', 'Rician K'], ['fd', 'Doppler shift'],
  ['fm', 'Doppler spread'], ['tc', 'Coherence time'], ['ds', 'Delay spread'], ['mode', 'Mode'], ['thr', 'Throughput'], ['per', 'PER (5 s)'],
];
const factEls = {};
for (const [k, label] of FACTS) {
  const d = el('div');
  const dt = el('dt', '', label);
  const dd = el('dd', '', '–');
  d.append(dt, dd);
  facts.append(d);
  factEls[k] = dd;
}

function legendRow(box, items) {
  const key = items.map((i) => i[1]).join('|');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.textContent = '';
  for (const [color, text] of items) {
    const s = el('span');
    const k = el('i', 'key-line');
    k.style.background = color;
    s.append(k, document.createTextNode(text));
    box.append(s);
  }
}

function setInfl(k, v, title) {
  const r = inflRows[k];
  const val = Number.isFinite(v) ? v : 0;
  const w = (Math.min(Math.abs(val), 30) / 30) * 50;
  r.bar.className = `infl__bar ${val < 0 ? 'infl__bar--loss' : 'infl__bar--gain'}`;
  r.bar.style.width = `${w}%`;
  r.val.textContent = Math.abs(val) < 0.05 ? '0' : sign(val);
  const muted = Math.abs(val) < 0.05;
  r.lab.style.color = muted ? COL.muted : '';
  r.val.style.color = muted ? COL.muted : '';
  r.lab.title = title || '';
}

function updatePanel() {
  const idx = primaryIdx();
  const tech = TECHS[idx];
  const ts = sim.techStates[idx];
  const ls = ts.ls;
  if (!ls) return;
  const st = sim.stats(idx);
  const g = sim.geo[tech.node];
  const d = sim.dr;
  const best = ls.branches[ls.bestB];

  $('hero-snr').textContent = num(st ? st.snrMean : ls.sinrLsDb, 1);
  const stateBox = $('link-state');
  stateBox.textContent = '';
  const tag = (color, text) => {
    const t = el('span', 'tag');
    if (color) {
      const i = el('i');
      i.style.background = color;
      t.append(i);
    }
    t.append(document.createTextNode(text));
    stateBox.append(t);
  };
  tag(STATE_COLORS[ls.state], STATE_LABELS[ls.state]);
  tag(null, ls.K > 0 ? `Rician K ${num(ls.kDb, 0)} dB` : 'Rayleigh');
  tag(null, ENVS[g.env].name);
  const v = $('link-verdict');
  v.textContent = '';
  if (st) {
    v.className = `verdict st-${st.verdict.status}`;
    v.append(el('span', 'ico', st.verdict.icon), document.createTextNode(`${st.verdict.label} · ${st.verdict.reasons[0] || ''}`));
  }

  const coh = 0.423 / Math.max(ls.fdMax, 0.01);
  const sc = tech.scs ? ` · ${((ls.fdMax / tech.scs) * 100).toFixed(2)} % SCS` : '';
  factEls.prx.textContent = `${num(ls.prx, 1)} dBm`;
  factEls.pl.textContent = `${num(ls.hybridPl, 1)} dB`;
  factEls.dist.textContent = fmtDist(g.d3);
  factEls.elev.textContent = `${num(g.elev, 1)}°`;
  factEls.k.textContent = `${ls.K > 0 ? `${num(ls.kDb, 1)} dB` : 'Rayleigh'}${st && Number.isFinite(st.kFit) ? ` · fit ${st.kFit > 0 ? num(10 * Math.log10(st.kFit), 1) : '≈0'}` : ''}`;
  factEls.fd.textContent = `${ls.fLos >= 0 ? '+' : '−'}${fmtHz(Math.abs(ls.fLos))}`;
  factEls.fm.textContent = `${fmtHz(ls.fdMax)}${sc}`;
  factEls.tc.textContent = coh >= 1 ? `${coh.toFixed(1)} s` : `${(coh * 1000).toFixed(coh < 0.01 ? 2 : 1)} ms`;
  factEls.ds.textContent = `${Math.round(ls.ds * 1e9)} ns · Bc ${fmtHz(ls.bc)}`;
  factEls.mode.textContent = ls.mode.name;
  factEls.thr.textContent = tech.kind === 'analog' ? 'analog' : st ? fmtRate(st.thr) : '–';
  factEls.per.textContent = st ? fmtPct(st.per) : '–';

  // budget & influences
  const budget = $('budget');
  budget.textContent = '';
  const bItem = (label, value) => {
    const s = el('span', '', `${label} `);
    s.append(el('b', '', value));
    budget.append(s);
  };
  bItem('Tx', `${ls.tx} dBm`);
  bItem('free space', `−${ls.lFs.toFixed(1)} dB`);
  bItem('Rx', `${num(ls.prx, 1)} dBm`);
  bItem('noise', `${num(ls.nDbm, 1)} dBm`);
  setInfl('antGs', ls.gGs, `${ls.gsAnt.name} towards the drone`);
  setInfl('antAir', best.g, `${ls.airAnt.name} towards the ground node (best branch)`);
  setInfl('terrain', -ls.lT, `ν = ${num(ls.nuT, 2)}`);
  setInfl('urban', -ls.lB, `ν = ${num(ls.nuB, 2)}`);
  setInfl('veg', -ls.lV, 'foliage depth along the ray');
  setInfl('refl', ls.twoRayDb, 'two-ray interference of the coherent part');
  setInfl('shadow', ls.shadow, `σ = ${ls.sigma.toFixed(1)} dB`);
  setInfl('pol', -best.lPol, 'antenna polarisation mismatch (airframe attitude)');
  setInfl('gas', -ls.lGas, 'gaseous absorption');
  setInfl('interf', -ls.interfDb, 'rise of noise + interference over thermal noise');
  setInfl('imp', -ls.impDb, `${ls.imp.name}`);
  const latest = ts.eff[(ts.head - 1 + ts.eff.length) % ts.eff.length];
  setInfl('fade', ts.count ? latest - ls.sinrLsDb : 0, 'instantaneous SINR vs. its large-scale mean');

  for (const [k] of COMP) {
    const f = ls.comp[k];
    compParts[k].seg.style.flex = `${Math.max(f, 0.0001)}`;
    compParts[k].seg.style.display = f < 0.003 ? 'none' : '';
    compParts[k].b.textContent = ` ${fmtPct(f)}`;
  }

  // distribution
  const win = sim.window(idx);
  distChart.draw({ eff: win.eff, nb: win.nb, minSnr: ls.minSnr, K: ls.K });
  legendRow($('dist-legend'), [[COL.s1, 'narrow-band, 1 antenna'], [COL.s2, 'effective (diversity + bandwidth)'], [COL.ink2, `Rician theory, K = ${ls.K > 0 ? `${num(ls.kDb, 1)} dB` : '0 (Rayleigh)'}`]]);
  const note = $('dist-note');
  note.textContent = '';
  if (st) {
    const nbFade = st.fadeDepth;
    const effFade = st.effFade;
    note.append(
      document.createTextNode('1 % fade below median: '),
      el('b', '', `${nbFade.toFixed(1)} dB`),
      document.createTextNode(' narrow-band, '),
      el('b', '', `${effFade.toFixed(1)} dB`),
      document.createTextNode(` effective → diversity gain ${Math.max(0, nbFade - effFade).toFixed(1)} dB. ${ls.L > 1 ? `${ls.L} independent sub-bands (Bc ${fmtHz(ls.bc)}).` : 'Flat fading over the channel.'}`),
    );
  }

  // history
  const hist = sim.history(idx);
  histChart.draw({ v: hist.v, m: hist.m, rate: hist.rate, minSnr: ls.minSnr, span: HIST_S });
  legendRow($('hist-legend'), [[COL.s1, 'instantaneous'], [COL.ink2, 'large-scale mean'], [COL.critical, `most robust mode (${num(ls.minSnr, 1)} dB)`]]);

  // antenna cuts in the vertical plane of the link
  const k = g.k;
  const hl = Math.hypot(k[0], k[2]) || 1;
  const hdir = [k[0] / hl, 0, k[2] / hl];
  const dirAt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [hdir[0] * Math.cos(a), Math.sin(a), hdir[2] * Math.cos(a)];
  };
  const gsAnt = ls.gsAnt;
  const gsCut = gsAnt.sectors ? (deg) => sectorGain(gsAnt, sim.cellAz0, dirAt(deg)).g : (deg) => gainWorld(gsAnt, ls.gsAxes, dirAt(deg));
  const airCut = (deg) => Math.max(...ls.branches.map((b) => gainWorld(ls.airAnt, b.axes, dirAt(deg))));
  polarChart.draw([
    { color: COL.s2, cut: gsCut, marker: g.elev },
    { color: COL.s1, cut: airCut, marker: 180 + g.elev },
  ]);
  legendRow($('polar-legend'), [[COL.s2, `ground: ${gsAnt.name}`], [COL.s1, `drone: ${ls.airAnt.name}`]]);

  // reference models
  const refs = $('refs');
  refs.textContent = '';
  const rrow = (name, value, sub) => {
    const tr = el('tr');
    const th = el('th', '', name);
    const td = el('td', '', value);
    if (sub) {
      td.append(document.createElement('br'));
      td.append(el('small', '', sub));
    }
    tr.append(th, td);
    refs.append(tr);
  };
  const r3 = ls.ref3;
  const av = (r3.model === 'RMa' && d.agl > 10) || (r3.model !== 'RMa' && d.agl > 22.5);
  rrow('Free space (Friis)', `${ls.lFs.toFixed(1)} dB`);
  rrow('This simulation (hybrid)', `${ls.hybridPl.toFixed(1)} dB`, 'incl. shadowing & ground reflection');
  rrow(`3GPP ${av ? 'TR 36.777' : 'TR 38.901'} ${r3.model}${av ? '-AV' : ''}`, `${r3.plLos.toFixed(1)} / ${r3.plNlos.toFixed(1)} dB`, `LOS / NLOS · P(LOS) ${Math.round(r3.pLos * 100)} %`);
  const ahClass = g.env === 'dense' ? 'dense urban' : g.env === 'urban' ? 'urban' : 'suburban';
  rrow(`Al-Hourani 2014 (${ahClass})`, `${ls.alh.plMean.toFixed(1)} dB`, `P(LOS) ${Math.round(ls.alh.pLos * 100)} % at ${num(Math.max(g.elev, 0), 1)}°`);
}

// ------------------------------------------------------------------ technology table

const tbody = $('tech-table').querySelector('tbody');
const rowEls = new Map();
function buildTable() {
  let group = '';
  for (const t of TECHS) {
    if (t.group !== group) {
      group = t.group;
      const gr = el('tr', 'group');
      const td = el('td', '', group);
      td.colSpan = 9;
      gr.append(td);
      tbody.append(gr);
    }
    const tr = el('tr');
    tr.tabIndex = 0;
    tr.title = t.note;
    const cells = {};
    const name = el('td');
    name.append(el('div', 't-name', t.name), el('div', 't-sub', t.note));
    cells.band = el('td');
    cells.path = el('td');
    cells.mean = el('td', 'num');
    cells.p10 = el('td', 'num');
    cells.dop = el('td', 'num');
    cells.per = el('td', 'num');
    cells.thr = el('td', 'num');
    cells.verdict = el('td', 't-verdict');
    tr.append(name, cells.band, cells.path, cells.mean, cells.p10, cells.dop, cells.per, cells.thr, cells.verdict);
    tr.addEventListener('click', () => setPrimary(t.id));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setPrimary(t.id);
    });
    tbody.append(tr);
    rowEls.set(t.id, { tr, cells });
  }
}
buildTable();

function updateTable() {
  TECHS.forEach((t, i) => {
    const { tr, cells } = rowEls.get(t.id);
    tr.classList.toggle('is-primary', t.id === state.primary);
    const ls = sim.techStates[i].ls;
    const st = sim.stats(i);
    if (!ls) return;
    cells.band.textContent = `${fmtHz(ls.f)} · ${fmtHz(t.bw)}`;
    const dir = t.node === 'cell' ? 'cell ⇄ drone' : t.rx === 'air' ? 'pilot → drone' : 'drone → pilot';
    cells.path.textContent = '';
    const dot = el('i', 't-dot');
    dot.style.background = STATE_COLORS[ls.state];
    cells.path.append(dot, document.createTextNode(dir));
    cells.path.title = STATE_LABELS[ls.state];
    if (!st) return;
    cells.mean.textContent = `${num(st.snrMean, 1)} dB`;
    cells.p10.textContent = `${num(st.snr10, 1)} dB`;
    const ref = t.scs || t.bw;
    cells.dop.textContent = `${ls.fLos >= 0 ? '+' : '−'}${fmtHz(Math.abs(ls.fLos))} · ${((ls.fdMax / ref) * 100).toFixed(ls.fdMax / ref < 0.001 ? 3 : 2)} %`;
    cells.dop.title = `max Doppler ${fmtHz(ls.fdMax)} relative to ${t.scs ? 'subcarrier spacing' : 'bandwidth'}`;
    cells.per.textContent = fmtPct(st.per);
    if (t.kind === 'analog') cells.thr.textContent = st.per < 0.05 ? 'clean video' : st.per < 0.3 ? 'noisy video' : 'breaking up';
    else {
      cells.thr.textContent = fmtRate(st.thr);
      if (t.ul) cells.thr.append(el('div', 't-sub', `UL ${fmtRate(st.thrUl)}`));
    }
    const vd = st.verdict;
    cells.verdict.textContent = '';
    const vEl = el('div', `verdict st-${vd.status}`);
    vEl.append(el('span', 'ico', vd.icon), document.createTextNode(vd.label));
    cells.verdict.append(vEl, el('div', 't-reason', vd.reasons.slice(0, 3).join(' · ')));
  });
}

// ------------------------------------------------------------------ main loop

let last = performance.now();
let panelT = 1;
let tableT = 1;
const NO_LINES = [];
let shownPlan = NO_LINES;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (state.playing) {
    pilot.update(dt);
    sim.step(dt * state.warp);
  }
  if (!sim.free && !$('osd').hidden) syncControls(); // free flight ended by a reset or a new scenario
  const d = sim.dr;
  const w = sim.world;
  const airframe = DRONE_BY_ID[state.cfg.drone];
  if (state.playing || dirty || cam.mode !== 'orbit') {
    renderer.syncTrack(sim.track, colorOf, colorKey());
    updateRays();
    // waypoint plan and markers while the flight-profile editor is open
    const ov = flightEditor.overlay();
    const plan = ov.plan.length ? ov.plan : NO_LINES;
    if (plan !== shownPlan) {
      renderer.setLines('plan', plan);
      shownPlan = plan;
    }
    renderer.setLines('marks', ov.marks);
    const p = w.pilot;
    const toward = Math.atan2(d.z - p.z, d.x - p.x);
    const pilotEye = renderer.display(p.x - Math.cos(toward) * 6, p.z - Math.sin(toward) * 6, w.elevAt(p.x, p.z), 2.5);
    const dPos = renderer.display(d.x, d.z, d.e, d.agl);
    cam.update(canvas.clientWidth / Math.max(canvas.clientHeight, 1), {
      drone: dPos,
      heading: d.heading,
      pilot: pilotEye,
      body: d.body,
      lift: renderer.display(d.x, d.z, d.e, d.agl + 0.3)[1] - dPos[1],
    }, dt);
    renderer.render(cam, {
      drone: { ...d, model: airframe.model, span: airframe.span },
      hideDrone: cam.mode === 'fpv',
      pilotH: state.cfg.pilotH,
      cellAz0: sim.cellAz0,
      lobes: buildLobes(),
    });
    updateLabels();
    dirty = false;
  }
  panelT += dt;
  tableT += dt;
  if (panelT > 0.1) {
    panelT = 0;
    updateHud();
    updatePanel();
    updateLegend();
    minimap.draw({
      track: sim.track, colorOf, path: sim.free ? null : sim.path, pilot: w.pilot, cell: w.cellSite, drone: d, heading: d.heading,
      view: { x: (cam.target[0]), z: cam.target[2], yaw: cam.mode === 'top' ? -Math.PI / 2 : cam.yaw },
      waypoints: flightEditor.isOpen && flightEditor.cur ? flightEditor.cur.waypoints : null,
      selected: flightEditor.sel,
    });
  }
  if (tableT > 0.35) {
    tableT = 0;
    updateTable();
  }
  requestAnimationFrame(frame);
}

loadScenario(state.scenario, { defaults: false });
if (fromHash.primary) state.primary = fromHash.primary;
syncControls();
requestAnimationFrame(frame);

// for debugging in the console
window.georfsim = { sim, renderer, cam, state, updatePanel, updateTable, flightEditor, droneEditor, pilot };
