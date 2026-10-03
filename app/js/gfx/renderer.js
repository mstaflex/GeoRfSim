/*
 * WebGL2 scene renderer. Heights above ground are mapped to display heights
 * in the vertex shaders (logarithmic by default), so changing the height
 * scale is a uniform update - no geometry is rebuilt. Terrain relief is drawn
 * linearly (with optional exaggeration); everything standing on it - trees,
 * buildings, masts, the drone and its track - uses the mapped height above
 * the local ground, which keeps "above / below the canopy" visually honest.
 */
import { program, buffer, attribs, HEIGHT_GLSL } from './gl.js';
import { mat4, fromBasis, transformPoint } from './mat.js';
import { heightMapping, mapHeight } from './heightmap.js';
import { unitCube, unitTrunk, unitCrown, airframe, pilotMesh, towerMesh, lobeMesh } from './meshes.js';

const LIGHT_GLSL = `
uniform vec3 uSun;
uniform vec3 uEye;
uniform vec3 uFogColor;
uniform float uFogDist;
vec3 shade(vec3 base, vec3 n, vec3 world) {
  float diff = max(dot(n, uSun), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 col = base * (0.32 * hemi + 0.16 + 0.72 * diff);
  float d = length(world - uEye);
  float fog = 1.0 - exp(-pow(d / uFogDist, 2.0));
  return mix(col, uFogColor, clamp(fog, 0.0, 0.88));
}
`;

const SKY_VS = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.9999, 1.0); }`;
const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvVP;
uniform vec3 uHorizon;
uniform vec3 uZenith;
out vec4 fragColor;
void main() {
  vec4 a = uInvVP * vec4(vNdc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(b.xyz / b.w - a.xyz / a.w);
  float t = smoothstep(-0.05, 0.55, dir.y);
  fragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
}`;

const TERRAIN_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uVP;
uniform float uTerrK;
uniform float uHalf;
uniform float uSize;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
void main() {
  vec3 p = vec3(aPos.x, aPos.y * uTerrK, aPos.z);
  vWorld = p;
  vNormal = aNormal;
  vUV = (aPos.xz + uHalf) / uSize;
  gl_Position = uVP * vec4(p, 1.0);
}`;
const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uGrid;
uniform float uGridAlpha;
out vec4 fragColor;
${LIGHT_GLSL}
void main() {
  vec3 base = texture(uTex, vUV).rgb;
  vec3 col = shade(base, normalize(vNormal), vWorld);
  vec2 g = vWorld.xz / uGrid;
  vec2 w = fwidth(g);
  vec2 l = smoothstep(vec2(0.0), w * 1.3, abs(fract(g - 0.5) - 0.5));
  float line = (1.0 - min(l.x, l.y)) * (1.0 - smoothstep(0.08, 0.35, max(w.x, w.y)));
  col = mix(col, vec3(0.95, 0.97, 1.0), line * uGridAlpha);
  fragColor = vec4(col, 1.0);
}`;

const BUILDING_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec4 aBox;
in vec4 aInfo;
uniform mat4 uVP;
${HEIGHT_GLSL}
out vec3 vWorld;
out vec3 vNormal;
flat out float vBaseY;
flat out float vTint;
void main() {
  float base = aInfo.x * uTerrK;
  vec3 p = vec3(mix(aBox.x, aBox.z, aPos.x), base + mapH(aPos.y * aInfo.y), mix(aBox.y, aBox.w, aPos.z));
  vWorld = p;
  vNormal = aNormal;
  vBaseY = base;
  vTint = aInfo.z;
  gl_Position = uVP * vec4(p, 1.0);
}`;
const BUILDING_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
flat in float vBaseY;
flat in float vTint;
${HEIGHT_GLSL}
${LIGHT_GLSL}
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 wall = mix(vec3(0.58, 0.58, 0.6), vec3(0.66, 0.6, 0.52), smoothstep(0.3, 0.9, vTint));
  wall = mix(wall, vec3(0.52, 0.42, 0.38), step(0.85, vTint));
  vec3 col;
  if (n.y > 0.5) {
    col = wall * 0.72;
  } else {
    float h = unmapH(vWorld.y - vBaseY);
    float f = h / 3.2;
    float u = (abs(n.x) > 0.5 ? vWorld.z : vWorld.x) / 3.6;
    float detail = 1.0 - smoothstep(0.18, 0.45, max(fwidth(f), fwidth(u)));
    float wf = fract(f);
    float wu = fract(u);
    float win = step(0.3, wf) * step(wf, 0.78) * step(0.22, wu) * step(wu, 0.78);
    col = mix(wall, vec3(0.16, 0.2, 0.26), win * detail * 0.85);
    float slab = 1.0 - smoothstep(0.0, max(fwidth(f), 1e-4) * 1.5, min(wf, 1.0 - wf));
    col = mix(col, wall * 0.75, slab * 0.6 * (1.0 - detail * 0.3));
  }
  fragColor = vec4(shade(col, n, vWorld), 1.0);
}`;

