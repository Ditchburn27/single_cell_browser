import { Scatter } from '../render/scatter';
import { PointGrid, categoryCentroids, pointsInPolygon } from '../render/pick';
import { colormapCss, type MapName, type ValueRange } from '../render/color';
import type { CatCol, Embedding } from '../data/schema';

export type ColorSpec =
  | { type: 'cat'; key: string; title: string; col: CatCol; colors: string[] }
  | { type: 'num'; key: string; title: string; values: Float32Array; range: ValueRange; map: MapName };

export type Tool = 'pan' | 'box' | 'lasso';

export interface PaneHost {
  isSync(): boolean;
  tool(): Tool;
  onViewChanged(p: PaneView): void;
  onSelect(mask: Uint8Array, mode: 'replace' | 'add' | 'subtract'): void;
  onHover(p: PaneView, cell: number, ev: PointerEvent | null): void;
  onLegendToggle(p: PaneView, code: number): void;
  onLegendIsolate(p: PaneView, code: number): void;
  onLegendColor(p: PaneView, code: number, hex: string): void;
  onMarkers(group: string, ev: MouseEvent): void;
  hasMarkers(group: string): boolean;
  onEmbeddingChange(p: PaneView): void;
  labelSize(): number;
  showLabels(): boolean;
  isDark(): boolean;
}

export interface Composition {
  hidden: Set<number>; // hidden category codes (cat spec only)
  dim: Uint8Array | null; // 1 = dimmed
  order: Uint32Array; // base draw order (random or sorted)
}

export class PaneView {
  el = document.createElement('div');
  sc: Scatter;
  spec: ColorSpec | null = null;
  baseRgba: Uint8Array | null = null;
  hidden = new Set<number>();
  embedding: Embedding | null = null;
  axes: [number, number] = [0, 1];
  flipY = false;
  private head = document.createElement('div');
  private label = document.createElement('span');
  private embSel = document.createElement('select');
  private axSel = document.createElement('span');
  private legend = document.createElement('div');
  private legTitle = document.createElement('h3');
  private legItems = document.createElement('div');
  private legGrad = document.createElement('div');
  private cw = document.createElement('div');
  private grid: PointGrid | null = null;
  private centroidKey = ''; private centroids: ReturnType<typeof categoryCentroids> = [];
  private counts: Int32Array | null = null;
  private drag: null | { kind: 'pan'; sx: number; sy: number; v: { sc: number; x: number; y: number } } | { kind: 'box' | 'lasso'; pts: [number, number][]; mode: 'replace' | 'add' | 'subtract' } = null;
  // Touch: live pointers on the canvas, and the pinch gesture derived from two of them.
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: null | { dist: number; cx: number; cy: number } = null;
  visibleFn: (i: number) => boolean = () => true;

  constructor(parent: HTMLElement, public idx: number, private host: PaneHost) {
    this.el.className = 'pane';
    this.head.className = 'pane-head';
    this.label.className = 'pane-label';
    this.head.append(this.label, this.embSel, this.axSel);
    this.cw.className = 'cw';
    this.legend.className = 'leg';
    this.legItems.className = 'leg-items';
    this.legGrad.className = 'gbar-wrap'; this.legGrad.style.display = 'none';
    this.legend.append(this.legTitle, this.legItems, this.legGrad);
    this.el.append(this.cw, this.head, this.legend);
    parent.appendChild(this.el);
    this.sc = new Scatter(this.cw);
    this.sc.onOverlay = (c) => this.drawOverlay(c);
    this.embSel.onchange = () => { this.setEmbeddingByName(this.embSel.value); host.onEmbeddingChange(this); };
    this.bindEvents();
  }

  destroy() { this.el.remove(); }

  setEmbeddings(list: Embedding[], pick?: string) {
    this.embSel.innerHTML = '';
    for (const e of list) { const o = document.createElement('option'); o.value = o.textContent = e.name; this.embSel.appendChild(o); }
    this.embSel.style.display = list.length > 1 ? '' : 'none';
    this.embList = list;
    this.setEmbeddingByName(pick ?? list[0].name);
  }
  private embList: Embedding[] = [];

