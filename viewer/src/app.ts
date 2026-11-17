import { DataClient } from './data/client';
import { catFromValues, isCat, isNum, type CatCol, type DatasetPayload, type LayerInfo, type MarkerRow, type Markers, type ObsCol } from './data/schema';
import type { Transform } from './data/compute';
import { PaneView, type ColorSpec, type Composition, type PaneHost, type Tool } from './ui/pane';
import { toggleHidden, isolate } from './state/legend';
import {
  COLORMAPS, categoryColors, rgbaForCategories, rgbaForValues, valueRange, type MapName,
} from './render/color';
import { pickAnnotation, pickEmbedding, pickGene } from './state/defaults';
import { Dock } from './ui/dock';
import { downloadText } from './panels/draw';
import { mount as mountPlugins } from './plugins/registry';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GENE_NONE = '';

export type RightMode = { kind: 'gene' } | { kind: 'obs'; key: string } | { kind: 'geneset'; label: string; values: Float32Array };

export class App implements PaneHost {
  client = new DataClient();
  ds!: DatasetPayload;
  panes: PaneView[] = [];
  layerInfo!: LayerInfo;
  transform: Transform = 'none';
  cmap: MapName = 'viridis';
  clip = true;
  leftObs = '';
  right: RightMode = { kind: 'gene' };
  gene: string | null = null;
  highlight = '';
  syncZoom = true;
  sortZ = false;
  labels = true;
  labelPx = 12;
  currentTool: Tool = 'pan';
  selection: Uint8Array | null = null;
  selCount = 0;
  markers: Markers | null = null;
  /** dataset was opened from a URL rather than a local file */
  remote = false;
  /** what the current dataset was opened from, so it can be reopened after a cancel */
  private lastSource: File | { url: string } | null = null;
  dock!: Dock;
  private tissue: { bitmap: ImageBitmap; w: number; h: number } | null = null;
  private geneIdx = new Map<string, number>();
  private geneCache = new Map<string, Float32Array>();
  private specCache = new Map<string, { spec: ColorSpec; rgba: Uint8Array }>();
  private catColorOverride = new Map<string, string[]>();
  private randOrder = new Uint32Array(0);
  private wired = false;
  private seq = 0;
  onDatasetReady: Array<() => void> = [];
  onGeneChanged: Array<() => void> = [];
  onSelectionChanged: Array<() => void> = [];

  // ---------------- loading ----------------
  async load(src: File | { url: string }) {
    this.showLoading('Opening file…', null, true);
    try {
      const onProg = (m: string, f?: number) => this.showLoading(m, f ?? null, true);
      const ds = src instanceof File ? await this.client.open(src, onProg) : await this.client.openUrl(src.url, onProg);
      this.remote = !(src instanceof File);
      this.lastSource = src;
      this.ds = ds;
      await this.init();
      $('welcome').hidden = true; $('app').hidden = false;
      this.panes.forEach((p) => p.sizeChanged());
      this.panes.forEach((p) => p.sc.resetView());
      this.composeAll();
    } finally { this.hideLoading(); }
  }

  showLoading(msg: string, frac: number | null, cancellable = false) {
    $('loading').hidden = false; $('load-msg').textContent = msg;
    const bar = $('load-bar'); bar.classList.toggle('ind', frac == null);
    bar.style.width = frac == null ? '' : `${Math.round(frac * 100)}%`;
    const btn = $<HTMLButtonElement>('load-cancel');
    btn.hidden = !cancellable;
    btn.disabled = false;
    btn.textContent = 'Cancel';
  }
  hideLoading() { $('loading').hidden = true; $('load-cancel').hidden = true; }

  /**
   * Stop the running computation. The worker is terminated outright - nothing else can
   * interrupt a synchronous loop - which also discards the dataset it had open, so it is
   * reopened straight afterwards. Reopening resets the view and closes the panels.
   */
  async cancelWork() {
    const btn = $<HTMLButtonElement>('load-cancel');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    this.client.cancel();
    const src = this.lastSource;
    if (!src) { this.hideLoading(); $('app').hidden = true; $('welcome').hidden = false; return; }
    this.showLoading('Reopening dataset…', null);
    try { await this.load(src); } catch { this.hideLoading(); }
  }
  private progress = (m: string, f?: number) => this.showLoading(m, f ?? null, true);

