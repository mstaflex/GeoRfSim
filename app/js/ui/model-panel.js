/*
 * Model parameters in the settings drawer: scalar knobs (vegetation, obstacles,
 * ground, noise) and the scattering / fading values of each environment class.
 * Changes act on the running simulation at once and travel inside the link;
 * a changed value shows a ↺ to put it back.
 */
import { el, button } from './dom.js';
import {
  MODEL, DEFAULT_MODEL, MODEL_SPECS, ENV_SPECS, ENVS, DEFAULT_ENVS, getEnvParam, setEnvParam, setModelParam, resetModel, modelChanges,
} from '../rf/models.js';

const ENV_TABS = [['open', 'Open'], ['forest', 'Forest'], ['suburban', 'Suburb'], ['urban', 'Urban'], ['dense', 'Dense'], ['water', 'Water']];

function fmt(spec, v) {
  switch (spec.unit) {
    case '%':
      return `${Math.round(v * 100)} %`;
    case '×':
      return `${v.toFixed(2)}×`;
    case 'ns':
    case 'm':
      return `${Math.round(v)} ${spec.unit}`;
    default:
      return `${v.toFixed(1)} ${spec.unit}`;
  }
}

export class ModelPanel {
  /** host: { onChange(), currentEnv() } - currentEnv names the class the primary link sees now. */
  constructor(body, host) {
    this.host = host;
    this.rows = [];
    this.env = 'urban';
    this.#build(body);
  }

  #build(body) {
    const head = el('div', 'set-group set-group--model');
    head.append(el('span', '', 'Model parameters'));
    this.resetBtn = button('Reset all', 'Put every model parameter back to its default', () => {
      resetModel();
      this.sync();
      this.host.onChange();
    }, 'btn btn--mini');
    head.append(this.resetBtn);
    body.append(head);
    this.summary = el('p', 'set-note');
    body.append(this.summary);

    let group = '';
    for (const spec of MODEL_SPECS) {
      if (spec.group !== group) {
        group = spec.group;
        body.append(el('div', 'set-sub', group));
      }
      body.append(this.#row(spec, () => MODEL[spec.key], () => DEFAULT_MODEL[spec.key], (v) => setModelParam(spec.key, v)));
    }

    body.append(el('div', 'set-sub', 'Scattering & fading by environment'));
    this.tabs = el('div', 'seg seg--small set-tabs');
    this.tabs.setAttribute('role', 'group');
    this.tabs.setAttribute('aria-label', 'Environment class');
    for (const [env, label] of ENV_TABS) {
      const b = el('button', '', label);
      b.type = 'button';
      b.dataset.env = env;
      b.title = ENVS[env].name;
      b.addEventListener('click', () => {
        this.env = env;
        this.sync();
      });
      this.tabs.append(b);
    }
    body.append(this.tabs);
    this.envNote = el('p', 'set-note');
    body.append(this.envNote);
    for (const spec of ENV_SPECS) {
      body.append(this.#row(spec, () => getEnvParam(this.env, spec.key), () => this.#envDefault(spec.key), (v) => setEnvParam(this.env, spec.key, v), true));
    }
  }

  #envDefault(key, env = this.env) {
    const d = DEFAULT_ENVS[env];
    return key === 'ism0' ? d.ism[0] : d[key];
  }

  /** One parameter row: label, ↺ when changed, range (or checkbox) and the value. */
  #row(spec, get, dflt, set, perEnv = false) {
    const check = spec.type === 'check';
    const row = el('div', check ? 'set-row set-row--check set-row--param' : 'set-row set-row--param');
    const id = `model-${perEnv ? 'env-' : ''}${spec.key}`;
    const label = el('label', '', spec.label);
    label.htmlFor = id;
    label.title = spec.help;
    const out = check ? null : el('output');
    const undo = button('↺', 'Back to the default', () => {
      set(dflt());
      this.sync();
      this.host.onChange();
    }, 'btn btn--mini set-undo');
    let input;
    if (check) {
      input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        set(input.checked);
        this.sync();
        this.host.onChange();
      });
      label.append(undo);
    } else {
      input = el('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.addEventListener('input', () => {
        set(+input.value);
        this.sync();
        this.host.onChange();
      });
      label.append(out, undo);
    }
    input.id = id;
    input.title = spec.help;
    row.append(label, input);
    this.rows.push({ spec, get, dflt, input, out, undo, row });
    return row;
  }

  /** Re-reads every value (also after a link set them) and marks the changed ones. */
  sync(pickEnv = false) {
    if (pickEnv) {
      const now = this.host.currentEnv();
      if (now && ENVS[now]) this.env = now;
    }
    for (const r of this.rows) {
      const v = r.get();
      const changed = v !== r.dflt();
      if (r.spec.type === 'check') r.input.checked = !!v;
      else if (document.activeElement !== r.input) r.input.value = String(v);
      if (r.out) r.out.textContent = fmt(r.spec, v);
      r.undo.hidden = !changed;
      r.row.classList.toggle('is-changed', changed);
      if (changed) r.undo.title = `Back to the default (${r.spec.type === 'check' ? (r.dflt() ? 'on' : 'off') : fmt(r.spec, r.dflt())})`;
    }
    for (const b of this.tabs.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.env === this.env));
      const changed = ENV_SPECS.some((s) => getEnvParam(b.dataset.env, s.key) !== this.#envDefault(s.key, b.dataset.env));
      b.classList.toggle('is-changed', changed);
    }
    const now = this.host.currentEnv();
    this.envNote.textContent = `Lower K = more scattered power and deeper fades. ${ENVS[this.env].name}${now === this.env ? ' is what the selected link sees right now.' : `; the selected link sees ${ENVS[now]?.name || '–'} right now.`}`;
    const n = modelChanges().length;
    this.summary.textContent = n
      ? `${n} parameter${n > 1 ? 's differ' : ' differs'} from the defaults. They act at once and travel in the link.`
      : 'Typical values from the literature. Changes act at once and travel in the link.';
    this.resetBtn.disabled = !n;
  }
}
