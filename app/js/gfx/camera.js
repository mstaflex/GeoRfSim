/* Orbit camera with follow / chase / top / pilot modes, and pointer + touch controls. */
import { perspective, lookAt, multiply, invert, mat4 } from './mat.js';
import { clamp } from '../util.js';

export const CAMERA_MODES = ['orbit', 'follow', 'chase', 'top', 'pilot', 'fpv'];

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
  }

  /** Re-frames a world of size S around its centre. */
  frame(S, centre = [0, 0, 0]) {
    this.target = centre.slice();
    this.dist = S * 0.75;
    this.minDist = S * 0.004;
    this.maxDist = S * 3;
    this.pitch = 0.62;
  }

  /** Computes matrices; `ctx` supplies drone/pilot display positions for the tracking modes. */
  update(aspect, ctx, dt = 0) {
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.18) : 1;
    let eye;
    let target = this.target;
    let up = [0, 1, 0];
    if ((this.mode === 'follow' || this.mode === 'chase') && ctx.drone) {
      for (let i = 0; i < 3; i++) this.target[i] += (ctx.drone[i] - this.target[i]) * k;
    }
    if (this.mode === 'chase' && ctx.drone) {
      const h = ctx.heading;
      const back = this.dist;
      const want = [ctx.drone[0] - Math.cos(h) * back * Math.cos(this.pitch), ctx.drone[1] + back * Math.sin(this.pitch), ctx.drone[2] - Math.sin(h) * back * Math.cos(this.pitch)];
      this.chaseEye = this.chaseEye || want;
      for (let i = 0; i < 3; i++) this.chaseEye[i] += (want[i] - this.chaseEye[i]) * k;
      eye = this.chaseEye;
    } else if (this.mode === 'pilot' && ctx.pilot && ctx.drone) {
      eye = ctx.pilot;
      target = ctx.drone;
    } else if (this.mode === 'fpv' && ctx.drone && ctx.body) {
      // camera fixed to the frame, tilted up 15°: the horizon rolls and pitches with the drone
      const b = ctx.body;
      const c = Math.cos(0.26);
      const s = Math.sin(0.26);
      const dir = [b.X[0] * c + b.Y[0] * s, b.X[1] * c + b.Y[1] * s, b.X[2] * c + b.Y[2] * s];
      eye = [ctx.drone[0], ctx.drone[1] + (ctx.lift || 0), ctx.drone[2]];
      target = [eye[0] + dir[0] * 100, eye[1] + dir[1] * 100, eye[2] + dir[2] * 100];
      up = b.Y;
    } else {
      const p = this.mode === 'top' ? 1.5697 : this.pitch;
      const y = this.mode === 'top' ? -Math.PI / 2 : this.yaw;
      eye = [
        target[0] + this.dist * Math.cos(p) * Math.cos(y),
        target[1] + this.dist * Math.sin(p),
        target[2] + this.dist * Math.cos(p) * Math.sin(y),
      ];
      if (this.mode === 'top') up = [0, 0, -1];
    }
    this.eye = eye;
    const d = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
    const near = this.mode === 'fpv' ? 0.3 : Math.max(0.5, d * 0.004);
    perspective(this.proj, this.fov, aspect, near, Math.max(d * 8, 30000));
    lookAt(this.view, eye, target, up);
    multiply(this.vp, this.proj, this.view);
    invert(this.invVP, this.vp);
  }

  orbit(dx, dy) {
    if (this.mode === 'pilot' || this.mode === 'top' || this.mode === 'fpv') this.mode = 'orbit';
    this.yaw += dx * 0.006;
    this.pitch = clamp(this.pitch + dy * 0.005, 0.03, 1.55);
  }

  pan(dx, dy, viewH) {
    if (this.mode !== 'orbit' && this.mode !== 'top') this.mode = 'orbit';
    const s = (2 * this.dist * Math.tan(this.fov / 2)) / viewH;
    const y = this.mode === 'top' ? -Math.PI / 2 : this.yaw;
    const right = [Math.sin(y), 0, -Math.cos(y)];
    const fwd = [-Math.cos(y), 0, -Math.sin(y)];
    const f = this.mode === 'top' ? 1 : 1 / Math.max(Math.sin(this.pitch), 0.35);
    for (let i = 0; i < 3; i++) this.target[i] += -right[i] * dx * s + fwd[i] * dy * s * f;
  }

  zoom(factor) {
    this.dist = clamp(this.dist * factor, this.minDist, this.maxDist);
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
        if (p.button === 2 || p.button === 1 || p.shift || e.shiftKey) cam.pan(dx, dy, el.clientHeight);
        else cam.orbit(dx, dy);
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
      if (p && this.moved < 5 && e.type === 'pointerup' && p.button === 0 && onClick) onClick(e.clientX, e.clientY, e);
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
