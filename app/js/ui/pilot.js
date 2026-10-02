/*
 * Free flight: stick input (keyboard in "Mode 2" layout, game pads, an RC
 * transmitter in USB-joystick mode, or the on-screen sticks by touch or
 * mouse), an on-screen display like a drone app,
 * return-to-home, and a failsafe that triggers RTH when the simulated control
 * link really drops (its packet error rate over the last second > 90 %).
 */
import { $, el, button } from './dom.js';
import { TECHS } from '../rf/tech.js';
import { clamp, fmtDist } from '../util.js';

const MAPPINGS = [
  ['keyboard', 'Keyboard'],
  ['pad2', 'Gamepad · Mode 2'],
  ['pad1', 'Gamepad · Mode 1'],
  ['aetr', 'RC transmitter · AETR'],
  ['taer', 'RC transmitter · TAER'],
];
const FLIGHT_KEYS = new Set(['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift']);
const STORE_KEY = 'georfsim.pilot';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

const dead = (v, dz = 0.06) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
const expo = (v, e = 0.3) => v * (1 - e) + v * v * v * e;

export class PilotUI {
  /** app: { sim, state, toast, setCam(mode), syncControls(), flightEditor, droneOf() } */
  constructor(app) {
    this.app = app;
    this.keys = new Set();
    this.touch = { L: null, R: null }; // on-screen sticks being dragged: {x, y} in −1…1
    this.sm = { thr: 0, yaw: 0, pitch: 0, roll: 0 };
    this.fwThr = 0;
    const prefs = loadPrefs();
    this.mapping = MAPPINGS.some(([m]) => m === prefs.mapping) ? prefs.mapping : 'keyboard';
    this.invertPitch = !!prefs.invertPitch;
    this.ctrlTech = TECHS.some((t) => t.id === prefs.ctrlTech) ? prefs.ctrlTech : 'elrs24';
    this.failsafeOn = prefs.failsafeOn !== false;
    this.lostFor = 0;
    this.failsafe = false;
    this.lastBump = -10;
    this.osdT = 0;
    this.#buildOsd();
    window.addEventListener('keyup', (e) => this.keys.delete(this.#key(e)));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => app.toast(`Controller connected: ${e.gamepad.id.slice(0, 48)}`));
  }

  get active() {
    return !!this.app.sim.free;
  }

  #savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ mapping: this.mapping, invertPitch: this.invertPitch, ctrlTech: this.ctrlTech, failsafeOn: this.failsafeOn }));
    } catch {
      /* not remembered */
    }
  }

  toggle() {
    if (this.active) this.stop();
    else this.start();
  }

  start() {
    const app = this.app;
    if (!app.sim.dr || this.active) return;
    app.sim.startFree();
    this.keys.clear();
    this.sm = { thr: 0, yaw: 0, pitch: 0, roll: 0 };
    this.fwThr = 0;
    this.failsafe = false;
    this.lostFor = 0;
    this.osd.hidden = false;
    if (!app.state.playing) {
      app.state.playing = true;
    }
    app.setCam('chase');
    app.syncControls();
    const fixed = app.droneOf().type === 'fixed';
    app.toast(fixed ? 'Free flight · W/S throttle · arrows: ↑↓ dive/climb, ←→ bank · H home' : 'Free flight · W/S up/down · A/D turn · arrows move · H home');
  }

  stop() {
    const app = this.app;
    if (!this.active) return;
    app.sim.stopFree();
    this.osd.hidden = true;
    this.keys.clear();
    app.setCam('follow');
    app.syncControls();
  }

