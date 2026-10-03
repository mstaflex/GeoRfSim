/* Thin WebGL2 helpers: programs, buffers, vertex arrays. */

/** GLSL shared by every program that maps physical heights to display heights. */
export const HEIGHT_GLSL = `
uniform vec4 uMap;      // x: display units per decade, y: h0 (m), z: linear factor, w: 0 = log, 1 = linear
uniform vec2 uKnee;     // log mode: above x metres heights continue linearly from display height y
uniform float uTerrK;   // terrain relief exaggeration (also the slope above the knee)
float mapH(float h) {
  if (uMap.w < 0.5) {
    float a = abs(h);
    float y = a <= uKnee.x ? uMap.x * log(1.0 + a / uMap.y) * 0.4342944819 : uKnee.y + (a - uKnee.x) * uTerrK;
    return h < 0.0 ? -y : y;
  }
  return h * uMap.z;
}
float unmapH(float y) {
  if (uMap.w < 0.5) {
    float a = abs(y);
    float h = a <= uKnee.y ? uMap.y * (pow(10.0, a / uMap.x) - 1.0) : uKnee.x + (a - uKnee.y) / uTerrK;
    return y < 0.0 ? -h : h;
  }
  return y / uMap.z;
}
`;

export function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
  }
  return sh;
}

/** Links a program and collects its uniform locations. */
export function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link error: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  const a = {};
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(p, i);
    a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { p, u, a };
}

export function buffer(gl, data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}

/**
 * Binds attributes of a buffer: layout = [[location, size, offsetFloats]], stride in floats.
 * divisor 1 makes them per-instance.
 */
export function attribs(gl, buf, layout, strideFloats, divisor = 0) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  for (const [loc, size, off] of layout) {
    if (loc === undefined || loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, strideFloats * 4, off * 4);
    gl.vertexAttribDivisor(loc, divisor);
  }
}
