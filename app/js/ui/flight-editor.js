/*
 * Flight profile editor: named waypoint plans (height, speed, hold per
 * waypoint; loop / back & forth / stop at the end). Waypoints are placed and
 * dragged directly in the 3-D view; the table edits the numbers. Plans are
 * kept in localStorage and travel as JSON files or inside a link.
 */
import { $, el, button, numberInput, download, pickFile, shareLink, fmtDuration } from './dom.js';
import {
  loadProfiles, saveProfiles, sanitizeProfile, newId, profileStats, exportJson, importJson, profileFromPath, profileFromTrack, END_MODES,
} from '../profiles.js';
import { buildPath, PATTERN_BY_ID } from '../flight.js';
import { SCENARIO_BY_ID } from '../scenarios.js';
import { clamp, fmtDist } from '../util.js';

const MARK = [1, 1, 1, 0.95];
const MARK_SEL = [0.98, 0.7, 0.1, 1];
const PLAN = [0.92, 0.93, 0.95, 0.75];

export class FlightEditor {
  /**
   * app: { sim, state, flyProfile(p), profileEdited(p), profileRemoved(id), toast, pick(x, y), project(x, z, agl),
   *        canvasRect(), markDirty(), linkFor(p), refreshPatterns(), drone(), setCam(mode), onDrawer(name, open) }
   */
  constructor(app) {
    this.app = app;
    this.root = $('flight-editor');
    this.body = $('fe-body');
    this.profiles = loadProfiles();
    this.cur = null;
    this.mapEdit = false;
    this.sel = -1;
    this.drag = null;
    this.planCache = { key: '', lines: [] };
    this.labelBox = $('labels');
    this.labels = [];
    this.#build();
    $('fe-close').addEventListener('click', () => this.close());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  byId(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  /** Adds or replaces a profile (e.g. one that arrived in a link). */
  upsert(p) {
    const i = this.profiles.findIndex((x) => x.id === p.id);
    if (i >= 0) this.profiles[i] = p;
    else this.profiles.push(p);
    this.#save();
    return p;
  }

  open(id) {
    this.root.hidden = false;
    this.cur = this.byId(id) || this.byId(this.app.state.cfg.profileId) || this.cur || this.profiles[0] || null;
    this.sel = -1;
    this.render();
    this.app.onDrawer('flight', true);
    this.app.markDirty();
  }

  close() {
    this.root.hidden = true;
    this.setMapEdit(false);
    for (const l of this.labels) l.hidden = true;
    this.app.onDrawer('flight', false);
    this.app.markDirty();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ------------------------------------------------------------------ static layout

  #build() {
    const b = this.body;
    const row1 = el('div', 'ed-row');
    this.selProfile = el('select', 'ed-grow');
    this.selProfile.setAttribute('aria-label', 'Flight profile');
    this.selProfile.addEventListener('change', () => {
      this.cur = this.byId(this.selProfile.value);
      this.sel = -1;
      this.render();
      this.app.markDirty();
    });
    row1.append(
      this.selProfile,
      button('New', 'New empty profile for this scenario', () => this.#create()),
      button('Duplicate', 'Copy of this profile', () => this.#duplicate()),
      button('Delete', 'Delete this profile', () => this.#delete()),
    );
    this.nameIn = el('input', 'ed-text');
    this.nameIn.type = 'text';
    this.nameIn.maxLength = 60;
    this.nameIn.setAttribute('aria-label', 'Profile name');
    this.nameIn.addEventListener('input', () => {
      if (!this.cur) return;
      this.cur.name = this.nameIn.value.trim().slice(0, 60) || 'Flight profile';
      this.#save();
      this.#syncSelect();
      this.app.refreshPatterns();
    });
    const nameRow = el('label', 'ed-field');
    nameRow.append(el('span', '', 'Name'), this.nameIn);

    this.endSeg = el('div', 'seg seg--small');
    this.endSeg.setAttribute('role', 'group');
    this.endSeg.setAttribute('aria-label', 'At the last waypoint');
    for (const [mode, label] of END_MODES) {
      const btn = el('button', '', label);
      btn.type = 'button';
      btn.dataset.end = mode;
      btn.addEventListener('click', () => {
        if (!this.cur) return;
        this.cur.end = mode;
        this.commit();
      });
      this.endSeg.append(btn);
    }
    const endRow = el('div', 'ed-field');
    endRow.append(el('span', '', 'At the end'), this.endSeg);

    const mapRow = el('div', 'ed-row');
    this.mapBtn = button('Edit on map', 'Click in the 3-D view to add, drag to move, right-click to delete (E)', () => this.setMapEdit(!this.mapEdit), 'btn btn--toggle');
    this.mapBtn.setAttribute('aria-pressed', 'false');
    mapRow.append(this.mapBtn, button('Top view', 'Look straight down - easiest for placing waypoints', () => this.app.setCam('top')));
    this.mapHint = el('p', 'ed-hint', 'Click on the ground to add a waypoint after the selected one · drag a marker to move it · right-click or Delete removes it.');

    this.tableWrap = el('div', 'ed-table-wrap');
    this.table = el('table', 'ed-table');
    const head = el('thead');
    const hr = el('tr');
    for (const [t, c] of [['#', ''], ['Height m', 'num'], ['Speed m/s', 'num'], ['Hold s', 'num'], ['', '']]) hr.append(el('th', c, t));
    this.hHead = hr.children[1];
    head.append(hr);
    this.tbody = el('tbody');
    this.table.append(head, this.tbody);
    this.tableWrap.append(this.table);

    const bulk = el('div', 'ed-row ed-row--wrap');
    this.allH = numberInput({ value: 60, min: 1, max: 1000, step: 1, onChange: () => {}, title: 'Height for all waypoints (m)' });
    this.allV = numberInput({ value: 10, min: 0.5, max: 100, step: 0.5, onChange: () => {}, title: 'Speed for all legs (m/s)' });
    bulk.append(
      el('span', 'ed-label', 'All heights'), this.allH, button('Set', 'Apply this height to every waypoint', () => this.#setAll('h', +this.allH.value)),
      el('span', 'ed-label', 'All speeds'), this.allV, button('Set', 'Apply this speed to every leg', () => this.#setAll('v', +this.allV.value)),
    );
    const tools = el('div', 'ed-row ed-row--wrap');
    tools.append(
      button('Add at drone', 'Append the drone’s current position, height and speed', () => this.#addAtDrone()),
      button('Reverse', 'Fly the waypoints in the opposite order', () => this.#reverse()),
      button('Clear', 'Remove all waypoints', () => this.#clear()),
    );
    const from = el('div', 'ed-row ed-row--wrap');
    this.fromPatternBtn = button('From current pattern', 'Turn the pattern being flown into editable waypoints', () => this.#fromPattern());
    this.fromFreeBtn = button('From last free flight', 'Turn your last manual flight into a repeatable profile', () => this.fromFreeFlight());
    from.append(el('span', 'ed-label', 'New from'), this.fromPatternBtn, this.fromFreeBtn);

    this.stats = el('p', 'ed-stats');
    this.warn = el('ul', 'ed-warn');

    const actions = el('div', 'ed-row ed-row--wrap ed-actions');
    this.flyBtn = button('Fly this profile', 'Fly the drone along this plan', () => this.#fly(), 'btn btn--primary');
    actions.append(
      this.flyBtn,
      button('Copy link', 'Link that opens GeoRfSim with this plan', () => this.#copyLink()),
      button('Export', 'Save this profile as a JSON file', () => this.#export()),
      button('Import', 'Load profiles from a JSON file', () => this.#import()),
    );

    this.empty = el('p', 'ed-hint', 'No flight profiles yet. Create one with “New”, or turn the current pattern or a free flight into one.');
    b.append(row1, this.empty, nameRow, endRow, mapRow, this.mapHint, this.tableWrap, bulk, tools, from, this.stats, this.warn, actions);
    this.editBlocks = [nameRow, endRow, mapRow, this.mapHint, this.tableWrap, bulk, tools, this.stats, this.warn];
  }

  // ------------------------------------------------------------------ rendering

  #syncSelect() {
    this.selProfile.textContent = '';
    for (const p of this.profiles) {
      const scn = SCENARIO_BY_ID[p.scenario];
      this.selProfile.append(new Option(`${p.name}${scn ? ` · ${scn.name.split(' ·')[0]}` : ''}`, p.id));
    }
    if (this.cur) this.selProfile.value = this.cur.id;
  }

  render() {
    this.#syncSelect();
    const has = !!this.cur;
    this.empty.hidden = has;
    for (const blk of this.editBlocks) blk.hidden = !has;
    this.mapHint.hidden = !has || !this.mapEdit;
    this.flyBtn.disabled = !has || !this.cur.waypoints.length;
    const app = this.app;
    this.fromPatternBtn.disabled = app.state.cfg.pattern === 'custom' || !!app.sim.free;
    this.fromFreeBtn.disabled = !(app.sim.freeStartT >= 0);
    if (!has) return;
    const p = this.cur;
    if (document.activeElement !== this.nameIn) this.nameIn.value = p.name;
    for (const btn of this.endSeg.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.end === p.end));
    const baro = app.state.cfg.altRef === 'baro';
    this.hHead.textContent = baro ? 'Alt. m' : 'Height m';
    this.hHead.title = baro ? 'Altitude above the take-off point (barometric)' : 'Height above the ground (AGL)';
    const flying = app.state.cfg.pattern === 'custom' && app.state.cfg.profileId === p.id;
    this.flyBtn.textContent = flying ? 'Restart this profile' : 'Fly this profile';
    this.#renderTable();
    this.#renderStats();
  }

  #renderTable() {
    const p = this.cur;
    this.tbody.textContent = '';
    p.waypoints.forEach((w, i) => {
      const tr = el('tr');
      if (i === this.sel) tr.className = 'is-sel';
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input,button')) return;
        this.select(i);
      });
      const set = (key) => (v) => {
        w[key] = v;
        this.commit();
      };
      const del = button('✕', 'Delete waypoint', () => this.remove(i), 'btn btn--mini');
      const up = button('↑', 'Move up', () => this.#move(i, -1), 'btn btn--mini');
      const dn = button('↓', 'Move down', () => this.#move(i, 1), 'btn btn--mini');
      up.disabled = i === 0;
      dn.disabled = i === p.waypoints.length - 1;
      const tdAct = el('td', 'ed-act');
      tdAct.append(up, dn, del);
      const cell = (input) => {
        const td = el('td', 'num');
        td.append(input);
        return td;
      };
      tr.append(
        el('td', 'ed-idx', String(i + 1)),
        cell(numberInput({ value: +w.h.toFixed(1), min: 1, max: 1000, step: 1, onChange: set('h'), title: this.app.state.cfg.altRef === 'baro' ? 'Altitude above the take-off point (m)' : 'Height above ground (m)' })),
        cell(numberInput({ value: +w.v.toFixed(1), min: 0.5, max: 100, step: 0.5, onChange: set('v'), title: 'Speed of the leg that starts here (m/s)' })),
        cell(numberInput({ value: Math.round(w.hold), min: 0, max: 600, step: 1, onChange: set('hold'), title: 'Hover here for this long (s); multirotors only' })),
        tdAct,
      );
      this.tbody.append(tr);
    });
    if (!p.waypoints.length) {
      const tr = el('tr');
      const td = el('td', 'ed-hint', this.mapEdit ? 'Click on the ground in the 3-D view to add the first waypoint.' : 'No waypoints yet - switch on “Edit on map” and click on the ground.');
      td.colSpan = 5;
      tr.append(td);
      this.tbody.append(tr);
    }
  }

  #renderStats() {
    const p = this.cur;
    const app = this.app;
    const drone = app.drone();
    this.warn.textContent = '';
    const warn = (t) => this.warn.append(el('li', '', t));
    if (!p.waypoints.length) {
      this.stats.textContent = '';
      return;
    }
    const st = profileStats(p, drone);
    this.stats.textContent = `${p.waypoints.length} waypoint${p.waypoints.length > 1 ? 's' : ''} · ${fmtDist(st.len)} per round · ≈ ${fmtDuration(st.time)} with ${drone.name}`;
    if (st.maxClimb > drone.climb + 0.05) warn(`A leg asks for ${st.maxClimb.toFixed(1)} m/s climb or descent; this drone manages ${drone.climb} m/s, so it will lag behind the plan.`);
    const fast = p.waypoints.filter((w) => w.v > drone.vMax).length;
    if (fast) warn(`${fast} leg${fast > 1 ? 's are' : ' is'} faster than the drone’s ${drone.vMax} m/s and will be capped.`);
    if (drone.vMin && p.waypoints.some((w) => w.v < drone.vMin)) warn(`Legs slower than ${drone.vMin} m/s are flown at stall speed.`);
    if (drone.type === 'fixed' && p.waypoints.some((w) => w.hold > 0)) warn('A fixed wing cannot hold position; holds are ignored.');
    const world = app.sim.world;
    if (app.state.cfg.altRef === 'baro') {
      const clr = app.state.cfg.clearance;
      const low = p.waypoints.filter((w) => app.sim.homeElev + w.h - world.elevAt(w.x, w.z) < Math.min(clr, w.h)).length;
      if (low) warn(`${low} waypoint${low > 1 ? 's are' : ' is'} closer than ${clr} m to the ground at ${low > 1 ? 'their' : 'its'} altitude; the drone rises there.`);
    }
    const half = world.half;
    const out = p.waypoints.filter((w) => Math.abs(w.x) > half || Math.abs(w.z) > half).length;
    if (out) warn(`${out} waypoint${out > 1 ? 's lie' : ' lies'} outside this map.`);
    const scn = SCENARIO_BY_ID[p.scenario];
    if (scn && p.scenario !== app.state.scenario) {
      const li = el('li', '', `Made for “${scn.name}”. `);
      const adopt = button('Use it here', 'Keep the coordinates and assign the profile to this scenario', () => {
        p.scenario = app.state.scenario;
        this.commit();
      }, 'btn btn--mini');
      li.append(adopt);
      this.warn.append(li);
    }
  }

  // ------------------------------------------------------------------ editing

  commit() {
    this.#save();
    this.app.profileEdited(this.cur);
    this.render();
    this.app.markDirty();
  }

  #save() {
    if (!saveProfiles(this.profiles)) this.app.toast('Could not store profiles in this browser (private mode?)');
  }

  select(i) {
    this.sel = i;
    this.render();
    this.app.markDirty();
  }

  remove(i) {
    if (!this.cur || i < 0 || i >= this.cur.waypoints.length) return;
    this.cur.waypoints.splice(i, 1);
    this.sel = Math.min(this.sel, this.cur.waypoints.length - 1);
    this.commit();
  }

  #move(i, d) {
    const w = this.cur.waypoints;
    const j = i + d;
    if (j < 0 || j >= w.length) return;
    [w[i], w[j]] = [w[j], w[i]];
    this.sel = j;
    this.commit();
  }

  #setAll(key, v) {
    if (!this.cur || !Number.isFinite(v)) return;
    const val = key === 'h' ? clamp(v, 1, 1000) : clamp(v, 0.5, 100);
    for (const w of this.cur.waypoints) w[key] = val;
    this.commit();
  }

  #reverse() {
    if (!this.cur) return;
    this.cur.waypoints.reverse();
    this.sel = -1;
    this.commit();
  }

  #clear() {
    if (!this.cur || !this.cur.waypoints.length) return;
    if (!window.confirm(`Remove all ${this.cur.waypoints.length} waypoints of “${this.cur.name}”?`)) return;
    this.cur.waypoints = [];
    this.sel = -1;
    this.commit();
  }

  #defaults() {
    const w = this.cur.waypoints;
    const ref = w[this.sel] || w[w.length - 1];
    const cfg = this.app.state.cfg;
    return { h: ref ? ref.h : cfg.height, v: ref ? ref.v : cfg.speed };
  }

  /** Map click while editing: insert after the selected waypoint (or append). */
  addAt(x, z) {
    if (!this.cur) this.#create(true);
    const d = this.#defaults();
    const at = this.sel >= 0 ? this.sel + 1 : this.cur.waypoints.length;
    this.cur.waypoints.splice(at, 0, { x: Math.round(x), z: Math.round(z), h: d.h, v: d.v, hold: 0 });
    this.sel = at;
    this.commit();
  }

  #addAtDrone() {
    if (!this.cur) this.#create(true);
    const d = this.app.sim.dr;
    this.cur.waypoints.push({ x: Math.round(d.x), z: Math.round(d.z), h: Math.max(1, Math.round(d.agl)), v: +Math.max(d.speed, 0.5).toFixed(1), hold: 0 });
    this.sel = this.cur.waypoints.length - 1;
    this.commit();
  }

  #create(silent = false) {
    const n = this.profiles.length + 1;
    const p = sanitizeProfile({ name: `Flight ${n}`, scenario: this.app.state.scenario, end: 'loop', waypoints: [] });
    this.profiles.push(p);
    this.cur = p;
    this.sel = -1;
    this.#save();
    this.app.refreshPatterns();
    if (!silent) {
      this.setMapEdit(true);
      this.render();
    }
    return p;
  }

  #duplicate() {
    if (!this.cur) return;
    const p = sanitizeProfile({ ...JSON.parse(JSON.stringify(this.cur)), id: newId('p_'), name: `${this.cur.name} (copy)` });
    this.profiles.push(p);
    this.cur = p;
    this.#save();
    this.app.refreshPatterns();
    this.render();
  }

  #delete() {
    if (!this.cur) return;
    if (!window.confirm(`Delete the flight profile “${this.cur.name}”?`)) return;
    const id = this.cur.id;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.cur = this.profiles[0] || null;
    this.sel = -1;
    this.#save();
    this.app.profileRemoved(id);
    this.app.refreshPatterns();
    this.render();
    this.app.markDirty();
  }

  #fly() {
    if (!this.cur || !this.cur.waypoints.length) return;
    this.app.flyProfile(this.cur);
    this.render();
  }

