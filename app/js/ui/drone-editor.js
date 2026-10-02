/*
 * Drone profile editor. Built-in airframes are read-only templates; duplicate
 * one (or start new) to get an editable custom drone. Changes apply live when
 * that drone is being flown. Custom drones live in localStorage and travel as
 * JSON files or inside a link.
 */
import { $, el, button, download, pickFile, shareLink } from './dom.js';
import {
  DRONE_FIELDS, DRONE_TYPES, DRONE_MODELS, sanitizeDrone, newId, registerDrone, unregisterDrone, saveCustomDrones,
  customDrones, droneFigures, exportJson, importJson,
} from '../profiles.js';
import { DRONES, DRONE_BY_ID } from '../flight.js';
import { ANTENNAS, AIR_ANTENNA_IDS } from '../rf/antennas.js';
import { fmtHz } from '../util.js';

export class DroneEditor {
  /** app: { state, setDrone(id), droneEdited(d), droneRemoved(id), refreshDrones(), toast, linkForDrone(d), onDrawer(name, open) } */
  constructor(app) {
    this.app = app;
    this.root = $('drone-editor');
    this.body = $('de-body');
    this.curId = null;
    this.#build();
    $('de-close').addEventListener('click', () => this.close());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  get cur() {
    return DRONE_BY_ID[this.curId] || null;
  }

  open(id) {
    this.root.hidden = false;
    this.curId = DRONE_BY_ID[id] ? id : this.app.state.cfg.drone;
    this.render();
    this.app.onDrawer('drone', true);
  }

  close() {
    this.root.hidden = true;
    this.app.onDrawer('drone', false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  #build() {
    const b = this.body;
    const row = el('div', 'ed-row');
    this.sel = el('select', 'ed-grow');
    this.sel.setAttribute('aria-label', 'Drone profile');
    this.sel.addEventListener('change', () => {
      this.curId = this.sel.value;
      this.render();
    });
    row.append(
      this.sel,
      button('New', 'New custom drone', () => this.#create()),
      button('Duplicate', 'Editable copy of this drone', () => this.#duplicate()),
    );
    this.delBtn = button('Delete', 'Delete this custom drone', () => this.#delete());
    row.append(this.delBtn);
    this.ro = el('p', 'ed-hint', 'Built-in profile - read only. Duplicate it to make an editable copy.');

    this.nameIn = el('input', 'ed-text');
    this.nameIn.type = 'text';
    this.nameIn.maxLength = 60;
    this.nameIn.addEventListener('input', () => this.#set('name', this.nameIn.value));
    const nameRow = el('label', 'ed-field');
    nameRow.append(el('span', '', 'Name'), this.nameIn);

    this.typeSeg = el('div', 'seg seg--small');
    this.typeSeg.setAttribute('role', 'group');
    this.typeSeg.setAttribute('aria-label', 'Airframe type');
    for (const [t, label] of DRONE_TYPES) {
      const btn = el('button', '', label);
      btn.type = 'button';
      btn.dataset.type = t;
      btn.addEventListener('click', () => this.#set('type', t));
      this.typeSeg.append(btn);
    }
    const typeRow = el('div', 'ed-field');
    typeRow.append(el('span', '', 'Type'), this.typeSeg);

    this.modelSel = el('select');
    for (const [m, label] of DRONE_MODELS) this.modelSel.append(new Option(label, m));
    this.modelSel.addEventListener('change', () => this.#set('model', this.modelSel.value));
    const modelRow = el('label', 'ed-field');
    modelRow.append(el('span', '', 'Looks like'), this.modelSel);

    this.grid = el('div', 'ed-grid');
    this.inputs = {};
    for (const f of DRONE_FIELDS) {
      const lab = el('label', 'ed-num');
      const i = el('input', 'num-in');
      i.type = 'number';
      i.min = String(f.min);
      i.max = String(f.max);
      i.step = String(f.step);
      i.addEventListener('change', () => {
        if (i.value.trim() === '' || !Number.isFinite(Number(i.value))) i.value = String(this.cur?.[f.key] ?? ''); // emptied: value back
        else this.#set(f.key, Number(i.value));
      });
      lab.append(el('span', '', f.label), i, el('small', '', f.unit));
      this.grid.append(lab);
      this.inputs[f.key] = { input: i, label: lab, f };
    }

    this.antSel = el('select');
    this.antSel.append(new Option('Auto (each radio’s typical antenna)', 'auto'));
    for (const id of AIR_ANTENNA_IDS) this.antSel.append(new Option(ANTENNAS[id].name, id));
    this.antSel.addEventListener('change', () => this.#set('airAnt', this.antSel.value));
    const antRow = el('label', 'ed-field');
    antRow.append(el('span', '', 'Antenna on board'), this.antSel);

    this.figs = el('dl', 'ed-figs');
    const actions = el('div', 'ed-row ed-row--wrap ed-actions');
    this.useBtn = button('Fly this drone', 'Select this drone for the flight', () => this.app.setDrone(this.curId), 'btn btn--primary');
    actions.append(
      this.useBtn,
      button('Copy link', 'Link that opens GeoRfSim with this drone', () => this.#copyLink()),
      button('Export', 'Save this drone as a JSON file', () => this.#export()),
      button('Import', 'Load drones from a JSON file', () => this.#import()),
    );
    b.append(row, this.ro, nameRow, typeRow, modelRow, this.grid, antRow, el('h3', 'ed-sub', 'What follows from it'), this.figs, actions);
    this.editables = [this.nameIn, this.modelSel, this.antSel, ...this.typeSeg.querySelectorAll('button'), ...Object.values(this.inputs).map((x) => x.input)];
  }

  render() {
    const d = this.cur;
    if (!d) return;
    this.sel.textContent = '';
    const g1 = document.createElement('optgroup');
    g1.label = 'Built-in';
    for (const x of DRONES) g1.append(new Option(x.name, x.id));
    this.sel.append(g1);
    const customs = customDrones();
    if (customs.length) {
      const g2 = document.createElement('optgroup');
      g2.label = 'Custom';
      for (const x of customs) g2.append(new Option(x.name, x.id));
      this.sel.append(g2);
    }
    this.sel.value = d.id;
    const ro = !d.custom;
    this.ro.hidden = !ro;
    this.delBtn.disabled = ro;
    for (const e of this.editables) e.disabled = ro;
    if (document.activeElement !== this.nameIn) this.nameIn.value = d.name;
    for (const btn of this.typeSeg.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.type === d.type));
    this.modelSel.value = d.model;
    this.antSel.value = d.airAnt || 'auto';
    for (const { input, label, f } of Object.values(this.inputs)) {
      const applies = !f.types || f.types.includes(d.type);
      label.hidden = !applies;
      if (document.activeElement !== input) input.value = String(d[f.key] ?? '');
    }
    this.useBtn.textContent = this.app.state.cfg.drone === d.id ? 'Flying this drone' : 'Fly this drone';
    this.useBtn.disabled = this.app.state.cfg.drone === d.id;
    this.#figures(d);
  }

  #figures(d) {
    const f = droneFigures(d);
    this.figs.textContent = '';
    const add = (k, v) => {
      const box = el('div');
      box.append(el('dt', '', k), el('dd', '', v));
      this.figs.append(box);
    };
    add('Turn radius', `${Math.round(f.turnCruise)} m at cruise · ${Math.round(f.turnMax)} m at max`);
    if (f.stop !== null) add('Stop from cruise', `${f.stop.toFixed(1)} m · tilt at cruise ${Math.round(f.tiltCruise)}°`);
    if (f.bankTurnRate !== null) add('Turn rate at max bank', `${Math.round(f.bankTurnRate)} °/s at cruise`);
    add('Max Doppler shift', `${fmtHz(f.dopplerMax(868e6))} @ 868 MHz · ${fmtHz(f.dopplerMax(2.44e9))} @ 2.4 GHz · ${fmtHz(f.dopplerMax(5.8e9))} @ 5.8 GHz`);
    add('Climb', `${d.climb} m/s · 100 m in ${Math.round(100 / d.climb)} s`);
  }

  #set(key, value) {
    const d = this.cur;
    if (!d || !d.custom) return;
    const raw = { ...d, [key]: value };
    // a new airframe type brings a fitting look (a plane does not look like a quad)
    if (key === 'type') {
      const rotor = !['plane', 'vtol'].includes(d.model);
      raw.model = value === 'fixed' ? 'plane' : value === 'vtol' ? 'vtol' : rotor ? d.model : 'quad';
      if (value === 'fixed' && !d.vMin) delete raw.vMin; // the sanitizer picks a sensible stall speed
    }
    const next = sanitizeDrone(raw, d.id);
    Object.assign(d, next);
    registerDrone(d);
    saveCustomDrones();
    this.app.droneEdited(d);
    if (key === 'name') this.app.refreshDrones();
    this.render();
  }

  #create() {
    const base = DRONE_BY_ID.prosumer;
    const d = registerDrone(sanitizeDrone({ ...base, id: newId('u_'), name: `My drone ${customDrones().length + 1}` }));
    this.#added(d);
  }

  #duplicate() {
    const src = this.cur;
    if (!src) return;
    const d = registerDrone(sanitizeDrone({ ...src, id: newId('u_'), name: `${src.name} (copy)` }));
    this.#added(d);
  }

  #added(d) {
    saveCustomDrones();
    this.curId = d.id;
    this.app.refreshDrones();
    this.render();
    this.nameIn.focus();
    this.nameIn.select();
  }

  #delete() {
    const d = this.cur;
    if (!d || !d.custom) return;
    if (!window.confirm(`Delete the drone profile “${d.name}”?`)) return;
    unregisterDrone(d.id);
    saveCustomDrones();
    this.app.droneRemoved(d.id);
    this.curId = this.app.state.cfg.drone;
    this.app.refreshDrones();
    this.render();
  }

  #copyLink() {
    if (this.cur) shareLink(this.app.linkForDrone(this.cur), this.app.toast);
  }

  #export() {
    const d = this.cur;
    if (!d) return;
    const { custom, ...plain } = d;
    const safe = d.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'drone';
    download(`georfsim-drone-${safe}.json`, exportJson('drones', [plain]));
  }

  async #import() {
    try {
      const items = importJson(await pickFile(), 'drones');
      for (const d of items) {
        if (DRONE_BY_ID[d.id]) d.id = newId('u_');
        registerDrone(d);
      }
      saveCustomDrones();
      this.curId = items[0].id;
      this.app.refreshDrones();
      this.render();
      this.app.toast(`Imported ${items.length} drone profile${items.length > 1 ? 's' : ''}`);
    } catch (e) {
      if (e.message !== 'no file chosen') this.app.toast(`Import failed: ${e.message}`);
    }
  }
}
