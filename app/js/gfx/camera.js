/*
 * Camera: perspective modes (orbit / follow / chase / pilot / FPV) and
 * orthographic drawing views - top (map), iso (isometric) and side (an
 * elevation section across the link to the drone) - plus pointer and touch
 * controls.
 */
import { perspective, ortho, lookAt, multiply, invert, mat4 } from './mat.js';
import { clamp } from '../util.js';

export const CAMERA_MODES = ['orbit', 'follow', 'chase', 'top', 'iso', 'side', 'pilot', 'fpv'];
const ORTHO = new Set(['top', 'iso', 'side']);
const ISO_PITCH = Math.atan(1 / Math.SQRT2); // 35.26°: the classic isometric elevation
const ISO_STEP = Math.PI / 2;
const ISO_BASE = Math.PI / 4;
/** In the side view everything closer than this (display units) in front of the section plane is cut away. */
const SIDE_CUT = 25;

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class OrbitCamera {
  constructor() {
    this.target = [0, 0, 0];
    this.yaw = -2.3;
    this.pitch = 0.62;
    this.dist = 2500;
    this.fov = (45 * Math.PI) / 180;
    this.mode = 'orbit';
    this.view = mat4();
    this.proj = mat4();
    this.vp = mat4();
    this.invVP = mat4();
    this.eye = [0, 0, 0];
    this.minDist = 20;
    this.maxDist = 12000;
    this.S = 2000;
    // iso: yaw snaps to the four diagonals; the view follows the drone until panned
    this.isoYaw = -3 * ISO_BASE;
    this.isoTurning = false;
    this.track = true;
    // side: framed automatically across the link until panned or turned
    this.sideAuto = true;
    this.sideYaw = 0;
    this.sideZoom = 1;
  }

  get isOrtho() {
    return ORTHO.has(this.mode);
  }

  /** Re-frames a world of size S around its centre. */
  frame(S, centre = [0, 0, 0]) {
    this.S = S;
    this.target = centre.slice();
    this.dist = S * 0.75;
    this.minDist = S * 0.004;
    this.maxDist = S * 3;
    this.pitch = 0.62;
  }

  /** Switches the mode; the iso view starts following the drone, the side view frames the link. */
  setMode(mode) {
    if (mode === 'iso' && this.mode !== 'iso') this.track = true;
    if (mode === 'side') {
      this.sideAuto = true;
      this.sideZoom = 1;
      this.sideSnap = true; // first frame: straight into position, then follow smoothly
    }
    if (mode === 'chase') this.chaseEye = null;
    this.mode = mode;
  }

  /**
   * Computes the matrices. `ctx` supplies display positions: drone, heading,
   * pilot (eye for the pilot view), body (FPV), and link = { a, b, lo, hi,
   * top, bottom } for the side view: both ends of the link, the vertical
   * extent of the terrain between them and the parts of the view (fractions
   * of its height) covered by overlays at the top and at the bottom.
   */
  update(aspect, ctx, dt = 0) {
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.18) : 1;
    const mode = this.mode;
    if ((mode === 'follow' || mode === 'chase' || (mode === 'iso' && this.track)) && ctx.drone) {
      for (let i = 0; i < 3; i++) this.target[i] += (ctx.drone[i] - this.target[i]) * k;
    }
    if (ORTHO.has(mode)) {
      this.#updateOrtho(aspect, ctx, dt);
      return;
    }
    let eye;
    let target = this.target;
    let up = [0, 1, 0];
    if (mode === 'chase' && ctx.drone) {
      const h = ctx.heading;
      const back = this.dist;
      const want = [ctx.drone[0] - Math.cos(h) * back * Math.cos(this.pitch), ctx.drone[1] + back * Math.sin(this.pitch), ctx.drone[2] - Math.sin(h) * back * Math.cos(this.pitch)];
      this.chaseEye = this.chaseEye || want;
      for (let i = 0; i < 3; i++) this.chaseEye[i] += (want[i] - this.chaseEye[i]) * k;
      eye = this.chaseEye;
    } else if (mode === 'pilot' && ctx.pilot && ctx.drone) {
      eye = ctx.pilot;
      target = ctx.drone;
    } else if (mode === 'fpv' && ctx.drone && ctx.body) {
      // camera fixed to the frame, tilted up 15°: the horizon rolls and pitches with the drone
      const b = ctx.body;
      const c = Math.cos(0.26);
      const s = Math.sin(0.26);
      const dir = [b.X[0] * c + b.Y[0] * s, b.X[1] * c + b.Y[1] * s, b.X[2] * c + b.Y[2] * s];
      eye = [ctx.drone[0], ctx.drone[1] + (ctx.lift || 0), ctx.drone[2]];
      target = [eye[0] + dir[0] * 100, eye[1] + dir[1] * 100, eye[2] + dir[2] * 100];
      up = b.Y;
    } else {
      eye = [
        target[0] + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
        target[1] + this.dist * Math.sin(this.pitch),
        target[2] + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      ];
    }
    this.eye = eye;
    const d = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
    const near = mode === 'fpv' ? 0.3 : Math.max(0.5, d * 0.004);
    perspective(this.proj, this.fov, aspect, near, Math.max(d * 8, 30000));
    lookAt(this.view, eye, target, up);
    multiply(this.vp, this.proj, this.view);
    invert(this.invVP, this.vp);
  }

  #updateOrtho(aspect, ctx, dt) {
    const mode = this.mode;
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.25) : 1;
    let pitch;
    let yaw;
    let up = [0, 1, 0];
    if (mode === 'top') {
      pitch = Math.PI / 2;
      yaw = -Math.PI / 2;
      up = [0, 0, -1];
    } else if (mode === 'iso') {
      pitch = ISO_PITCH;
      if (!this.isoTurning) {
        const snap = ISO_BASE + Math.round((this.isoYaw - ISO_BASE) / ISO_STEP) * ISO_STEP;
        this.isoYaw += (snap - this.isoYaw) * k;
      }
      yaw = this.isoYaw;
    } else {
      pitch = 0;
      if (this.sideAuto && ctx.link) this.#frameLink(aspect, ctx.link, k);
      yaw = this.sideYaw;
    }
    const halfH = this.dist * Math.tan(this.fov / 2);
    const off = [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
    if (mode === 'top') off[0] = off[2] = 0;
    const D = this.S * 3;
    const t = this.target;
    const eye = [t[0] + off[0] * D, t[1] + off[1] * D, t[2] + off[2] * D];
    // lighting and fog are computed as if seen from the usual distance, not from the far-away eye
    this.eye = [t[0] + off[0] * this.dist, t[1] + off[1] * this.dist, t[2] + off[2] * this.dist];
    const near = mode === 'side' ? D - SIDE_CUT : 1;
    ortho(this.proj, -halfH * aspect, halfH * aspect, -halfH, halfH, near, D + this.S * 4);
    lookAt(this.view, eye, t, up);
    multiply(this.vp, this.proj, this.view);
    invert(this.invVP, this.vp);
  }

  /** Side view: look across the link (node on the left, drone on the right) and fit both into the picture. */
  #frameLink(aspect, link, kSmooth) {
    const k = this.sideSnap ? 1 : kSmooth;
    this.sideSnap = false;
    const { a, b, lo, hi } = link;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len > 5) {
      const want = Math.atan2(dx / len, -dz / len);
      this.sideYaw += wrapAngle(want - this.sideYaw) * k;
    }
    // the section goes into the band between the overlays (HUD at the top, minimap and legend at the bottom)
    const top = clamp(link.top || 0, 0, 0.25) + 0.07; // + the label above the drone
    const bottom = clamp(link.bottom || 0, 0, 0.45) + 0.04;
    const halfW = len * 0.68 + 60;
    const halfH = Math.max(halfW / aspect, (hi - lo) / (2 * (1 - top - bottom)) + 20) * this.sideZoom;
    const want = [(a[0] + b[0]) / 2, (lo + hi) / 2 + halfH * (top - bottom), (a[2] + b[2]) / 2];
    for (let i = 0; i < 3; i++) this.target[i] += (want[i] - this.target[i]) * k;
    const dist = halfH / Math.tan(this.fov / 2);
    this.dist += (dist - this.dist) * k;
  }

  orbit(dx, dy) {
    if (this.mode === 'pilot' || this.mode === 'fpv') this.mode = 'orbit';
    this.yaw += dx * 0.006;
    this.pitch = clamp(this.pitch + dy * 0.005, 0.03, 1.55);
  }

  /** Left drag: orbit in the perspective modes, pan in the orthographic views (like a map). */
  drag(dx, dy, viewH) {
    if (this.isOrtho) this.pan(dx, dy, viewH);
    else this.orbit(dx, dy);
  }

  /** Right or Shift drag: pan in the perspective modes; turn the iso and side views. */
  drag2(dx, dy, viewH) {
    if (this.mode === 'iso') {
      this.isoTurning = true;
      this.isoYaw += dx * 0.006;
    } else if (this.mode === 'side') {
      this.sideAuto = false;
      this.sideYaw += dx * 0.006;
    } else this.pan(dx, dy, viewH);
  }

  /** End of a drag: the iso view settles on the nearest diagonal. */
  release() {
    this.isoTurning = false;
  }

  pan(dx, dy, viewH) {
    const s = (2 * this.dist * Math.tan(this.fov / 2)) / viewH;
    const v = this.view;
    if (this.isOrtho) {
      // move with the picture: along the screen's right and up vectors (iso: over the ground)
      const right = [v[0], v[4], v[8]];
      const up = [v[1], v[5], v[9]];
      if (this.mode === 'iso') {
        this.track = false;
        const h = Math.hypot(up[0], up[2]) || 1;
        const f = 1 / Math.sin(ISO_PITCH);
        for (const i of [0, 2]) this.target[i] += -right[i] * dx * s + (up[i] / h) * dy * s * f;
        return;
      }
      if (this.mode === 'side') this.sideAuto = false;
      for (let i = 0; i < 3; i++) this.target[i] += -right[i] * dx * s + up[i] * dy * s;
      return;
    }
    if (this.mode !== 'orbit') this.mode = 'orbit';
    const right = [Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
    const fwd = [-Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const f = 1 / Math.max(Math.sin(this.pitch), 0.35);
    for (let i = 0; i < 3; i++) this.target[i] += -right[i] * dx * s + fwd[i] * dy * s * f;
  }

  zoom(factor) {
    if (this.mode === 'side' && this.sideAuto) this.sideZoom = clamp(this.sideZoom * factor, 0.05, 20);
    else this.dist = clamp(this.dist * factor, this.minDist, this.maxDist);
  }

  /** Looks at a point (double-click, minimap): perspective modes switch to orbit, the drawing views stay. */
  lookAtPoint(p) {
    this.target = p.slice();
    if (this.mode === 'iso') this.track = false;
    else if (this.mode === 'side') this.sideAuto = false;
    else if (!this.isOrtho) this.mode = 'orbit';
  }
}

/** Pointer, wheel and touch handling for the 3-D canvas. */
export class CameraControls {
  constructor(el, cam, { onChange, onDoubleClick, onClick, intercept, onContext }) {
    this.el = el;
    this.cam = cam;
    this.onChange = onChange;
    this.pointers = new Map();
    this.lastPinch = null;
    this.moved = 0;

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (onContext) onContext(e.clientX, e.clientY, e);
    });
    el.addEventListener('pointerdown', (e) => {
      // e.g. dragging a waypoint: the camera leaves this pointer alone
      if (intercept && intercept(e)) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      this.moved = 0;
      this.lastPinch = null;
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 1) {
        if (p.button === 2 || p.button === 1 || p.shift || e.shiftKey) cam.drag2(dx, dy, el.clientHeight);
        else cam.drag(dx, dy, el.clientHeight);
      } else if (this.pointers.size === 2) {
        p.x = e.clientX;
        p.y = e.clientY;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        if (this.lastPinch) {
          cam.zoom(this.lastPinch.dist / Math.max(dist, 1));
          cam.pan(mid[0] - this.lastPinch.mid[0], mid[1] - this.lastPinch.mid[1], el.clientHeight);
        }
        this.lastPinch = { dist, mid };
        onChange();
        return;
      }
      p.x = e.clientX;
      p.y = e.clientY;
      onChange();
    });
    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      this.lastPinch = null;
      if (!this.pointers.size) cam.release();
      if (p && this.moved < 5 && e.type === 'pointerup' && p.button === 0 && onClick) onClick(e.clientX, e.clientY, e);
      onChange();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      cam.zoom(Math.exp(clamp(e.deltaY * unit, -300, 300) * 0.0012));
      onChange();
    }, { passive: false });
    el.addEventListener('dblclick', (e) => onDoubleClick && onDoubleClick(e.clientX, e.clientY));
  }
}