  setEmbeddingByName(name: string, axes?: [number, number]) {
    const e = this.embList.find((x) => x.name === name) ?? this.embList[0];
    this.embedding = e; this.embSel.value = e.name;
    this.axes = axes ?? [0, 1];
    this.flipY = /spatial|image|visium|xenium|merfish/i.test(e.name); // image coordinates have y pointing down
    this.buildAxisSelects(); this.applyPositions(); this.sc.flipY = this.flipY; this.sc.resetView();
  }
  private buildAxisSelects() {
    this.axSel.innerHTML = '';
    const e = this.embedding!;
    if (e.dim <= 2) return;
    const mk = (i: 0 | 1) => {
      const s = document.createElement('select');
      for (let d = 0; d < e.dim; d++) { const o = document.createElement('option'); o.value = String(d); o.textContent = `${i ? 'y' : 'x'}: ${d + 1}`; s.appendChild(o); }
      s.value = String(this.axes[i]);
      s.onchange = () => { this.axes[i] = +s.value; this.applyPositions(); this.sc.resetView(); this.host.onEmbeddingChange(this); };
      return s;
    };
    this.axSel.append(mk(0), mk(1));
  }
  private applyPositions() {
    const e = this.embedding!, n = e.data.length / e.dim, out = new Float32Array(n * 2);
    const [a, b] = this.axes;
    for (let i = 0; i < n; i++) { out[2 * i] = e.data[i * e.dim + a]; out[2 * i + 1] = e.data[i * e.dim + b]; }
    this.sc.setPositions(out); this.grid = null; this.centroidKey = '';
  }
  toggleFlipY() { this.flipY = !this.flipY; this.sc.flipY = this.flipY; this.sc.resetView(); }

  get n() { return this.sc.n; }
  get pos() { return this.sc.pos!; }

  setSpec(spec: ColorSpec | null, rgba: Uint8Array | null) {
    this.spec = spec; this.baseRgba = rgba;
    if (!spec || spec.type !== 'cat') this.hidden.clear();
    this.centroidKey = '';
    this.label.textContent = spec ? spec.title : '';
    this.counts = null;
    if (spec?.type === 'cat') {
      const c = new Int32Array(spec.col.categories.length);
      for (let i = 0; i < spec.col.codes.length; i++) { const k = spec.col.codes[i]; if (k >= 0) c[k]++; }
      this.counts = c;
    }
  }

  /** Apply hidden/dim/order to GL buffers. */
  compose(comp: Composition) {
    const rgba = this.baseRgba; if (!rgba) { this.sc.setOrder(new Uint32Array(0)); this.sc.draw(); return; }
    const n = this.n, dim = comp.dim;
    let colors = rgba;
    if (dim) {
      colors = rgba.slice();
      for (let i = 0; i < n; i++) if (dim[i]) { const o = i * 4; colors[o] = 160; colors[o + 1] = 160; colors[o + 2] = 160; colors[o + 3] = 36; }
    }
    const codes = this.spec?.type === 'cat' ? this.spec.col.codes : null;
    const hid = this.hidden.size > 0 && codes;
    const order = comp.order, out = new Uint32Array(order.length);
    let k = 0;
    if (dim) { for (let j = 0; j < order.length; j++) { const i = order[j]; if (dim[i] && !(hid && this.hidden.has(codes![i]))) out[k++] = i; } }
    for (let j = 0; j < order.length; j++) {
      const i = order[j]; if (dim && dim[i]) continue;
      if (hid && this.hidden.has(codes![i])) continue;
      out[k++] = i;
    }
    this.sc.setColors(colors); this.sc.setOrder(out.subarray(0, k));
    this.visibleFn = hid ? (i) => !this.hidden.has(codes![i]) : () => true;
    this.sc.draw();
    this.renderLegend();
  }