  private async init() {
    const ds = this.ds;
    this.markers = ds.markers;
    this.geneCache.clear(); this.specCache.clear(); this.catColorOverride.clear();
    this.selection = null; this.selCount = 0; this.right = { kind: 'gene' }; this.highlight = ''; this.customAnnotations = [];
    ($('highlight-input') as HTMLInputElement).value = '';
    if (!ds.embeddings.length) {
      throw new Error('This file has no 2-D embedding in `obsm` (e.g. X_umap, X_tsne, spatial).\nCompute one first, e.g. in scanpy:  sc.pp.neighbors(adata); sc.tl.umap(adata); adata.write_h5ad(...)');
    }
    // random draw order
    const n = ds.n; this.randOrder = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.randOrder[i] = i;
    let seed = 12345;
    for (let i = n - 1; i > 0; i--) { seed = (seed * 1664525 + 1013904223) >>> 0; const j = seed % (i + 1); const t = this.randOrder[i]; this.randOrder[i] = this.randOrder[j]; this.randOrder[j] = t; }

    // layers
    if (!ds.layers.length) throw new Error('No expression matrix found (X, raw/X or layers/*).');
    const layerSel = $<HTMLSelectElement>('layer-sel'); layerSel.innerHTML = '';
    ds.layers.forEach((l) => { const o = document.createElement('option'); o.value = o.textContent = l.name; layerSel.appendChild(o); });
    this.layerInfo = ds.layers[0]; layerSel.value = this.layerInfo.name;
    this.transform = this.layerInfo.looksLikeCounts ? 'log1p-cp10k' : 'none';
    $<HTMLSelectElement>('transform-sel').value = this.transform;
    this.buildGeneIndex();

    // cmap select
    const cm = $<HTMLSelectElement>('cmap-sel'); cm.innerHTML = '';
    COLORMAPS.forEach((c) => { const o = document.createElement('option'); o.value = o.textContent = c; cm.appendChild(o); });
    cm.value = this.cmap;

    // header
    $('badge').textContent = ds.name; $('badge').title = ds.name;
    $('info').textContent = `${ds.n.toLocaleString()} cells · ${this.layerInfo.varNames.length.toLocaleString()} genes · ${ds.embeddings.length} embedding${ds.embeddings.length > 1 ? 's' : ''} · ${(ds.meta.fileSize / 1e6).toFixed(0)} MB`;

    // defaults (all data-driven)
    this.leftObs = pickAnnotation(ds) ?? ds.obsOrder.find((k) => ds.obs[k].kind !== 'str') ?? '';
    this.gene = pickGene(ds, this.layerInfo.varNames);
    ($('gene-input') as HTMLInputElement).value = this.gene ?? '';
    this.populateObsSelects();

    // panes
    const umaps = $('umaps'); this.panes.forEach((p) => p.destroy()); this.panes = []; umaps.innerHTML = '';
    const emb = pickEmbedding(ds.embeddings, ds.meta.defaults?.embedding)!;
    this.panes = [new PaneView(umaps, 0, this), new PaneView(umaps, 1, this)];
    this.panes.forEach((p) => { p.setEmbeddings(ds.embeddings, emb.name); p.sc.pointSize = +$<HTMLInputElement>('ptsz').value; });

    this.dock?.destroy();
    this.dock = new Dock(this);
    mountPlugins(this);

    if (!this.wired) { this.wire(); this.wired = true; }
    await this.setupTissue();
    await this.refreshSpecs();
    this.onDatasetReady.forEach((f) => f());
  }

  /** Visium-style tissue picture behind points of any embedding whose name contains 'spatial'. */
  private async setupTissue() {
    this.tissue = null;
    const sp = this.ds.meta.spatial;
    $('img-lbl').style.display = sp ? '' : 'none';
    if (!sp?.rgba) return;
    const bitmap = await createImageBitmap(new ImageData(sp.rgba as Uint8ClampedArray<ArrayBuffer>, sp.width, sp.height));
    this.tissue = { bitmap, w: sp.width / sp.scale, h: sp.height / sp.scale };
    this.applyTissue();
  }
  applyTissue() {
    const on = ($('img-chk') as HTMLInputElement).checked;
    for (const p of this.panes) { p.sc.underlay = on && this.tissue && /spatial/i.test(p.embedding?.name ?? '') ? this.tissue : null; p.sc.requestDraw(); }
  }

  private populateObsSelects() {
    const ds = this.ds;
    const sel = $<HTMLSelectElement>('obs-sel'), sel2 = $<HTMLSelectElement>('obs-sel2');
    sel.innerHTML = ''; sel2.innerHTML = '';
    const g = document.createElement('option'); g.value = GENE_NONE; g.textContent = '— gene expression —'; sel2.appendChild(g);
    for (const k of ds.obsOrder) {
      const c = ds.obs[k]; if (c.kind === 'str') continue;
      for (const s of [sel, sel2]) { const o = document.createElement('option'); o.value = k; o.textContent = k; s.appendChild(o); }
    }
    sel.value = this.leftObs; sel2.value = this.right.kind === 'obs' ? this.right.key : GENE_NONE;
  }
  /** Called when a new annotation is created in-session. */
  addAnnotation(name: string, col: CatCol) {
    this.ds.obs[name] = col; if (!this.ds.obsOrder.includes(name)) this.ds.obsOrder.push(name);
    if (!this.customAnnotations.includes(name)) this.customAnnotations.push(name);
    this.populateObsSelects(); this.dock.refreshSelectors();
  }