  #fromPattern() {
    const app = this.app;
    const pat = PATTERN_BY_ID[app.state.cfg.pattern];
    const p = profileFromPath(app.sim.path, { name: pat ? pat.name : 'Pattern', scenario: app.state.scenario, speed: app.sim.flySpeed });
    this.profiles.push(p);
    this.cur = p;
    this.sel = -1;
    this.#save();
    app.refreshPatterns();
    this.render();
    app.toast(`“${p.name}” → ${p.waypoints.length} waypoints`);
  }

  /** Converts the last free flight into a profile (also called from the OSD). */
  fromFreeFlight() {
    const app = this.app;
    if (!(app.sim.freeStartT >= 0)) return null;
    const name = `Free flight ${new Date().toTimeString().slice(0, 5)}`;
    const p = profileFromTrack(app.sim.track, app.sim.freeStartT, { name, scenario: app.state.scenario, t1: app.sim.freeEndT });
    if (!p) {
      app.toast('Fly a little further first - the recording is too short');
      return null;
    }
    this.profiles.push(p);
    this.cur = p;
    this.sel = -1;
    this.#save();
    app.refreshPatterns();
    if (!this.isOpen) this.open(p.id);
    else this.render();
    app.toast(`Saved your flight as “${p.name}” (${p.waypoints.length} waypoints)`);
    return p;
  }

  #copyLink() {
    if (this.cur) shareLink(this.app.linkFor(this.cur), this.app.toast);
  }

  #export() {
    if (!this.cur) return;
    const safe = this.cur.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'flight';
    download(`georfsim-flight-${safe}.json`, exportJson('flights', [this.cur]));
  }

  async #import() {
    try {
      const items = importJson(await pickFile(), 'flights');
      for (const p of items) {
        if (this.byId(p.id)) p.id = newId('p_');
        this.profiles.push(p);
      }
      this.cur = items[0];
      this.sel = -1;
      this.#save();
      this.app.refreshPatterns();
      this.render();
      this.app.toast(`Imported ${items.length} flight profile${items.length > 1 ? 's' : ''}`);
    } catch (e) {
      if (e.message !== 'no file chosen') this.app.toast(`Import failed: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------ map interaction

  setMapEdit(on) {
    this.mapEdit = !!on && this.isOpen;
    this.mapBtn.setAttribute('aria-pressed', String(this.mapEdit));
    this.mapHint.hidden = !this.mapEdit || !this.cur;
    document.getElementById('viewport').classList.toggle('is-editing', this.mapEdit);
    if (this.cur) this.#renderTable();
    this.app.markDirty();
  }

  /** Height above the terrain at which a waypoint's marker is drawn (its altitude in barometric mode). */
  #markAgl(w, e) {
    const app = this.app;
    if (app.state.cfg.altRef !== 'baro') return w.h;
    return Math.max(app.sim.homeElev + w.h - (e ?? app.sim.world.elevAt(w.x, w.z)), 0.5);
  }

  /** Index of the waypoint marker under a client position, or −1. */
  hitTest(cx, cy) {
    if (!this.mapEdit || !this.cur) return -1;
    const r = this.app.canvasRect();
    let best = -1;
    let bd = 14;
    this.cur.waypoints.forEach((w, i) => {
      for (const h of [this.#markAgl(w), 0]) {
        const p = this.app.project(w.x, w.z, h);
        if (!p) continue;
        const d = Math.hypot(p[0] + r.left - cx, p[1] + r.top - cy);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    });
    return best;
  }

  /** Pointer-down hook from the camera controls: start dragging a marker. */
  intercept(e) {
    if (!this.mapEdit || e.button !== 0) return false;
    const i = this.hitTest(e.clientX, e.clientY);
    if (i < 0) return false;
    this.sel = i;
    const id = e.pointerId;
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      const p = this.app.pick(ev.clientX, ev.clientY);
      if (!p) return;
      const w = this.cur.waypoints[i];
      w.x = Math.round(p.x);
      w.z = Math.round(p.z);
      moved = true;
      this.app.markDirty();
    };
    const up = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.drag = null;
      if (moved) this.commit();
      else this.render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.drag = { i };
    this.app.markDirty();
    return true;
  }

  /** Right-click while editing: delete the marker under the pointer. */
  context(cx, cy) {
    const i = this.hitTest(cx, cy);
    if (i >= 0) this.remove(i);
    return i >= 0;
  }

  /** Plain click on the map while editing: add a waypoint there. */
  click(cx, cy) {
    if (!this.mapEdit) return false;
    if (this.hitTest(cx, cy) >= 0) return true;
    const p = this.app.pick(cx, cy);
    if (p) this.addAt(p.x, p.z);
    return true;
  }

  /** Markers, planned path and numbers for the 3-D view (called every rendered frame). */
  overlay() {
    const res = { plan: [], marks: [] };
    if (!this.isOpen || !this.cur || !this.cur.waypoints.length) {
      for (const l of this.labels) l.hidden = true;
      return res;
    }
    const app = this.app;
    const w = app.sim.world;
    const p = this.cur;
    const drone = app.drone();
    const cfg = app.state.cfg;
    const key = `${JSON.stringify(p)}|${drone.id}|${cfg.avoid}|${cfg.altRef}|${cfg.clearance}|${w.pilot.x},${w.pilot.z}|${w.scn.id}`;
    if (key !== this.planCache.key) {
      const path = buildPath(w, drone, { ...cfg, pattern: 'custom', profile: p, speed: drone.vCruise });
      const pts = [];
      const step = Math.max(1, Math.floor(path.x.length / 900));
      for (let i = 0; i < path.x.length; i += step) pts.push([path.x[i], path.z[i], w.elevAt(path.x[i], path.z[i]), path.agl[i], PLAN]);
      if (!path.open && pts.length > 2) pts.push(pts[0]);
      this.planCache = { key, lines: [pts] };
    }
    res.plan = this.planCache.lines;
    const r = w.S / 160;
    p.waypoints.forEach((wp, i) => {
      const e = w.elevAt(wp.x, wp.z);
      const c = i === this.sel ? MARK_SEL : MARK;
      const h = this.#markAgl(wp, e);
      res.marks.push([[wp.x, wp.z, e, 0, [c[0], c[1], c[2], 0.35]], [wp.x, wp.z, e, h, c]]);
      res.marks.push([[wp.x - r, wp.z, e, h, c], [wp.x + r, wp.z, e, h, c]]);
      res.marks.push([[wp.x, wp.z - r, e, h, c], [wp.x, wp.z + r, e, h, c]]);
    });
    // numbers
    while (this.labels.length < p.waypoints.length) {
      const l = el('div', 'lbl lbl--wp');
      this.labelBox.append(l);
      this.labels.push(l);
    }
    this.labels.forEach((l, i) => {
      const wp = p.waypoints[i];
      if (!wp) {
        l.hidden = true;
        return;
      }
      const s = app.project(wp.x, wp.z, this.#markAgl(wp));
      if (!s) {
        l.hidden = true;
        return;
      }
      l.hidden = false;
      l.classList.toggle('is-sel', i === this.sel);
      l.style.left = `${s[0]}px`;
      l.style.top = `${s[1]}px`;
      const text = `${i + 1} · ${Math.round(wp.h)} m${cfg.altRef === 'baro' ? ' alt' : ''}${wp.hold > 0 ? ` · ${Math.round(wp.hold)} s` : ''}`;
      if (l.textContent !== text) l.textContent = text;
    });
    return res;
  }
}