  // ---- legend ----
  renderLegend() {
    const s = this.spec; this.legItems.innerHTML = ''; this.legGrad.style.display = 'none';
    this.legend.style.width = s?.type === 'num' ? '84px' : '176px';
    if (!s) { this.legTitle.textContent = ''; return; }
    if (s.type === 'cat') {
      this.legTitle.innerHTML = '';
      const t = document.createElement('span'); t.textContent = 'Legend';
      const all = document.createElement('a'); all.textContent = this.hidden.size ? 'show all' : '';
      all.onclick = () => { this.hidden.clear(); this.host.onLegendToggle(this, -1); };
      this.legTitle.append(t, all);
      s.col.categories.forEach((cat, code) => {
        const d = document.createElement('div'); d.className = 'li' + (this.hidden.has(code) ? ' off' : '');
        const sw = document.createElement('div'); sw.className = 'sw'; sw.style.background = s.colors[code]; sw.title = 'Click to change colour';
        sw.onclick = () => {
          const inp = document.createElement('input'); inp.type = 'color'; inp.value = toHex(s.colors[code]);
          inp.oninput = () => this.host.onLegendColor(this, code, inp.value); inp.click();
        };
        const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = cat; lbl.title = `${cat}\nclick: hide/show · double-click: show only this`;
        lbl.onclick = () => this.host.onLegendToggle(this, code);
        lbl.ondblclick = () => this.host.onLegendIsolate(this, code);
        const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = (this.counts?.[code] ?? 0).toLocaleString();
        d.append(sw, lbl, cnt);
        if (this.host.hasMarkers(cat)) {
          const m = document.createElement('span'); m.className = 'mk'; m.textContent = '▸'; m.title = 'Top marker genes';
          m.onclick = (e) => { e.stopPropagation(); this.host.onMarkers(cat, e); }; d.appendChild(m);
        }
        this.legItems.appendChild(d);
      });
    } else {
      this.legTitle.textContent = s.title.length > 12 ? '' : s.title;
      this.legGrad.style.display = 'flex'; this.legGrad.innerHTML = '';
      const bar = document.createElement('canvas'); bar.width = 12; bar.height = 120; bar.style.cssText = 'width:12px;height:120px;border-radius:2px';
      const g = bar.getContext('2d')!;
      for (let y = 0; y < 120; y++) { g.fillStyle = colormapCss(s.map, 1 - y / 119); g.fillRect(0, y, 12, 1); }
      const lbls = document.createElement('div'); lbls.className = 'glbls';
      const mx = document.createElement('span'), mn = document.createElement('span');
      mx.textContent = fmt(s.range.max); mn.textContent = fmt(s.range.min); lbls.append(mx, mn);
      this.legGrad.append(bar, lbls);
    }
  }

