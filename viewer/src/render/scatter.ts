// WebGL2 point renderer with a 2D overlay canvas for labels / selection shapes.
// Positions are in data space; the view transform is  px = data * sc + (x, y)  with y optionally flipped.

export interface View { sc: number; x: number; y: number }

const VS = `#version 300 es
in vec2 a_pos; in vec4 a_col;
uniform vec2 u_res; uniform vec3 u_view; uniform float u_size; uniform float u_flip;
out vec4 v_col;
void main(){
  vec2 p = vec2(a_pos.x * u_view.x + u_view.y, (a_pos.y * u_flip) * u_view.x + u_view.z);
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
  gl_PointSize = u_size;
  v_col = a_col;
}`;
const FS = `#version 300 es
precision mediump float;
in vec4 v_col; out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = length(d);
  if (r > 0.5) discard;
  float a = v_col.a * (1.0 - smoothstep(0.42, 0.5, r));
  o = vec4(v_col.rgb, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

export class Scatter {
  readonly gl: WebGL2RenderingContext;
  readonly under = document.createElement('canvas');
  readonly glCanvas = document.createElement('canvas');
  readonly overlay = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  view: View = { sc: 1, x: 0, y: 0 };
  flipY = false; // false = conventional (y up on screen)
  pointSize = 3;
  /** keep the view fitted to the data on resize until the user pans/zooms */
  autoFit = true;
  background: [number, number, number, number] = [0, 0, 0, 0];
  W = 0; H = 0; dpr = 1;
  pos: Float32Array | null = null; // n x 2
  n = 0;
  private prog: WebGLProgram;
  private posBuf: WebGLBuffer; private colBuf: WebGLBuffer; private idxBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private count = 0;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  /** optional picture drawn behind the points (data-space rectangle starting at 0,0) */
  underlay: { bitmap: ImageBitmap; w: number; h: number } | null = null;
  onOverlay: ((ctx: CanvasRenderingContext2D, s: Scatter) => void) | null = null;
  private raf = 0;

  constructor(public container: HTMLElement) {
    for (const c of [this.under, this.glCanvas, this.overlay]) { c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'; container.appendChild(c); }
    this.under.style.pointerEvents = 'none'; this.under.style.display = 'none';
    this.overlay.style.pointerEvents = 'none';
    const gl = this.glCanvas.getContext('webgl2', { antialias: false, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.ctx = this.overlay.getContext('2d')!;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'a_pos'); gl.bindAttribLocation(prog, 1, 'a_col');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    this.prog = prog;
    for (const u of ['u_res', 'u_view', 'u_size', 'u_flip']) this.loc[u] = gl.getUniformLocation(prog, u);
    this.posBuf = gl.createBuffer()!; this.colBuf = gl.createBuffer()!; this.idxBuf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bindVertexArray(null);
    new ResizeObserver(() => { this.resize(); if (this.autoFit && this.pos) this.resetView(); this.draw(); }).observe(container);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.dpr = dpr;
    if (w === this.W && h === this.H && this.glCanvas.width === Math.round(w * dpr)) return;
    this.W = w; this.H = h;
    for (const c of [this.under, this.glCanvas, this.overlay]) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr)); }
  }

  setPositions(xy: Float32Array) {
    this.pos = xy; this.n = xy.length / 2;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf); gl.bufferData(gl.ARRAY_BUFFER, xy, gl.STATIC_DRAW);
  }
  setColors(rgba: Uint8Array) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf); gl.bufferData(gl.ARRAY_BUFFER, rgba, gl.DYNAMIC_DRAW);
  }
  setOrder(idx: Uint32Array) {
    const gl = this.gl;
    this.count = idx.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
  }

  bounds(): { x0: number; x1: number; y0: number; y1: number } | null {
    const p = this.pos; if (!p || !p.length) return null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x !== x || y !== y) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return isFinite(x0) ? { x0, x1, y0, y1 } : null;
  }
  resetView() {
    this.autoFit = true;
    const b = this.bounds(); this.resize();
    if (!b) return;
    const rX = b.x1 - b.x0 || 1, rY = b.y1 - b.y0 || 1, pad = 0.92;
    const sc = Math.min((this.W * pad) / rX, (this.H * pad) / rY);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    this.view = { sc, x: this.W / 2 - sc * cx, y: this.H / 2 - this.yOf(cy, sc) };
  }
  /** vertical pixel offset (before translation) of data y */
  private yOf(y: number, sc = this.view.sc) { return (this.flipY ? y : -y) * sc; }

  toPx(x: number, y: number): [number, number] {
    return [x * this.view.sc + this.view.x, this.yOf(y) + this.view.y];
  }
  toData(px: number, py: number): [number, number] {
    const { sc, x, y } = this.view;
    const dy = (py - y) / sc;
    return [(px - x) / sc, this.flipY ? dy : -dy];
  }
  zoomAt(px: number, py: number, f: number) {
    this.autoFit = false;
    const v = this.view;
    v.x = px - f * (px - v.x); v.y = py - f * (py - v.y); v.sc *= f;
  }

  requestDraw() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

  draw() {
    this.resize();
    const gl = this.gl, dpr = this.dpr;
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    gl.clearColor(...this.background); gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count) {
      gl.useProgram(this.prog);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(this.loc.u_res, this.glCanvas.width, this.glCanvas.height);
      const v = this.view;
      // u_view is in device px; y in shader is data.y * flip * sc where flip = +1 means screen-down = +y
      gl.uniform3f(this.loc.u_view, v.sc * dpr, v.x * dpr, v.y * dpr);
      gl.uniform1f(this.loc.u_flip, this.flipY ? 1 : -1);
      gl.uniform1f(this.loc.u_size, Math.max(1, this.pointSize * dpr));
      gl.bindVertexArray(this.vao);
      gl.drawElements(gl.POINTS, this.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }
    this.drawUnderlay();
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, this.W, this.H);
    this.onOverlay?.(c, this);
  }

  private drawUnderlay() {
    const u = this.underlay;
    this.under.style.display = u ? 'block' : 'none';
    if (!u) return;
    const c = this.under.getContext('2d')!, dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, this.W, this.H);
    const [x0, y0] = this.toPx(0, 0), [x1, y1] = this.toPx(u.w, u.h);
    c.save(); c.translate(x0, y0); c.scale((x1 - x0) / u.bitmap.width, (y1 - y0) / u.bitmap.height);
    c.imageSmoothingQuality = 'high'; c.drawImage(u.bitmap, 0, 0); c.restore();
  }

  /** Composite GL + overlay into one PNG-able canvas (with optional solid background). */
  snapshot(bg?: string): HTMLCanvasElement {
    this.draw();
    const out = document.createElement('canvas'); out.width = this.glCanvas.width; out.height = this.glCanvas.height;
    const c = out.getContext('2d')!;
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, out.width, out.height); }
    if (this.underlay) c.drawImage(this.under, 0, 0);
    c.drawImage(this.glCanvas, 0, 0); c.drawImage(this.overlay, 0, 0);
    return out;
  }
}