  #key(e) {
    return e.key.length === 1 ? e.key.toLowerCase() : e.key;
  }

  /** keydown from the app; returns true when the key belongs to the flight controls. */
  keyDown(e) {
    if (!this.active) return false;
    const k = this.#key(e);
    if (FLIGHT_KEYS.has(k)) {
      this.keys.add(k);
      return true;
    }
    if (k === 'h') {
      this.toggleRth();
      return true;
    }
    return false;
  }

  toggleRth() {
    const sim = this.app.sim;
    if (!this.active) return;
    sim.setRth(!sim.rth);
    if (!sim.rth) this.failsafe = false;
    this.app.toast(sim.rth ? 'Returning home' : 'Return home cancelled');
  }

  // ------------------------------------------------------------------ input

  #readKeyboard(dt, fixed) {
    const k = this.keys;
    const ax = (pos, neg) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    const fine = k.has('Shift') ? 0.35 : 1;
    let thr = ax('w', 's');
    if (fixed) {
      // a fixed wing's throttle stays where you leave it
      this.fwThr = clamp(this.fwThr + thr * 0.8 * dt, -1, 1);
      thr = this.fwThr;
    }
    const target = { thr, yaw: ax('d', 'a') * fine, pitch: ax('ArrowUp', 'ArrowDown') * fine, roll: ax('ArrowRight', 'ArrowLeft') * fine };
    const a = 1 - Math.exp(-dt / 0.12);
    for (const key of ['yaw', 'pitch', 'roll']) this.sm[key] += (target[key] - this.sm[key]) * a;
    this.sm.thr = fixed ? thr : this.sm.thr + (thr - this.sm.thr) * a;
    return { ...this.sm };
  }

  #pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.axes.length >= 4) return p;
    return null;
  }

  #readPad(p) {
    const a = p.axes.map((v) => dead(v));
    // an RC throttle does not spring back: mid-stick holds altitude within a ±10 % band (as in AltHold modes)
    const rcThr = (v) => dead(v, 0.1);
    let inp;
    switch (this.mapping) {
      case 'pad1':
        inp = { thr: -a[3], yaw: a[0], pitch: -a[1], roll: a[2] };
        break;
      case 'aetr':
        inp = { roll: a[0], pitch: a[1], thr: rcThr(p.axes[2]), yaw: a[3] };
        break;
      case 'taer':
        inp = { thr: rcThr(p.axes[0]), roll: a[1], pitch: a[2], yaw: a[3] };
        break;
      default:
        inp = { thr: -a[1], yaw: a[0], pitch: -a[3], roll: a[2] };
    }
    if (this.invertPitch) inp.pitch = -inp.pitch;
    for (const k of ['yaw', 'pitch', 'roll']) inp[k] = expo(clamp(inp[k], -1, 1));
    inp.thr = clamp(inp.thr, -1, 1);
    // RTH / exit on the face buttons of a game pad
    const pressed = (i) => p.buttons[i] && p.buttons[i].pressed;
    if (pressed(3) && !this.padY) this.toggleRth();
    this.padY = pressed(3);
    return inp;
  }

  /** Called every frame before the simulation steps. */
  update(dt) {
    if (!this.active) return;
    const app = this.app;
    const sim = app.sim;
    const fixed = app.droneOf().type === 'fixed';
    const pad = this.mapping !== 'keyboard' ? this.#pad() : null;
    this.padMissing = this.mapping !== 'keyboard' && !pad;
    const inp = pad ? this.#readPad(pad) : this.#readKeyboard(dt, fixed);
    // a dragged on-screen stick overrides its two axes (Mode 2: left = throttle & yaw, right = pitch & roll)
    if (this.touch.L) {
      inp.yaw = expo(this.touch.L.x);
      inp.thr = this.touch.L.y;
    }
    if (this.touch.R) {
      inp.roll = expo(this.touch.R.x);
      inp.pitch = expo(this.touch.R.y);
    }
    this.input = inp;

    // failsafe: the control link's packet error rate over the last second
    const idx = TECHS.findIndex((t) => t.id === this.ctrlTech);
    const per = sim.recentPer(idx, 1);
    this.lq = 1 - per;
    const lost = per > 0.9;
    this.lostFor = lost ? this.lostFor + dt * app.state.warp : 0;
    if (this.failsafeOn && this.lostFor > 1 && !sim.rth) {
      sim.setRth(true);
      this.failsafe = true;
      app.toast(`Failsafe: ${TECHS[idx].name} link lost → returning home`);
    }
    const moving = Math.max(Math.abs(inp.yaw), Math.abs(inp.pitch), Math.abs(inp.roll), fixed ? 0 : Math.abs(inp.thr)) > 0.3;
    if (sim.rth && moving && !(this.failsafe && lost)) {
      sim.setRth(false);
      this.failsafe = false;
      app.toast('You have control');
    }
    // without a link the drone does not hear the sticks
    sim.input = this.failsafeOn && lost ? { thr: 0, yaw: 0, pitch: 0, roll: 0 } : inp;

    for (const ev of sim.events.splice(0)) {
      if (ev.type === 'bump' && ev.t - this.lastBump > 2) {
        this.lastBump = ev.t;
        app.toast('Bump! The drone hit an obstacle');
      }
    }
    this.osdT += dt;
    if (this.osdT > 0.1) {
      this.osdT = 0;
      this.#renderOsd();
    }
  }

  // ------------------------------------------------------------------ OSD

  #buildOsd() {
    const o = $('osd');
    this.osd = o;
    this.stickL = el('canvas', 'osd__stick');
    this.stickR = el('canvas', 'osd__stick');
    for (const c of [this.stickL, this.stickR]) {
      c.width = 128;
      c.height = 128;
    }
    this.stickL.title = 'Left stick: throttle (up/down) and yaw - drag it';
    this.stickR.title = 'Right stick: pitch (forward/back) and roll - drag it';
    this.#bindStick(this.stickL, 'L');
    this.#bindStick(this.stickR, 'R');
    const mid = el('div', 'osd__mid');
    this.read = {};
    const row1 = el('div', 'osd__row');
    for (const [k, label] of [['alt', 'ALT'], ['vs', 'VS'], ['spd', 'SPD'], ['hdg', 'HDG'], ['home', 'HOME']]) {
      const s = el('span', 'osd__val');
      s.append(el('small', '', label));
      const b = el('b', '', '–');
      s.append(b);
      row1.append(s);
      this.read[k] = b;
    }
    this.arrow = el('span', 'osd__arrow', '➤');
    this.arrow.title = 'Direction to the pilot';
    row1.append(this.arrow);
    const row2 = el('div', 'osd__row');
    this.lqEl = el('span', 'osd__val');
    this.lqEl.append(el('small', '', 'LQ'));
    this.read.lq = el('b', '', '–');
    this.lqEl.append(this.read.lq);
    this.mode = el('span', 'osd__mode', 'MANUAL');
    this.hint = el('span', 'osd__hint');
    row2.append(this.lqEl, this.mode, this.hint);

    const row3 = el('div', 'osd__row osd__row--ctl');
    this.rthBtn = button('Return home', 'Fly back and land next to the pilot (H)', () => this.toggleRth());
    const save = button('Save as flight profile', 'Turn this flight into a repeatable waypoint profile', () => this.app.flightEditor.fromFreeFlight());
    this.mapSel = el('select');
    this.mapSel.setAttribute('aria-label', 'Input device');
    for (const [m, label] of MAPPINGS) this.mapSel.append(new Option(label, m));
    this.mapSel.value = this.mapping;
    this.mapSel.addEventListener('change', () => {
      this.mapping = this.mapSel.value;
      this.mapSel.blur();
      this.#savePrefs();
      if (this.mapping !== 'keyboard') this.app.toast('Move a stick or press a button on the controller so the browser sees it');
    });
    this.invSel = el('label', 'osd__check');
    const inv = el('input');
    inv.type = 'checkbox';
    inv.checked = this.invertPitch;
    inv.addEventListener('change', () => {
      this.invertPitch = inv.checked;
      inv.blur();
      this.#savePrefs();
    });
    this.invSel.append(inv, document.createTextNode('invert pitch'));
    this.ctrlSel = el('select');
    this.ctrlSel.setAttribute('aria-label', 'Control link for the failsafe');
    for (const t of TECHS) this.ctrlSel.append(new Option(`link: ${t.name}`, t.id));
    this.ctrlSel.value = this.ctrlTech;
    this.ctrlSel.addEventListener('change', () => {
      this.ctrlTech = this.ctrlSel.value;
      this.ctrlSel.blur();
      this.#savePrefs();
    });
    const fs = el('label', 'osd__check');
    const fsIn = el('input');
    fsIn.type = 'checkbox';
    fsIn.checked = this.failsafeOn;
    fsIn.addEventListener('change', () => {
      this.failsafeOn = fsIn.checked;
      fsIn.blur();
      this.#savePrefs();
    });
    fs.append(fsIn, document.createTextNode('failsafe RTH'));
    fs.title = 'Return home when the control link is lost for more than a second';
    row3.append(this.rthBtn, save, this.mapSel, this.invSel, this.ctrlSel, fs, button('Exit', 'Back to the selected pattern (G)', () => this.stop()));
    mid.append(row1, row2, row3);
    o.append(this.stickL, mid, this.stickR);
  }

  /** Makes an OSD stick draggable by touch or mouse; it springs back to the centre on release. */
  #bindStick(c, side) {
    const at = (e) => {
      const r = c.getBoundingClientRect();
      // the knob reaches full deflection a little inside the frame
      const x = (((e.clientX - r.left) / r.width) * 2 - 1) * 1.2;
      const y = (1 - ((e.clientY - r.top) / r.height) * 2) * 1.2;
      return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.touch[side] = at(e);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.touch[side]) this.touch[side] = at(e);
    });
    const end = () => {
      this.touch[side] = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);
  }

  #drawStick(c, x, y, active) {
    const g = c.getContext('2d');
    const s = c.width;
    g.clearRect(0, 0, s, s);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(4, 4, s - 8, s - 8, 16);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(s / 2, 12);
    g.lineTo(s / 2, s - 12);
    g.moveTo(12, s / 2);
    g.lineTo(s - 12, s / 2);
    g.stroke();
    const px = s / 2 + x * (s / 2 - 16);
    const py = s / 2 - y * (s / 2 - 16);
    g.fillStyle = active ? '#3987e5' : '#c3c2b7';
    g.strokeStyle = '#1a1a19';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(px, py, 11, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  #renderOsd() {
    const app = this.app;
    const sim = app.sim;
    const d = sim.dr;
    const inp = sim.lastInput || this.input || { thr: 0, yaw: 0, pitch: 0, roll: 0 };
    const auto = !!sim.rth;
    this.#drawStick(this.stickL, inp.yaw, inp.thr, !auto);
    this.#drawStick(this.stickR, inp.roll, inp.pitch, !auto);
    const p = sim.world.pilot;
    const dx = p.x - d.x;
    const dz = p.z - d.z;
    const dist = Math.hypot(dx, dz);
    this.read.alt.textContent = `${d.agl < 10 ? d.agl.toFixed(1) : Math.round(d.agl)} m`;
    this.read.vs.textContent = `${d.vy >= 0 ? '+' : '−'}${Math.abs(d.vy).toFixed(1)}`;
    this.read.spd.textContent = `${Math.hypot(d.vx, d.vz).toFixed(1)} m/s`;
    const hdg = ((d.heading * 180) / Math.PI + 90 + 360) % 360;
    this.read.hdg.textContent = `${String(Math.round(hdg) % 360).padStart(3, '0')}°`;
    this.read.home.textContent = fmtDist(dist);
    const rel = Math.atan2(dz, dx) - d.heading;
    this.arrow.style.transform = `rotate(${rel - Math.PI / 2}rad)`;
    const lq = Math.max(0, this.lq ?? 1);
    this.read.lq.textContent = `${Math.round(lq * 100)} %`;
    this.lqEl.className = `osd__val ${lq < 0.3 ? 'is-bad' : lq < 0.8 ? 'is-warn' : ''}`;
    const tech = TECHS.find((t) => t.id === this.ctrlTech);
    this.lqEl.title = `Link quality of ${tech.name} over the last second (1 − PER)`;
    let mode = 'MANUAL';
    if (sim.rth) mode = this.failsafe ? `FAILSAFE · RTH ${sim.rth.phase}` : `RTH · ${sim.rth.phase}`;
    if (sim.free && sim.free.onGround && !sim.rth) mode = 'LANDED';
    this.mode.textContent = mode;
    this.mode.className = `osd__mode ${sim.rth ? (this.failsafe ? 'is-bad' : 'is-warn') : ''}`;
    this.rthBtn.textContent = sim.rth ? 'Cancel RTH' : 'Return home';
    const fixed = app.droneOf().type === 'fixed';
    this.hint.textContent = this.padMissing
      ? 'No controller found yet – move a stick on it'
      : this.mapping !== 'keyboard'
        ? 'Controller active · Y/△ = return home'
        : fixed
          ? 'W/S throttle · ↑ dive ↓ climb · ←→ bank · A/D rudder · H home · G exit'
          : 'W/S up/down · A/D turn · ↑↓←→ move · Shift fine · H home · G exit';
  }
}