  // ---- overlay (labels + selection shape) ----
  private drawOverlay(c: CanvasRenderingContext2D) {
    const s = this.spec;
    if (s?.type === 'cat' && this.host.showLabels()) {
      const key = `${s.key}|${this.embedding?.name}|${this.axes}|${[...this.hidden].join(',')}`;
      if (key !== this.centroidKey) {
        this.centroids = categoryCentroids(this.pos, s.col.codes, s.col.categories.length, (k) => !this.hidden.has(k));
        this.centroidKey = key;
      }
      const dark = this.host.isDark();
      c.font = `bold ${this.host.labelSize()}px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineJoin = 'round'; c.lineWidth = 3.5; c.strokeStyle = dark ? 'rgba(20,20,18,0.8)' : 'rgba(255,255,255,0.8)'; c.fillStyle = dark ? '#f1f1ee' : '#111';
      this.centroids.forEach((p, k) => {
        if (!p) return;
        const [x, y] = this.sc.toPx(p.x, p.y);
        if (x < -40 || y < -20 || x > this.sc.W + 40 || y > this.sc.H + 20) return;
        const t = s.col.categories[k]; c.strokeText(t, x, y); c.fillText(t, x, y);
      });
    }
    const d = this.drag;
    if (d && d.kind !== 'pan' && d.pts.length > 1) {
      c.save(); c.strokeStyle = '#3d6ff0'; c.fillStyle = 'rgba(61,111,240,0.12)'; c.lineWidth = 1.5; c.setLineDash([5, 3]);
      c.beginPath();
      if (d.kind === 'box') { const [a, b] = [d.pts[0], d.pts[d.pts.length - 1]]; c.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
      else { d.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); }
      c.fill(); c.stroke(); c.restore();
    }
  }

  // ---- interaction ----
  private bindEvents() {
    const cw = this.cw;
    const local = (e: PointerEvent): [number, number] => { const r = cw.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const pinchOf = (): { dist: number; cx: number; cy: number } | null => {
      const p = [...this.pointers.values()];
      if (p.length < 2) return null;
      const dx = p[0].x - p[1].x, dy = p[0].y - p[1].y;
      return { dist: Math.hypot(dx, dy) || 1, cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2 };
    };
    cw.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cw.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {           // second finger: pinch, and abandon any drag it interrupted
        this.pinch = pinchOf();
        this.drag = null;
        cw.style.cursor = '';
        this.sc.requestDraw();
        return;
      }
      if (this.pointers.size > 2) return;
      const [x, y] = local(e), tool = e.shiftKey && this.host.tool() === 'pan' ? 'lasso' : this.host.tool();
      if (tool === 'pan') { this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: { ...this.sc.view } }; cw.style.cursor = 'grabbing'; }
      else this.drag = { kind: tool, pts: [[x, y]], mode: e.altKey ? 'subtract' : e.metaKey || e.ctrlKey ? 'add' : 'replace' };
      this.host.onHover(this, -1, null);
    });
    cw.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) {
        const now = pinchOf();
        if (now) {
          const r = cw.getBoundingClientRect();
          this.sc.zoomAt(now.cx - r.left, now.cy - r.top, now.dist / this.pinch.dist);
          this.pinch = now;
          this.host.onViewChanged(this);
          this.sc.requestDraw();
        }
        return;
      }
      const d = this.drag, [x, y] = local(e);
      if (d?.kind === 'pan') {
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        this.sc.autoFit = false;
        this.sc.view = { sc: d.v.sc, x: d.v.x + dx, y: d.v.y + dy };
        this.host.onViewChanged(this); this.sc.requestDraw();
      } else if (d) {
        if (d.kind === 'box') d.pts = [d.pts[0], [x, y]]; else d.pts.push([x, y]);
        this.sc.requestDraw();
      } else this.hover(e, x, y);
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) {                          // lifting one finger ends the pinch, not the view
        if (this.pointers.size < 2) this.pinch = null;
        return;
      }
      const d = this.drag; this.drag = null; cw.style.cursor = '';
      // A touch screen has no hover, so a tap that didn't pan is treated as "inspect this point".
      if (d?.kind === 'pan' && e.pointerType !== 'mouse'
          && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) {
        const [tx, ty] = local(e);
        this.hover(e, tx, ty);
      }
      if (d && d.kind !== 'pan') {
        let poly: [number, number][];
        if (d.kind === 'box') { const [a, b] = [d.pts[0], d.pts[d.pts.length - 1] ?? d.pts[0]]; poly = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]; }
        else poly = d.pts;
        if (poly.length >= 3 && (d.kind === 'lasso' || Math.abs(poly[0][0] - poly[2][0]) > 2)) {
          const dp = poly.map(([px, py]) => this.sc.toData(px, py));
          this.host.onSelect(pointsInPolygon(this.pos, dp, this.visibleFn), d.mode);
        } else if (this.host.tool() !== 'pan' || e.shiftKey) this.host.onSelect(new Uint8Array(this.n), 'replace');
        this.sc.requestDraw();
      }
    };
    cw.addEventListener('pointerup', end); cw.addEventListener('pointercancel', end);
    cw.addEventListener('pointerleave', () => this.host.onHover(this, -1, null));
    cw.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e as unknown as PointerEvent), f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.sc.zoomAt(x, y, f); this.host.onViewChanged(this); this.sc.requestDraw();
    }, { passive: false });
    cw.addEventListener('dblclick', () => { this.sc.resetView(); this.host.onViewChanged(this); this.sc.draw(); });
  }
  private hover(e: PointerEvent, x: number, y: number) {
    if (!this.pos) return;
    this.grid ??= new PointGrid(this.pos);
    const [dx, dy] = this.sc.toData(x, y), r = 7 / this.sc.view.sc;
    this.host.onHover(this, this.grid.nearest(dx, dy, r, this.visibleFn), e);
  }
  refreshCursor() { this.cw.classList.toggle('sel', this.host.tool() !== 'pan'); }
  sizeChanged() { this.sc.resize(); }
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
function toHex(c: string): string { return /^#[0-9a-f]{6}$/i.test(c) ? c : '#888888'; }