  // ---------------- genes / layers ----------------
  private buildGeneIndex() {
    this.geneIdx.clear();
    this.layerInfo.varNames.forEach((g, i) => { const k = g.toLowerCase(); if (!this.geneIdx.has(k)) this.geneIdx.set(k, i); });
  }
  get geneNames() { return this.layerInfo.varNames; }
  findGene(name: string): number { return this.geneIdx.get(name.trim().toLowerCase()) ?? -1; }
  resolveGenes(list: string[]): { idx: number[]; names: string[]; missing: string[] } {
    const idx: number[] = [], names: string[] = [], missing: string[] = [], seen = new Set<number>();
    for (const g of list) {
      const i = this.findGene(g);
      if (i < 0) { if (g.trim()) missing.push(g); continue; }
      if (!seen.has(i)) { seen.add(i); idx.push(i); names.push(this.geneNames[i]); }
    }
    return { idx, names, missing };
  }
  async getGene(name: string): Promise<Float32Array | null> {
    const i = this.findGene(name); if (i < 0) return null;
    const key = `${this.layerInfo.name}|${this.transform}|${i}`;
    const hit = this.geneCache.get(key);
    if (hit) { this.geneCache.delete(key); this.geneCache.set(key, hit); return hit; }
    const v = await this.client.gene(this.layerInfo.name, i, this.transform, this.progress);
    this.hideLoading();
    this.geneCache.set(key, v);
    if (this.geneCache.size > 24) this.geneCache.delete(this.geneCache.keys().next().value as string);
    return v;
  }
  async selectGene(name: string) {
    const i = this.findGene(name); if (i < 0) return;
    this.gene = this.geneNames[i]; ($('gene-input') as HTMLInputElement).value = this.gene;
    if (this.right.kind !== 'gene') { this.right = { kind: 'gene' }; $<HTMLSelectElement>('obs-sel2').value = GENE_NONE; }
    await this.refreshSpecs(1);
    this.onGeneChanged.forEach((f) => f());
  }
  async setLayer(name: string) {
    const l = this.ds.layers.find((x) => x.name === name)!;
    this.layerInfo = l; this.geneCache.clear(); this.specCache.clear(); this.buildGeneIndex();
    this.transform = l.looksLikeCounts ? 'log1p-cp10k' : 'none'; $<HTMLSelectElement>('transform-sel').value = this.transform;
    if (this.gene && this.findGene(this.gene) < 0) this.gene = pickGene(this.ds, l.varNames);
    ($('gene-input') as HTMLInputElement).value = this.gene ?? '';
    if (this.right.kind === 'geneset') this.right = { kind: 'gene' };
    await this.guard(async () => { await this.refreshSpecs(); this.onGeneChanged.forEach((f) => f()); });
  }
  async setTransform(t: Transform) {
    this.transform = t; this.geneCache.clear(); this.specCache.clear();
    if (this.right.kind === 'geneset') this.right = { kind: 'gene' };
    await this.guard(async () => { await this.refreshSpecs(); this.onGeneChanged.forEach((f) => f()); });
  }
  async setGeneSet(genes: string[], label?: string) {
    const r = this.resolveGenes(genes);
    if (!r.idx.length) return { found: 0, missing: r.missing };
    const values = await this.client.geneSet(this.layerInfo.name, r.idx, this.transform, this.progress);
    this.hideLoading();
    this.right = { kind: 'geneset', label: label ?? `Gene set (${r.idx.length} genes)`, values };
    $<HTMLSelectElement>('obs-sel2').value = GENE_NONE;
    await this.refreshSpecs(1);
    return { found: r.idx.length, missing: r.missing };
  }