const TREE_COMMON = `
in vec3 aPos;
in vec4 aT0;   // x, z, base elevation, height
in vec4 aT1;   // visual radius, type (0 conifer, 1 broadleaf; +2 = forest tree), shade, crown-base fraction
uniform mat4 uVP;
uniform float uTreeScale;
uniform float uSpacing;   // forest tree spacing (m)
${HEIGHT_GLSL}
out vec3 vWorld;
out vec3 vNormal;
out float vShade;
flat out float vType;
// Crowns widen with the vertical exaggeration so trees look like trees, not needles ("larger than
// life"); forest trees are thinned by a per-instance hash so the canopy stays one layer deep.
float crownRadius(bool conifer, bool forest, out bool hidden) {
  float rBase = aT1.x * uTreeScale;
  float aspect = conifer ? 3.4 : 2.5;
  float rd = max(rBase, mapH(aT0.w) / (2.0 * aspect) * uTreeScale);
  hidden = false;
  if (forest) {
    float keep = clamp(pow(uSpacing * 1.2 / rd, 2.0), 0.03, 1.0);
    float h = fract(sin(float(gl_InstanceID) * 12.9898 + 78.233) * 43758.5453);
    hidden = h > keep;
  } else {
    rd = min(rd, rBase * 2.2);
  }
  return rd;
}
`;
const CROWN_VS = `#version 300 es
${TREE_COMMON}
void main() {
  float t = aPos.y;
  bool forest = aT1.y > 1.5;
  bool conifer = mod(aT1.y, 2.0) < 0.5;
  bool hidden;
  float rd = crownRadius(conifer, forest, hidden);
  float cb = conifer ? aT1.w * 0.6 : aT1.w * 1.1;
  float prof = conifer ? (1.0 - t) : pow(max(sin(3.14159 * (0.05 + 0.95 * t)), 0.0), 0.7);
  float r = rd * prof * (conifer ? 0.62 : 0.72);
  float hb = aT0.w * cb;
  float h = mix(hb, aT0.w, t);
  vec3 p = vec3(aT0.x + aPos.x * r, aT0.z * uTerrK + mapH(h), aT0.y + aPos.z * r);
  float slope = conifer ? 0.7 : (0.5 - t) * 2.2;
  vNormal = length(aPos.xz) < 0.01 ? vec3(0.0, -1.0, 0.0) : normalize(vec3(aPos.x, slope, aPos.z));
  vWorld = p;
  vShade = aT1.z;
  vType = conifer ? 0.0 : 1.0;
  gl_Position = hidden ? vec4(0.0, 0.0, -2.0, 1.0) : uVP * vec4(p, 1.0);
}`;
const TRUNK_VS = `#version 300 es
${TREE_COMMON}
void main() {
  bool forest = aT1.y > 1.5;
  bool conifer = mod(aT1.y, 2.0) < 0.5;
  bool hidden;
  float rd = crownRadius(conifer, forest, hidden);
  float cb = conifer ? aT1.w * 0.6 : aT1.w * 1.1;
  float r = rd * 0.07;
  float h = aPos.y * aT0.w * cb * 1.15;
  vec3 p = vec3(aT0.x + aPos.x * r, aT0.z * uTerrK + mapH(h), aT0.y + aPos.z * r);
  vNormal = normalize(vec3(aPos.x, 0.0, aPos.z));
  vWorld = p;
  vShade = -1.0;
  vType = conifer ? 0.0 : 1.0;
  gl_Position = hidden ? vec4(0.0, 0.0, -2.0, 1.0) : uVP * vec4(p, 1.0);
}`;
const TREE_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vShade;
flat in float vType;
${LIGHT_GLSL}
out vec4 fragColor;
void main() {
  vec3 base;
  if (vShade < 0.0) base = vec3(0.32, 0.24, 0.17);
  else if (vType < 0.5) base = mix(vec3(0.09, 0.22, 0.13), vec3(0.15, 0.3, 0.17), vShade);
  else base = mix(vec3(0.2, 0.36, 0.14), vec3(0.32, 0.46, 0.18), vShade);
  fragColor = vec4(shade(base, normalize(vNormal), vWorld), 1.0);
}`;

const LINE_VS = `#version 300 es
in vec2 aCorner;   // x: end (0/1), y: side (-1/1)
in vec4 aA;        // x, z, terrain elevation, height above ground
in vec4 aB;
in vec4 aCA;
in vec4 aCB;
uniform mat4 uVP;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uFlatten;   // 1: draw on the ground (track shadow)
uniform vec4 uTint;       // multiplies colour (x-ray / shadow passes)
${HEIGHT_GLSL}
out vec4 vColor;
void main() {
  float ha = mix(aA.w, 0.3, uFlatten);
  float hb = mix(aB.w, 0.3, uFlatten);
  vec4 ca = uVP * vec4(aA.x, aA.z * uTerrK + mapH(ha), aA.y, 1.0);
  vec4 cb = uVP * vec4(aB.x, aB.z * uTerrK + mapH(hb), aB.y, 1.0);
  float eps = 0.05;
  if (ca.w < eps && cb.w < eps) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); return; }
  if (ca.w < eps) ca = mix(ca, cb, (eps - ca.w) / (cb.w - ca.w));
  if (cb.w < eps) cb = mix(cb, ca, (eps - cb.w) / (ca.w - cb.w));
  vec2 sa = ca.xy / ca.w * uViewport;
  vec2 sb = cb.xy / cb.w * uViewport;
  vec2 d = sb - sa;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = mix(ca, cb, aCorner.x);
  c.xy += nrm * aCorner.y * uWidth * c.w / uViewport;
  gl_Position = c;
  vColor = mix(aCA, aCB, aCorner.x) * uTint;
}`;
const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() { if (vColor.a < 0.01) discard; fragColor = vColor; }`;