  async guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn(); } catch (e) {
      // A cancel rejects every in-flight call; that is the user's own doing, not an error.
      if ((e as { cancelled?: boolean }).cancelled) return undefined;
      this.hideLoading(); this.toast((e as Error).message); return undefined;
    }
  }
  toast(msg: string) { alert(msg); }

  // ---------------- colouring ----------------
  private obsSpec(key: string): { spec: ColorSpec; rgba: Uint8Array } | null {
    const col = this.ds.obs[key]; if (!col || col.kind === 'str') return null;
    const ck = `obs|${key}|${this.cmap}`;
    const hit = this.specCache.get(ck); if (hit) return hit;
    let r: { spec: ColorSpec; rgba: Uint8Array };
    if (col.kind === 'cat') {
      const colors = this.catColorOverride.get(key) ?? categoryColors(col);
      r = { spec: { type: 'cat', key, title: key, col, colors }, rgba: rgbaForCategories(col, colors) };
    } else {
      const range = valueRange(col.values, false);
      r = { spec: { type: 'num', key, title: key, values: col.values, range, map: this.cmap }, rgba: rgbaForValues(col.values, range, this.cmap) };
    }
    this.specCache.set(ck, r); return r;
  }
  private numSpec(key: string, title: string, values: Float32Array): { spec: ColorSpec; rgba: Uint8Array } {
    const range = valueRange(values, this.clip);
    return { spec: { type: 'num', key, title, values, range, map: this.cmap }, rgba: rgbaForValues(values, range, this.cmap) };
  }
  private async rightSpec(): Promise<{ spec: ColorSpec; rgba: Uint8Array } | null> {
    const r = this.right;
    if (r.kind === 'obs') return this.obsSpec(r.key);
    if (r.kind === 'geneset') return this.numSpec(`gs|${r.label}|${this.clip}|${this.cmap}`, r.label, r.values);
    if (!this.gene) return null;
    const v = await this.getGene(this.gene);
    return v ? this.numSpec(`gene|${this.gene}|${this.layerInfo.name}|${this.transform}|${this.clip}|${this.cmap}`, this.gene, v) : null;
  }
  async refreshSpecs(only?: 0 | 1) {
    const my = ++this.seq;
    if (only !== 1) {
      const l = this.obsSpec(this.leftObs);
      this.panes[0].setSpec(l?.spec ?? null, l?.rgba ?? null);
    }
    if (only !== 0) {
      const r = await this.rightSpec();
      if (my !== this.seq) return;
      this.panes[1].setSpec(r?.spec ?? null, r?.rgba ?? null);
    }
    this.composeAll();
  }

  private highlightMask(): Uint8Array | null {
    const t = this.highlight.trim().toLowerCase(); if (!t) return null;
    const col = this.ds.obs[this.leftObs]; if (!col) return null;
    const n = this.ds.n, m = new Uint8Array(n);
    if (isCat(col)) {
      const ok = col.categories.map((c) => c.toLowerCase().includes(t));
      for (let i = 0; i < n; i++) { const c = col.codes[i]; m[i] = c >= 0 && ok[c] ? 1 : 0; }
    } else if (isNum(col)) {
      const mm = /^\s*(-?[\d.]+)\s*(?:-|\.\.|to)\s*(-?[\d.]+)\s*$/.exec(t);
      if (mm) { const lo = +mm[1], hi = +mm[2]; for (let i = 0; i < n; i++) m[i] = col.values[i] >= lo && col.values[i] <= hi ? 1 : 0; } else return null;
    }
    return m;
  }

  composeAll() {
    if (!this.panes.length) return;
    const hl = this.highlightMask(), sel = this.selection && this.selCount > 0 ? this.selection : null;
    let dim: Uint8Array | null = null;
    if (hl || sel) {
      dim = new Uint8Array(this.ds.n);
      for (let i = 0; i < dim.length; i++) dim[i] = (hl && !hl[i]) || (sel && !sel[i]) ? 1 : 0;
    }
    for (const p of this.panes) {
      let order: Uint32Array = this.randOrder;
      if (this.sortZ && p.spec) order = this.sortedOrder(p);
      const comp: Composition = { hidden: p.hidden, dim, order };
      p.compose(comp);
    }
  }
  private sortedOrder(p: PaneView): Uint32Array {
    const s = p.spec!, n = this.ds.n, idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const key: ArrayLike<number> = s.type === 'num' ? s.values : s.col.codes;
    return idx.sort((a, b) => (key[a] as number) - (key[b] as number));
  }

  // ---------------- selection ----------------
  onSelect(mask: Uint8Array, mode: 'replace' | 'add' | 'subtract') {
    const n = this.ds.n;
    let out = mask;
    if (mode !== 'replace' && this.selection) {
      out = this.selection.slice();
      for (let i = 0; i < n; i++) { if (mode === 'add') out[i] = out[i] | mask[i]; else if (mask[i]) out[i] = 0; }
    }
    this.setSelection(out);
  }
  setSelection(mask: Uint8Array | null) {
    this.selection = mask; let c = 0;
    if (mask) for (let i = 0; i < mask.length; i++) c += mask[i];
    this.selCount = c; if (!c) this.selection = null;
    this.composeAll(); this.onSelectionChanged.forEach((f) => f());
  }
  selectionIds(): string[] {
    const out: string[] = []; if (!this.selection) return out;
    for (let i = 0; i < this.selection.length; i++) if (this.selection[i]) out.push(this.ds.obsNames[i]);
    return out;
  }

  // ---------------- PaneHost ----------------
  isSync() { return this.syncZoom; }
  tool() { return this.currentTool; }
  labelSize() { return this.labelPx; }
  showLabels() { return this.labels; }
  isDark() { return matchMedia('(prefers-color-scheme: dark)').matches; }
  onViewChanged(p: PaneView) {
    if (!this.syncZoom) return;
    for (const q of this.panes) if (q !== p && q.embedding === p.embedding) { q.sc.view = { ...p.sc.view }; q.sc.autoFit = false; q.sc.requestDraw(); }
  }
  onEmbeddingChange() { this.applyTissue(); }
  onHover(p: PaneView, cell: number, ev: PointerEvent | null) {
    const tip = $('tooltip');
    if (cell < 0 || !ev) { tip.style.display = 'none'; return; }
    const ds = this.ds, rows: string[] = [];
    rows.push(`<b>${esc(ds.obsNames[cell])}</b>`);
    const show = (k: string, v: string) => rows.push(`<span class="k">${esc(k)}</span> ${esc(v)}`);
    const seen = new Set<string>();
    for (const q of this.panes) {
      const s = q.spec; if (!s || seen.has(s.key)) continue; seen.add(s.key);
      if (s.type === 'cat') show(s.title, s.col.codes[cell] >= 0 ? s.col.categories[s.col.codes[cell]] : '—');
      else show(s.title, fmt(s.values[cell]));
    }
    let k = 0;
    for (const key of ds.obsOrder) {
      if (k >= 8) break; if (seen.has(key) || key === this.leftObs) continue;
      const c = ds.obs[key];
      if (c.kind === 'cat') { if (c.categories.length > 80) continue; show(key, c.codes[cell] >= 0 ? c.categories[c.codes[cell]] : '—'); k++; }
      else if (c.kind === 'num') { show(key, fmt(c.values[cell])); k++; }
    }
    tip.innerHTML = rows.join('<br>');
    tip.style.display = 'block';
    tip.style.left = Math.min(ev.clientX + 14, innerWidth - 330) + 'px'; tip.style.top = Math.min(ev.clientY + 14, innerHeight - 180) + 'px';
  }
  onLegendToggle(p: PaneView, code: number) {
    if (code >= 0) {
      const s = p.spec;
      toggleHidden(p.hidden, code, s?.type === 'cat' ? s.col.categories.length : 0);
    }
    this.composeAll();
  }
  onLegendIsolate(p: PaneView, code: number) {
    const s = p.spec; if (s?.type !== 'cat') return;
    isolate(p.hidden, code, s.col.categories.length);
    this.composeAll();
  }
  onLegendColor(p: PaneView, code: number, hex: string) {
    const s = p.spec; if (s?.type !== 'cat') return;
    const colors = s.colors.slice(); colors[code] = hex;
    this.catColorOverride.set(s.key, colors);
    for (const k of [...this.specCache.keys()]) if (k.startsWith(`obs|${s.key}|`)) this.specCache.delete(k);
    this.refreshSpecs();
  }
  hasMarkers(group: string) { return !!this.markers?.groups[group.trim()]?.length; }
  onMarkers(group: string, ev: MouseEvent) {
    const rows: MarkerRow[] = this.markers?.groups[group.trim()] ?? [];
    const pop = $('marker-pop'); $('mk-title').textContent = group;
    const list = $('mk-list'); list.innerHTML = '';
    rows.slice(0, 40).forEach((r) => {
      const d = document.createElement('div'); d.className = 'mk-row';
      const stat = r.lfc != null ? `LFC ${r.lfc.toFixed(2)}` : r.score != null ? r.score.toFixed(2) : '';
      d.innerHTML = `<span>${esc(r.gene)}</span><span class="mk-score">${stat}</span>`;
      d.onclick = () => { this.selectGene(r.gene); pop.style.display = 'none'; };
      list.appendChild(d);
    });
    pop.style.left = Math.min(ev.clientX + 10, innerWidth - 260) + 'px'; pop.style.top = Math.min(ev.clientY - 10, innerHeight - 340) + 'px';
    pop.style.display = 'block';
  }

  // ---------------- UI wiring ----------------
  private wire() {
    const on = (id: string, ev: string, fn: (e: Event) => void) => $(id).addEventListener(ev, fn);
    on('obs-sel', 'change', () => { this.leftObs = $<HTMLSelectElement>('obs-sel').value; this.panes[0].hidden.clear(); this.refreshSpecs(0); this.dock.onLeftObsChanged(); });
    on('obs-sel2', 'change', () => {
      const v = $<HTMLSelectElement>('obs-sel2').value;
      this.right = v ? { kind: 'obs', key: v } : { kind: 'gene' }; this.refreshSpecs(1);
    });
    on('layer-sel', 'change', () => this.setLayer($<HTMLSelectElement>('layer-sel').value));
    on('transform-sel', 'change', () => this.setTransform($<HTMLSelectElement>('transform-sel').value as Transform));
    on('cmap-sel', 'change', () => { this.cmap = $<HTMLSelectElement>('cmap-sel').value as MapName; this.specCache.clear(); this.refreshSpecs(); });
    on('clip-chk', 'change', () => { this.clip = ($('clip-chk') as HTMLInputElement).checked; this.refreshSpecs(1); });
    on('highlight-input', 'input', () => { this.highlight = ($('highlight-input') as HTMLInputElement).value; this.composeAll(); });
    on('highlight-input', 'keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') { ($('highlight-input') as HTMLInputElement).value = ''; this.highlight = ''; this.composeAll(); } });
    on('ptsz', 'input', () => { const v = +$<HTMLInputElement>('ptsz').value; $('ptval').textContent = String(v); this.panes.forEach((p) => { p.sc.pointSize = v; p.sc.requestDraw(); }); });
    on('lblsz', 'input', () => { this.labelPx = +$<HTMLInputElement>('lblsz').value; $('lblszval').textContent = String(this.labelPx); this.panes.forEach((p) => p.sc.requestDraw()); });
    on('rbtn', 'click', () => { this.panes.forEach((p) => p.sc.resetView()); this.panes.forEach((p) => p.sc.draw()); });
    on('syncbtn', 'click', () => { this.syncZoom = !this.syncZoom; this.toggleBtn('syncbtn', 'Sync zoom', this.syncZoom); });
    on('zbtn', 'click', () => { this.sortZ = !this.sortZ; $('zbtn').textContent = 'Z: ' + (this.sortZ ? 'sorted' : 'random'); $('zbtn').classList.toggle('on', this.sortZ); this.composeAll(); });
    on('img-chk', 'change', () => this.applyTissue());
    on('lblbtn', 'click', () => { this.labels = !this.labels; this.toggleBtn('lblbtn', 'Labels', this.labels); this.panes.forEach((p) => p.sc.requestDraw()); });
    on('openbtn', 'click', () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.h5ad,.scb'; i.onchange = () => i.files?.[0] && this.open(i.files[0]); i.click(); });
    on('savebtn', 'click', () => this.saveView());
    on('loadbtn', 'click', () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async () => { const f = i.files?.[0]; if (f) { const txt = await f.text(); await this.guard(() => this.applyView(JSON.parse(txt))); } }; i.click(); });
    on('load-cancel', 'click', () => void this.cancelWork());
    on('dl-left', 'click', () => this.downloadPane(0));
    on('dl-right', 'click', () => this.downloadPane(1));
    document.querySelectorAll<HTMLButtonElement>('#toolgrp button').forEach((b) => b.addEventListener('click', () => {
      // Clicking the armed tool disarms it. With no tool armed the canvas still pans, and the
      // current selection is dropped, so "nothing selected" means the whole dataset again.
      const off = this.currentTool === (b.dataset.tool as Tool);
      this.currentTool = off ? 'none' : (b.dataset.tool as Tool);
      document.querySelectorAll('#toolgrp button').forEach((x) => x.classList.toggle('on', !off && x === b));
      if (off) this.setSelection(null);
      this.panes.forEach((p) => p.refreshCursor());
    }));
    $('mk-close').onclick = () => ($('marker-pop').style.display = 'none');
    document.addEventListener('click', (e) => { const pop = $('marker-pop'); if (!pop.contains(e.target as Node)) pop.style.display = 'none'; });
    document.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).matches('input,textarea,select')) return;
      if (e.key === 'Escape') this.setSelection(null);
      else if (e.key === 'b') this.pressTool('box'); else if (e.key === 'l') this.pressTool('lasso'); else if (e.key === 'v' || e.key === 'p') this.pressTool('pan');
    });
    this.wireGeneInput();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.panes.forEach((p) => p.sc.requestDraw()); this.dock.redrawOpen(); });
  }
  private pressTool(t: Tool) { document.querySelector<HTMLButtonElement>(`#toolgrp [data-tool="${t}"]`)?.click(); }
  private toggleBtn(id: string, name: string, on: boolean) { $(id).textContent = `${name}: ${on ? 'on' : 'off'}`; $(id).classList.toggle('on', on); }

  private wireGeneInput() {
    const input = $<HTMLInputElement>('gene-input'), box = $('gene-suggestions');
    let idx = -1;
    const items = () => [...box.querySelectorAll<HTMLElement>('.sug-item')];
    const hl = () => items().forEach((el, i) => el.classList.toggle('act', i === idx));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase(); box.innerHTML = ''; idx = -1;
      if (!q) { box.style.display = 'none'; return; }
      const names = this.geneNames, hits: string[] = [];
      for (const g of names) { if (g.toLowerCase().startsWith(q)) { hits.push(g); if (hits.length >= 40) break; } }
      if (hits.length < 40) for (const g of names) { if (!g.toLowerCase().startsWith(q) && g.toLowerCase().includes(q)) { hits.push(g); if (hits.length >= 40) break; } }
      if (!hits.length) { box.style.display = 'none'; return; }
      hits.forEach((g) => { const d = document.createElement('div'); d.className = 'sug-item'; d.textContent = g; d.onmousedown = (e) => { e.preventDefault(); this.pickGene(g); }; box.appendChild(d); });
      box.style.display = 'block';
    });
    input.addEventListener('keydown', (e) => {
      const it = items();
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, it.length - 1); hl(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); hl(); }
      else if (e.key === 'Escape') { box.style.display = 'none'; }
      else if (e.key === 'Enter') {
        if (idx >= 0 && it[idx]) this.pickGene(it[idx].textContent!);
        else if (this.findGene(input.value) >= 0) this.pickGene(input.value);
        box.style.display = 'none';
      }
    });
    input.addEventListener('blur', () => setTimeout(() => (box.style.display = 'none'), 150));
  }
  private pickGene(g: string) { $('gene-suggestions').style.display = 'none'; this.guard(() => this.selectGene(g)); }

  downloadPane(i: number) {
    const p = this.panes[i]; if (!p) return;
    const c = p.sc.snapshot(this.isDark() ? '#1e1e1b' : '#ffffff');
    c.toBlob((b) => b && downloadBlob(b, `${this.ds.name}_${p.spec?.title ?? 'plot'}.png`));
  }

  // ---------------- view state ----------------
  getView() {
    const paneState = this.panes.map((p) => {
      const sp = p.spec;
      return {
        embedding: p.embedding?.name, axes: p.axes, flipY: p.flipY, view: p.sc.view, autoFit: p.sc.autoFit,
        hidden: sp?.type === 'cat' ? [...p.hidden].map((c) => sp.col.categories[c]) : [],
      };
    });
    return {
      app: 'anndata-browser', version: 1, dataset: { name: this.ds.name, n: this.ds.n },
      leftObs: this.leftObs, right: (this.right.kind === 'obs' ? { kind: 'obs', key: this.right.key } : { kind: 'gene' }) as { kind: 'gene' } | { kind: 'obs'; key: string }, gene: this.gene,
      layer: this.layerInfo.name, transform: this.transform, cmap: this.cmap, clip: this.clip, highlight: this.highlight,
      pointSize: this.panes[0]?.sc.pointSize, labelPx: this.labelPx, labels: this.labels, sortZ: this.sortZ, syncZoom: this.syncZoom, panes: paneState,
    };
  }
  saveView() { downloadText(JSON.stringify(this.getView(), null, 2), `${this.ds.name}_view.json`, 'application/json'); }
  async applyView(v: ReturnType<App['getView']>) {
    if (v.app !== 'anndata-browser') throw new Error('This is not an AnnData Browser view file.');
    if (v.dataset.n !== this.ds.n) { if (!confirm(`This view was saved for a dataset with ${v.dataset.n.toLocaleString()} cells (this one has ${this.ds.n.toLocaleString()}). Apply anyway?`)) return; }
    if (v.layer !== this.layerInfo.name && this.ds.layers.some((l) => l.name === v.layer)) { this.layerInfo = this.ds.layers.find((l) => l.name === v.layer)!; $<HTMLSelectElement>('layer-sel').value = v.layer; this.buildGeneIndex(); this.geneCache.clear(); }
    this.transform = v.transform; $<HTMLSelectElement>('transform-sel').value = v.transform;
    this.cmap = v.cmap; $<HTMLSelectElement>('cmap-sel').value = v.cmap; this.clip = v.clip; ($('clip-chk') as HTMLInputElement).checked = v.clip;
    this.specCache.clear();
    if (this.ds.obs[v.leftObs]) { this.leftObs = v.leftObs; $<HTMLSelectElement>('obs-sel').value = v.leftObs; }
    if (v.right.kind === 'obs' && this.ds.obs[v.right.key]) { this.right = { kind: 'obs', key: v.right.key }; $<HTMLSelectElement>('obs-sel2').value = v.right.key; }
    else { this.right = { kind: 'gene' }; $<HTMLSelectElement>('obs-sel2').value = GENE_NONE; }
    if (v.gene && this.findGene(v.gene) >= 0) { this.gene = this.geneNames[this.findGene(v.gene)]; ($('gene-input') as HTMLInputElement).value = this.gene; }
    this.highlight = v.highlight; ($('highlight-input') as HTMLInputElement).value = v.highlight;
    this.labels = v.labels; this.toggleBtn('lblbtn', 'Labels', v.labels); this.syncZoom = v.syncZoom; this.toggleBtn('syncbtn', 'Sync zoom', v.syncZoom);
    this.sortZ = v.sortZ; $('zbtn').textContent = 'Z: ' + (v.sortZ ? 'sorted' : 'random'); $('zbtn').classList.toggle('on', v.sortZ);
    this.labelPx = v.labelPx; ($('lblsz') as HTMLInputElement).value = String(v.labelPx); $('lblszval').textContent = String(v.labelPx);
    if (v.pointSize) { ($('ptsz') as HTMLInputElement).value = String(v.pointSize); $('ptval').textContent = String(v.pointSize); this.panes.forEach((p) => (p.sc.pointSize = v.pointSize!)); }
    v.panes.forEach((ps, i) => {
      const p = this.panes[i], en = ps.embedding; if (!p || !en) return;
      if (this.ds.embeddings.some((e) => e.name === en)) p.setEmbeddingByName(en, ps.axes);
      p.flipY = ps.flipY; p.sc.flipY = ps.flipY;
      if (ps.autoFit) p.sc.resetView(); else { p.sc.view = { ...ps.view }; p.sc.autoFit = false; }
    });
    await this.refreshSpecs();
    v.panes.forEach((ps, i) => {
      const p = this.panes[i], sp = p?.spec; if (!p || sp?.type !== 'cat') return;
      p.hidden = new Set(ps.hidden.map((n) => sp.col.categories.indexOf(n)).filter((c) => c >= 0));
    });
    this.composeAll();
    this.onGeneChanged.forEach((f) => f());
  }

  /** Custom annotations (columns not present in the original file) as JSON, for sharing or merging back with scbpack. */
  exportAnnotations(names: string[]) {
    const cols: Record<string, { categories: string[]; labels: (string | null)[] }> = {};
    for (const k of names) {
      const c = this.ds.obs[k]; if (!isCat(c)) continue;
      cols[k] = { categories: c.categories, labels: Array.from(c.codes, (x) => (x >= 0 ? c.categories[x] : null)) };
    }
    downloadText(JSON.stringify({ app: 'anndata-browser', version: 1, dataset: this.ds.name, cell_ids: this.ds.obsNames, columns: cols }), `${this.ds.name}_annotations.json`, 'application/json');
  }
  customAnnotations: string[] = [];

  async open(src: File | { url: string }) {
    try { await this.load(src); } catch (e) {
      this.hideLoading();
      const msg = (e as Error).message || String(e);
      if ($('app').hidden) { const box = $('welcome-error'); box.hidden = false; box.textContent = msg; }
      // A failed open leaves the previous dataset on screen unchanged, which is easy to
      // misread as the new file having loaded with features missing. Say so explicitly.
      else alert(`${msg}\n\nNothing was loaded — you are still viewing ${this.ds?.name ?? 'the previous dataset'}.`);
    }
  }

  exportCsv(name: string, header: string[], rows: (string | number)[][]) {
    const q = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    downloadText([header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n'), name, 'text/csv');
  }
  makeAnnotationFromSelection(name: string, groupName: string, other = 'other'): CatCol {
    const n = this.ds.n, vals: string[] = new Array(n);
    for (let i = 0; i < n; i++) vals[i] = this.selection && this.selection[i] ? groupName : other;
    const col = catFromValues(vals, 'first');
    return col;
  }
  /** Colours currently used for a categorical column (user overrides, uns colours or palette). */
  colorsOf(key: string): string[] | null {
    const c = this.ds.obs[key]; if (!isCat(c)) return null;
    return this.catColorOverride.get(key) ?? categoryColors(c);
  }
  get obsCols(): [string, ObsCol][] { return this.ds.obsOrder.map((k) => [k, this.ds.obs[k]]); }
}

function downloadBlob(b: Blob, name: string) {
  const a = document.createElement('a'); a.download = name; a.href = URL.createObjectURL(b); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v: number) => (v !== v ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