const MESH_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec4 aColor;
uniform mat4 uVP;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColor;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uVP * w;
}`;
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColor;
uniform float uAlpha;
uniform float uUnlit;
${LIGHT_GLSL}
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 lit = shade(vColor.rgb, n, vWorld);
  fragColor = vec4(mix(lit, vColor.rgb, uUnlit), vColor.a * uAlpha);
}`;

const SKY = { horizon: [0.24, 0.31, 0.4], zenith: [0.05, 0.08, 0.14] };

/** Instanced thick-line set (segments of 16 floats: A, B, colour A, colour B). */
class LineSet {
  constructor(r, cap) {
    const gl = r.gl;
    this.gl = gl;
    this.cap = cap;
    this.n = 0;
    this.data = new Float32Array(cap * 16);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    attribs(gl, r.cornerBuf, [[r.line.a.aCorner, 2, 0]], 2);
    this.buf = buffer(gl, this.data.byteLength, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const a = r.line.a;
    attribs(gl, this.buf, [[a.aA, 4, 0], [a.aB, 4, 4], [a.aCA, 4, 8], [a.aCB, 4, 12]], 16, 1);
    gl.bindVertexArray(null);
  }

  ensure(n) {
    if (n <= this.cap) return;
    const gl = this.gl;
    this.cap = Math.ceil(n * 1.5);
    const d = new Float32Array(this.cap * 16);
    d.set(this.data);
    this.data = d;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * 16);
  }

  /** Upload segments [from, to) of this.data. */
  upload(from, to) {
    if (to <= from) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, from * 64, this.data, from * 16, (to - from) * 16);
  }

  /** Writes one segment into the CPU array. */
  set(i, ax, az, ae, ah, bx, bz, be, bh, ca, cb) {
    const o = i * 16;
    const d = this.data;
    d[o] = ax; d[o + 1] = az; d[o + 2] = ae; d[o + 3] = ah;
    d[o + 4] = bx; d[o + 5] = bz; d[o + 6] = be; d[o + 7] = bh;
    d[o + 8] = ca[0]; d[o + 9] = ca[1]; d[o + 10] = ca[2]; d[o + 11] = ca[3];
    d[o + 12] = cb[0]; d[o + 13] = cb[1]; d[o + 14] = cb[2]; d[o + 15] = cb[3];
  }
}

/** Indexed static mesh with per-vertex colour. */
class Mesh {
  constructor(r, data) {
    const gl = r.gl;
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const a = r.mesh.a;
    this.bufs = [buffer(gl, data.pos), buffer(gl, data.nrm), buffer(gl, data.col)];
    attribs(gl, this.bufs[0], [[a.aPos, 3, 0]], 3);
    attribs(gl, this.bufs[1], [[a.aNormal, 3, 0]], 3);
    attribs(gl, this.bufs[2], [[a.aColor, 4, 0]], 4);
    this.ibuf = buffer(gl, data.idx, gl.ELEMENT_ARRAY_BUFFER);
    this.count = data.idx.length;
    this.type = data.idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const b of this.bufs) gl.deleteBuffer(b);
    gl.deleteBuffer(this.ibuf);
    gl.deleteVertexArray(this.vao);
  }
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.sky = program(gl, SKY_VS, SKY_FS);
    this.terrain = program(gl, TERRAIN_VS, TERRAIN_FS);
    this.building = program(gl, BUILDING_VS, BUILDING_FS);
    this.crown = program(gl, CROWN_VS, TREE_FS);
    this.trunk = program(gl, TRUNK_VS, TREE_FS);
    this.line = program(gl, LINE_VS, LINE_FS);
    this.mesh = program(gl, MESH_VS, MESH_FS);
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');

    this.skyVao = gl.createVertexArray();
    gl.bindVertexArray(this.skyVao);
    attribs(gl, buffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3])), [[this.sky.a.aPos, 2, 0]], 2);
    gl.bindVertexArray(null);
    this.cornerBuf = buffer(gl, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));

    this.cube = unitCube();
    this.trunkGeo = unitTrunk();
    this.crownGeo = unitCrown();

    this.track = new LineSet(this, 4096);
    this.drops = new LineSet(this, 1024);
    this.ray = new LineSet(this, 256);
    this.plan = new LineSet(this, 1024);
    this.marks = new LineSet(this, 256);
    this.lobeCache = new Map();
    this.droneMeshes = new Map();
    this.trackState = { version: -1, n: 0, colorKey: '' };
    this.mapParams = { mode: 0, H: 400, h0: 15, k: 1, terrK: 1.5, knee: [100, 300], treeScale: 1 };
    this.layers = { trees: true, buildings: true, track: true, drops: true, los: true, refl: true, lobes: true, grid: true, xray: true };
    this.sun = norm3([0.45, 0.8, 0.35]);
    this.model = mat4();
  }

  // ------------------------------------------------------------------ world

  setWorld(world) {
    const gl = this.gl;
    this.world = world;
    const N = world.N;
    const pos = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const o = (j * N + i) * 3;
        pos[o] = -world.half + i * world.gridStep;
        pos[o + 1] = world.elev[j * N + i];
        pos[o + 2] = -world.half + j * world.gridStep;
      }
    }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        idx[k++] = a;
        idx[k++] = a + N;
        idx[k++] = a + 1;
        idx[k++] = a + 1;
        idx[k++] = a + N;
        idx[k++] = a + N + 1;
      }
    }
    this.#disposeWorld();
    const t = this.terrain;
    this.terrainVao = gl.createVertexArray();
    gl.bindVertexArray(this.terrainVao);
    this.terrainPos = buffer(gl, pos);
    attribs(gl, this.terrainPos, [[t.a.aPos, 3, 0]], 3);
    this.terrainNrm = buffer(gl, new Float32Array(N * N * 3), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    attribs(gl, this.terrainNrm, [[t.a.aNormal, 3, 0]], 3);
    this.terrainIdx = buffer(gl, idx, gl.ELEMENT_ARRAY_BUFFER);
    this.terrainCount = idx.length;
    gl.bindVertexArray(null);
    this.normalsFor = null;

    // land-cover texture
    const tex = world.colorTexture(1024);
    this.texImage = tex;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.T, tex.T, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(tex.px.buffer));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 8);

    // buildings
    const b = world.buildings;
    const bd = new Float32Array(Math.max(1, b.length) * 8);
    b.forEach((o, i) => bd.set([o.x0, o.z0, o.x1, o.z1, o.base, o.h, o.tint, 0], i * 8));
    this.bCount = b.length;
    const bp = this.building;
    this.bVao = gl.createVertexArray();
    gl.bindVertexArray(this.bVao);
    this.bBufs = [buffer(gl, this.cube.pos), buffer(gl, this.cube.nrm), buffer(gl, bd)];
    attribs(gl, this.bBufs[0], [[bp.a.aPos, 3, 0]], 3);
    attribs(gl, this.bBufs[1], [[bp.a.aNormal, 3, 0]], 3);
    attribs(gl, this.bBufs[2], [[bp.a.aBox, 4, 0], [bp.a.aInfo, 4, 4]], 8, 1);
    this.bIdx = buffer(gl, this.cube.idx, gl.ELEMENT_ARRAY_BUFFER);
    gl.bindVertexArray(null);

    // trees
    this.treeCount = world.trees.count;
    this.treeBuf = buffer(gl, world.trees.count ? world.trees.data : new Float32Array(8));
    const mk = (prog, geo) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pb = buffer(gl, geo.pos);
      attribs(gl, pb, [[prog.a.aPos, 3, 0]], 3);
      attribs(gl, this.treeBuf, [[prog.a.aT0, 4, 0], [prog.a.aT1, 4, 4]], 8, 1);
      const ib = buffer(gl, geo.idx, gl.ELEMENT_ARRAY_BUFFER);
      gl.bindVertexArray(null);
      return { vao, count: geo.idx.length, bufs: [pb, ib] };
    };
    this.crownDraw = mk(this.crown, this.crownGeo);
    this.trunkDraw = mk(this.trunk, this.trunkGeo);

    this.trackState = { version: -1, n: 0, colorKey: '' };
    this.track.n = 0;
    this.drops.n = 0;
    this.nodeMeshKey = '';
  }

  #disposeWorld() {
    const gl = this.gl;
    if (!this.terrainVao) return;
    gl.deleteVertexArray(this.terrainVao);
    for (const b of [this.terrainPos, this.terrainNrm, this.terrainIdx, ...(this.bBufs || []), this.bIdx, this.treeBuf]) if (b) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.bVao);
    for (const d of [this.crownDraw, this.trunkDraw]) {
      gl.deleteVertexArray(d.vao);
      for (const b of d.bufs) gl.deleteBuffer(b);
    }
    gl.deleteTexture(this.tex);
    for (const m of [this.pilotMesh, this.towerMesh]) m?.dispose();
    this.pilotMesh = null;
    this.towerMesh = null;
  }

  #terrainNormals() {
    const w = this.world;
    const k = this.mapParams.terrK;
    if (this.normalsFor === k) return;
    const N = w.N;
    const e = w.elev;
    const out = new Float32Array(N * N * 3);
    const c2 = 2 * w.gridStep;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const l = e[j * N + Math.max(i - 1, 0)];
        const r = e[j * N + Math.min(i + 1, N - 1)];
        const u = e[Math.max(j - 1, 0) * N + i];
        const d = e[Math.min(j + 1, N - 1) * N + i];
        const nx = (-(r - l) * k) / c2;
        const nz = (-(d - u) * k) / c2;
        const len = Math.hypot(nx, 1, nz);
        const o = (j * N + i) * 3;
        out[o] = nx / len;
        out[o + 1] = 1 / len;
        out[o + 2] = nz / len;
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNrm);
    gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
    this.normalsFor = k;
  }

  // ------------------------------------------------------------------ height mapping

  /**
   * mode: 'log' | 'lin' | 'true'; h0: log knee (m); gain: vertical exaggeration
   * of the mapped heights; terrK: terrain relief factor; treeScale.
   */
  /** Height mapping: see heightmap.js ('log' near the ground and linear above the knee, 'lin', 'true'). */
  setMapping({ mode = 'log', h0 = 15, gain = 1, terrK = 1.5, treeScale = 1 }) {
    const m = heightMapping({ mode, h0, gain, terrK, S: this.world ? this.world.S : 2000 });
    Object.assign(this.mapParams, m, { treeScale, key: `${mode}|${h0}|${gain}|${m.terrK}` });
  }

  mapH(h) {
    return mapHeight(this.mapParams, h);
  }

  /** Display position of a point given terrain elevation e and height above ground. */
  display(x, z, e, agl) {
    return [x, e * this.mapParams.terrK + this.mapH(agl), z];
  }

  #heightUniforms(p) {
    const gl = this.gl;
    const m = this.mapParams;
    gl.uniform4f(p.u.uMap, m.H, m.h0, m.k, m.mode);
    gl.uniform2f(p.u.uKnee, m.knee[0], m.knee[1]);
    gl.uniform1f(p.u.uTerrK, m.terrK);
  }

  #lightUniforms(p) {
    const gl = this.gl;
    gl.uniform3fv(p.u.uSun, this.sun);
    gl.uniform3fv(p.u.uEye, this.cam.eye);
    gl.uniform3fv(p.u.uFogColor, SKY.horizon);
    gl.uniform1f(p.u.uFogDist, this.world.S * 2.2);
  }

  // ------------------------------------------------------------------ dynamic content

  /**
   * Syncs the track line set. colorOf(i) → [r,g,b,a] for track point i;
   * colorKey changes force a full recolour.
   */
  syncTrack(track, colorOf, colorKey) {
    const st = this.trackState;
    const full = st.version !== track.version || st.colorKey !== colorKey || track.n < st.n;
    const from = full ? 0 : Math.max(st.n - 1, 0);
    const n = track.n;
    const segs = Math.max(n - 1, 0);
    this.track.ensure(segs);
    let prevC = from > 0 ? colorOf(from) : null;
    const none = [0, 0, 0, 0];
    for (let i = from; i < segs; i++) {
      const ca = prevC || colorOf(i);
      const cb = colorOf(i + 1);
      const gap = track.brk && track.brk[i + 1];
      this.track.set(i, track.x[i], track.z[i], track.e[i], track.agl[i], track.x[i + 1], track.z[i + 1], track.e[i + 1], track.agl[i + 1], gap ? none : ca, gap ? none : cb);
      prevC = cb;
    }
    this.track.upload(from, segs);
    this.track.n = segs;
    // drop lines every ~12th point
    const every = 12;
    const nd = Math.floor(n / every);
    this.drops.ensure(nd);
    const dFrom = full ? 0 : Math.floor(Math.max(st.n - 1, 0) / every);
    for (let k = dFrom; k < nd; k++) {
      const i = k * every;
      const c = colorOf(i);
      this.drops.set(k, track.x[i], track.z[i], track.e[i], 0, track.x[i], track.z[i], track.e[i], track.agl[i], [c[0], c[1], c[2], 0.05], [c[0], c[1], c[2], 0.5]);
    }
    this.drops.upload(dFrom, nd);
    this.drops.n = nd;
    st.version = track.version;
    st.n = n;
    st.colorKey = colorKey;
  }

  /** Sets the ray lines (LOS curve, reflection path): list of [x,z,e,agl,colour] points per polyline. */
  setRays(polylines) {
    this.setLines('ray', polylines);
  }

  /** Replaces a line set ('ray', 'plan' or 'marks') with polylines of [x, z, e, agl, colour] points. */
  setLines(name, polylines) {
    const set = this[name];
    let n = 0;
    for (const pl of polylines) n += Math.max(pl.length - 1, 0);
    set.ensure(n);
    let k = 0;
    for (const pl of polylines) {
      for (let i = 0; i + 1 < pl.length; i++) {
        const a = pl[i];
        const b = pl[i + 1];
        set.set(k++, a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], a[4], b[4]);
      }
    }
    set.upload(0, k);
    set.n = k;
  }

  #droneMesh(model) {
    if (!this.droneMeshes.has(model)) {
      const af = airframe(model);
      this.droneMeshes.set(model, { solid: new Mesh(this, af.solid), rotors: new Mesh(this, af.rotors) });
    }
    return this.droneMeshes.get(model);
  }

  /** Lobe mesh cached by key; gainFn(x,y,z) in the lobe's local frame. */
  lobe(key, gainFn, gMax) {
    if (!this.lobeCache.has(key)) this.lobeCache.set(key, new Mesh(this, lobeMesh(gainFn, gMax)));
    return this.lobeCache.get(key);
  }

  #nodeMeshes(state) {
    const w = this.world;
    const key = `${this.mapParams.key}|${state.pilotH}|${state.cellAz0.toFixed(0)}`;
    if (key === this.nodeMeshKey) return;
    this.pilotMesh?.dispose();
    this.towerMesh?.dispose();
    const vis = w.S / 260;
    this.pilotMesh = new Mesh(this, pilotMesh((h) => this.mapH(h), state.pilotH, vis));
    const c = w.cellSite;
    this.towerMesh = new Mesh(this, towerMesh((h) => this.mapH(h), c.roof || 0, c.h, vis, state.cellAz0));
    this.nodeMeshKey = key;
  }

  // ------------------------------------------------------------------ frame

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr || 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h, dpr };
  }

  /**
   * state: { drone: {x,z,e,agl,body,model,heading}, pilotH, cellAz0, lobes: [{mesh, pos, axes, scale}] }
   */
  render(cam, state) {
    const gl = this.gl;
    const w = this.world;
    this.cam = cam;
    const { w: W, h: H, dpr } = this.resize();
    gl.viewport(0, 0, W, H);
    this.#terrainNormals();
    this.#nodeMeshes(state);
    gl.clearColor(...SKY.horizon, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // sky
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.sky.p);
    gl.uniformMatrix4fv(this.sky.u.uInvVP, false, cam.invVP);
    gl.uniform3fv(this.sky.u.uHorizon, SKY.horizon);
    gl.uniform3fv(this.sky.u.uZenith, SKY.zenith);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    // terrain
    const t = this.terrain;
    gl.useProgram(t.p);
    gl.uniformMatrix4fv(t.u.uVP, false, cam.vp);
    gl.uniform1f(t.u.uTerrK, this.mapParams.terrK);
    gl.uniform1f(t.u.uHalf, w.half);
    gl.uniform1f(t.u.uSize, w.S);
    gl.uniform1f(t.u.uGrid, w.S >= 3000 ? 500 : 250);
    gl.uniform1f(t.u.uGridAlpha, this.layers.grid ? 0.22 : 0);
    this.#lightUniforms(t);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(t.u.uTex, 0);
    gl.bindVertexArray(this.terrainVao);
    gl.drawElements(gl.TRIANGLES, this.terrainCount, gl.UNSIGNED_INT, 0);

    // buildings
    if (this.layers.buildings && this.bCount) {
      const b = this.building;
      gl.useProgram(b.p);
      gl.uniformMatrix4fv(b.u.uVP, false, cam.vp);
      this.#heightUniforms(b);
      this.#lightUniforms(b);
      gl.bindVertexArray(this.bVao);
      gl.drawElementsInstanced(gl.TRIANGLES, this.cube.idx.length, gl.UNSIGNED_SHORT, 0, this.bCount);
    }

    // trees
    if (this.layers.trees && this.treeCount) {
      for (const [prog, draw] of [[this.trunk, this.trunkDraw], [this.crown, this.crownDraw]]) {
        gl.useProgram(prog.p);
        gl.uniformMatrix4fv(prog.u.uVP, false, cam.vp);
        gl.uniform1f(prog.u.uTreeScale, this.mapParams.treeScale);
        gl.uniform1f(prog.u.uSpacing, w.treeSpacing || 15);
        this.#heightUniforms(prog);
        this.#lightUniforms(prog);
        gl.bindVertexArray(draw.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, draw.count, gl.UNSIGNED_SHORT, 0, this.treeCount);
      }
    }

    // ground nodes and drone
    gl.disable(gl.CULL_FACE);
    const m = this.mesh;
    gl.useProgram(m.p);
    gl.uniformMatrix4fv(m.u.uVP, false, cam.vp);
    this.#lightUniforms(m);
    gl.uniform1f(m.u.uAlpha, 1);
    gl.uniform1f(m.u.uUnlit, 0);
    const p = w.pilot;
    const pe = w.elevAt(p.x, p.z) * this.mapParams.terrK;
    this.#drawMesh(this.pilotMesh, fromBasis(this.model, [p.x, pe, p.z], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1));
    const c = w.cellSite;
    const ce = w.elevAt(c.x, c.z) * this.mapParams.terrK;
    this.#drawMesh(this.towerMesh, fromBasis(this.model, [c.x, ce, c.z], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1));

    const d = state.drone;
    const dm = this.#droneMesh(d.model);
    const dPos = this.display(d.x, d.z, d.e, d.agl);
    // the airframe is drawn far larger than life; its span only nudges the size
    const dScale = (w.S / 95) * Math.min(Math.max(Math.pow((d.span || 0.5) / 0.5, 0.35), 0.7), 1.6);
    const droneModel = fromBasis(mat4(), dPos, d.body.X, d.body.Y, d.body.Z, dScale);
    const showDrone = !state.hideDrone;
    if (showDrone) this.#drawMesh(dm.solid, droneModel);

    // lines
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const L = this.line;
    gl.useProgram(L.p);
    gl.uniformMatrix4fv(L.u.uVP, false, cam.vp);
    gl.uniform2f(L.u.uViewport, W / 2, H / 2);
    this.#heightUniforms(L);
    const drawLines = (set, width, flatten, tint) => {
      if (!set.n) return;
      gl.uniform1f(L.u.uWidth, width * dpr);
      gl.uniform1f(L.u.uFlatten, flatten);
      gl.uniform4fv(L.u.uTint, tint);
      gl.bindVertexArray(set.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.n);
    };
    gl.depthMask(false);
    if (this.layers.track) {
      drawLines(this.track, 2.5, 1, [0, 0, 0, 0.35]);
      if (this.layers.drops) drawLines(this.drops, 1.2, 0, [1, 1, 1, 1]);
    }
    gl.depthMask(true);
    if (this.layers.track) drawLines(this.track, 3, 0, [1, 1, 1, 1]);
    if (this.ray.n) drawLines(this.ray, 2.5, 0, [1, 1, 1, 1]);
    if (this.plan.n) drawLines(this.plan, 2, 0, [1, 1, 1, 1]);
    if (this.marks.n) drawLines(this.marks, 3.5, 0, [1, 1, 1, 1]);

    // transparent: rotors, lobes
    gl.depthMask(false);
    gl.useProgram(m.p);
    gl.uniform1f(m.u.uAlpha, 1);
    if (showDrone) this.#drawMesh(dm.rotors, droneModel);
    if (this.layers.lobes) {
      gl.uniform1f(m.u.uAlpha, 0.42);
      for (const lb of state.lobes || []) {
        this.#drawMesh(lb.mesh, fromBasis(this.model, lb.pos, lb.axes.X, lb.axes.Y, lb.axes.Z, lb.scale));
      }
    }

    // x-ray: what hides behind terrain, canopy or buildings stays faintly visible
    if (this.layers.xray) {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(m.u.uAlpha, 0.3);
      if (showDrone) this.#drawMesh(dm.solid, droneModel);
      gl.useProgram(L.p);
      if (this.ray.n) drawLines(this.ray, 1.8, 0, [1, 1, 1, 0.55]);
      if (this.plan.n) drawLines(this.plan, 1.5, 0, [1, 1, 1, 0.45]);
      if (this.marks.n) drawLines(this.marks, 2.5, 0, [1, 1, 1, 0.6]);
      if (this.layers.track) drawLines(this.track, 2, 0, [1, 1, 1, 0.38]);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.dronePos = dPos;
  }

  #drawMesh(mesh, model) {
    if (!mesh) return;
    const gl = this.gl;
    gl.uniformMatrix4fv(this.mesh.u.uModel, false, model);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
  }

  // ------------------------------------------------------------------ picking & projection

  /** Screen position (CSS px) of a display-space point, or null if behind the camera. */
  project(p) {
    const q = transformPoint(this.cam.vp, p);
    if (q[3] <= 0) return null;
    return [(q[0] * 0.5 + 0.5) * this.canvas.clientWidth, (1 - (q[1] * 0.5 + 0.5)) * this.canvas.clientHeight, q[2]];
  }

  /** World (x, z) under a client position, by marching the view ray against the terrain. */
  pick(clientX, clientY) {
    if (!this.cam) return null;
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const a = transformPoint(this.cam.invVP, [nx, ny, -1]);
    const b = transformPoint(this.cam.invVP, [nx, ny, 1]);
    const dir = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const w = this.world;
    const k = this.mapParams.terrK;
    const step = w.S / 600;
    let prev = 0;
    for (let t = 0; t < w.S * 6; t += step) {
      const x = a[0] + dir[0] * t;
      const y = a[1] + dir[1] * t;
      const z = a[2] + dir[2] * t;
      if (Math.abs(x) > w.half * 1.5 || Math.abs(z) > w.half * 1.5) {
        if (t > w.S * 3) break;
        prev = t;
        continue;
      }
      if (y <= w.elevAt(x, z) * k) {
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) / 2;
          const yy = a[1] + dir[1] * mid;
          if (yy <= w.elevAt(a[0] + dir[0] * mid, a[2] + dir[2] * mid) * k) hi = mid;
          else lo = mid;
        }
        const px = a[0] + dir[0] * hi;
        const pz = a[2] + dir[2] * hi;
        if (Math.abs(px) > w.half || Math.abs(pz) > w.half) return null;
        return { x: px, z: pz };
      }
      prev = t;
    }
    return null;
  }
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
