import type { App } from '../app';
import { isCat, isNum, type CatCol, type Markers } from '../data/schema';
import { CanvasDraw, LIGHT, SvgDraw, currentTheme, downloadText, type Chart } from '../panels/draw';
import { barChart, dotPlot, heatmap, pointScatter, stackedBars, violin, volcano, type DotChart } from '../panels/charts';
import { categoryColors } from '../render/color';
import type { DeResult } from '../data/compute';

const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Panel { id: string; el: HTMLElement; open: boolean; refresh(): void | Promise<void>; refreshSelectors?(): void; leftChanged?(): void }

export class Dock {
  private panels = new Map<string, Panel>();
  private root = document.getElementById('dock')!;
  private nav = document.getElementById('docknav')!;
  private ac = new AbortController();

  constructor(private app: App) {
    this.root.innerHTML = '';
    const build: Record<string, () => Panel> = {
      selection: () => selectionPanel(app), crosstab: () => crosstabPanel(app), dot: () => dotPanel(app, 'dot'), heat: () => dotPanel(app, 'heat'),
      violin: () => violinPanel(app), count: () => countPanel(app), g2g: () => g2gPanel(app), gset: () => gsetPanel(app), notes: () => notesPanel(app),
    };
    for (const [id, fn] of Object.entries(build)) { const p = fn(); this.panels.set(id, p); p.el.style.display = 'none'; this.root.appendChild(p.el); }
    this.nav.querySelectorAll<HTMLButtonElement>('button[data-panel]').forEach((b) => {
      const c = b.cloneNode(true) as HTMLButtonElement; b.replaceWith(c); c.classList.remove('on');
      c.addEventListener('click', () => this.toggle(c.dataset.panel!, c), { signal: this.ac.signal });
    });
    app.onSelectionChanged.push(() => { const p = this.panels.get('selection'); if (p?.open) p.refresh(); });
    app.onGeneChanged.push(() => this.panels.forEach((p) => { if (p.open && ['violin', 'g2g'].includes(p.id)) p.refresh(); }));
  }
  destroy() { this.ac.abort(); }

  toggle(id: string, btn?: HTMLElement) {
    const p = this.panels.get(id)!; p.open = !p.open;
    p.el.style.display = p.open ? 'flex' : 'none';
    btn?.classList.toggle('on', p.open);
    if (p.open) { if (!p.el.style.height) p.el.style.height = id === 'notes' || id === 'gset' ? '190px' : '330px'; p.refresh(); }
    this.app.panes.forEach((q) => q.sizeChanged());
  }
  refreshSelectors() { this.panels.forEach((p) => p.refreshSelectors?.()); }
  onLeftObsChanged() { this.panels.forEach((p) => { p.leftChanged?.(); if (p.open && ['crosstab', 'dot', 'heat', 'count', 'violin'].includes(p.id)) p.refresh(); }); }
  redrawOpen() { this.panels.forEach((p) => p.open && p.refresh()); }
}

// ---------------------------------------------------------------- helpers
function shell(id: string, title: string, controls: string): { el: HTMLElement; body: HTMLElement; q: <T extends HTMLElement>(s: string) => T } {
  const el = h(`<div class="bottom-panel" id="panel-${id}"><div class="bp-resize"></div><div class="bp-toolbar"><b>${title}</b>${controls}</div><div class="bp-body"></div></div>`);
  const body = el.querySelector<HTMLElement>('.bp-body')!;
  const rz = el.querySelector<HTMLElement>('.bp-resize')!;
  rz.addEventListener('pointerdown', (e) => {
    rz.setPointerCapture(e.pointerId); const y0 = e.clientY, h0 = el.clientHeight;
    const mv = (m: PointerEvent) => { el.style.height = Math.max(140, Math.min(window.innerHeight * 0.7, h0 + (y0 - m.clientY))) + 'px'; };
    const up = () => { rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); el.dispatchEvent(new Event('resized')); };
    rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
  });
  return { el, body, q: (s) => el.querySelector(s) as never };
}
function fill(sel: HTMLSelectElement, keys: string[], value?: string) {
  const old = value ?? sel.value; sel.innerHTML = '';
  for (const k of keys) { const o = document.createElement('option'); o.value = o.textContent = k; sel.appendChild(o); }
  if (keys.includes(old)) sel.value = old;
}
const catKeys = (app: App, max = 400) => app.ds.obsOrder.filter((k) => { const c = app.ds.obs[k]; return isCat(c) && c.categories.length <= max; });
function paint(canvas: HTMLCanvasElement, chart: Chart) { const d = new CanvasDraw(canvas, chart.w, chart.h); chart.paint(d, currentTheme()); }
function exportSvg(chart: Chart, name: string) { const s = new SvgDraw(chart.w, chart.h, LIGHT.bg); chart.paint(s, LIGHT); downloadText(s.toString(), name, 'image/svg+xml'); }
function availW(el: HTMLElement) { return Math.max(400, el.clientWidth - 30); }
function groupsOf(col: CatCol): string[] { return col.categories; }
const SVG_BTN = '<button class="hbtn sp" data-act="svg">⬇ SVG</button>';

// ---------------------------------------------------------------- counts
function countPanel(app: App): Panel {
  const s = shell('count', 'Cell counts', `<label>Group by</label><select data-k="col"></select><label>Sort</label><select data-k="sort"><option value="count">count</option><option value="name">name</option></select>${SVG_BTN}`);
  const col = s.q<HTMLSelectElement>('[data-k=col]'), sort = s.q<HTMLSelectElement>('[data-k=sort]');
  const cv = document.createElement('canvas'); s.body.appendChild(cv);
  let chart: Chart | null = null;
  const p: Panel = {
    id: 'count', el: s.el, open: false,
    refreshSelectors() { fill(col, catKeys(app)); },
    leftChanged() { if (!p.open) col.value = app.leftObs; },
    refresh() {
      if (!col.options.length) fill(col, catKeys(app), app.leftObs);
      const c = app.ds.obs[col.value]; if (!isCat(c)) return;
      const counts = new Array(c.categories.length).fill(0);
      for (let i = 0; i < c.codes.length; i++) if (c.codes[i] >= 0) counts[c.codes[i]]++;
      const colors = app.colorsOf(col.value) ?? categoryColors(c);
      let idx = counts.map((_, i) => i);
      idx = sort.value === 'count' ? idx.sort((a, b) => counts[b] - counts[a]) : idx.sort((a, b) => c.categories[a].localeCompare(c.categories[b], undefined, { numeric: true }));
      chart = barChart({ labels: idx.map((i) => c.categories[i]), values: idx.map((i) => counts[i]), colors: idx.map((i) => colors[i]), yLabel: '# cells' }, availW(s.body));
      paint(cv, chart);
    },
  };
  col.onchange = sort.onchange = () => p.refresh();
  s.q('[data-act=svg]').onclick = () => chart && exportSvg(chart, `counts_${col.value}.svg`);
  fill(col, catKeys(app), app.leftObs);
  s.el.addEventListener('resized', () => p.refresh());
  return p;
}

// ---------------------------------------------------------------- composition (crosstab)
function crosstabPanel(app: App): Panel {
  const s = shell('crosstab', 'Composition', `<label>Bars</label><select data-k="row"></select><label>Stacked by</label><select data-k="col"></select><select data-k="mode"><option value="prop">proportion</option><option value="count">count</option></select><button class="hbtn" data-act="swap">Swap</button>${SVG_BTN}`);
  const rowS = s.q<HTMLSelectElement>('[data-k=row]'), colS = s.q<HTMLSelectElement>('[data-k=col]'), mode = s.q<HTMLSelectElement>('[data-k=mode]');
  const wrap = document.createElement('div'); wrap.className = 'bp-split';
  const cv = document.createElement('canvas'), leg = document.createElement('div'); leg.style.cssText = 'font-size:12px;min-width:140px';
  wrap.append(cv, leg); s.body.appendChild(wrap);
  let chart: Chart | null = null;
  const p: Panel = {
    id: 'crosstab', el: s.el, open: false,
    refreshSelectors() { fill(rowS, catKeys(app)); fill(colS, catKeys(app)); },
    refresh() {
      const keys = catKeys(app);
      if (!rowS.options.length) { fill(rowS, keys, app.leftObs); const other = keys.find((k) => k !== rowS.value); fill(colS, keys, other); }
      const r = app.ds.obs[rowS.value], c = app.ds.obs[colS.value]; if (!isCat(r) || !isCat(c)) return;
      const counts = r.categories.map(() => new Array(c.categories.length).fill(0));
      for (let i = 0; i < r.codes.length; i++) if (r.codes[i] >= 0 && c.codes[i] >= 0) counts[r.codes[i]][c.codes[i]]++;
      const colColors = app.colorsOf(colS.value) ?? categoryColors(c);
      chart = stackedBars({ rows: r.categories, cols: c.categories, colColors, counts, rowKey: rowS.value, colKey: colS.value, asProportion: mode.value === 'prop' }, availW(s.body));
      paint(cv, chart);
      leg.innerHTML = `<div style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--mut);margin-bottom:6px">${esc(colS.value)}</div>` +
        c.categories.map((k, i) => `<div style="display:flex;gap:6px;align-items:center;padding:1px 0"><span style="width:10px;height:10px;border-radius:50%;background:${colColors[i]}"></span>${esc(k)}</div>`).join('');
    },
  };
  rowS.onchange = colS.onchange = mode.onchange = () => p.refresh();
  s.q('[data-act=swap]').onclick = () => { const t = rowS.value; rowS.value = colS.value; colS.value = t; p.refresh(); };
  s.q('[data-act=svg]').onclick = () => chart && exportSvg(chart, `composition_${rowS.value}_${colS.value}.svg`);
  s.el.addEventListener('resized', () => p.refresh());
  return p;
}

// ---------------------------------------------------------------- violin
function violinPanel(app: App): Panel {
  const s = shell('violin', 'Violin', `<label>Groups</label><select data-k="x"></select><label>Value</label><select data-k="y"></select>${SVG_BTN}`);
  const xS = s.q<HTMLSelectElement>('[data-k=x]'), yS = s.q<HTMLSelectElement>('[data-k=y]');
  const cv = document.createElement('canvas'); s.body.appendChild(cv);
  let chart: Chart | null = null, seq = 0;
  const fillY = () => {
    const nums = app.ds.obsOrder.filter((k) => isNum(app.ds.obs[k]));
    const old = yS.value; yS.innerHTML = '';
    const g = document.createElement('option'); g.value = '__gene__'; g.textContent = '[current gene]'; yS.appendChild(g);
    nums.forEach((k) => { const o = document.createElement('option'); o.value = o.textContent = k; yS.appendChild(o); });
    if (old) yS.value = old;
  };
  const p: Panel = {
    id: 'violin', el: s.el, open: false,
    refreshSelectors() { fill(xS, catKeys(app)); fillY(); },
    async refresh() {
      if (!xS.options.length) { fill(xS, catKeys(app), app.leftObs); fillY(); }
      const c = app.ds.obs[xS.value]; if (!isCat(c)) return;
      const my = ++seq;
      let y: Float32Array | null; let yLabel: string;
      if (yS.value === '__gene__') { y = app.gene ? await app.getGene(app.gene) : null; yLabel = app.gene ?? ''; }
      else { const col = app.ds.obs[yS.value]; y = isNum(col) ? col.values : null; yLabel = yS.value; }
      if (!y || my !== seq) return;
      const lists: number[][] = c.categories.map(() => []);
      for (let i = 0; i < c.codes.length; i++) if (c.codes[i] >= 0 && y[i] === y[i]) lists[c.codes[i]].push(y[i]);
      const colors = app.colorsOf(xS.value) ?? categoryColors(c);
      chart = violin({ cats: c.categories, colors, groups: lists.map((l) => Float32Array.from(l)), yLabel, xLabel: xS.value }, availW(s.body));
      paint(cv, chart);
    },
  };
  xS.onchange = yS.onchange = () => p.refresh();
  s.q('[data-act=svg]').onclick = () => chart && exportSvg(chart, `violin_${xS.value}_${yS.value}.svg`);
  s.el.addEventListener('resized', () => p.refresh());
  return p;
}

// ---------------------------------------------------------------- dot plot + heatmap (shared gene list control)
function topMarkerGenes(app: App, n: number): string[] {
  const m = app.markers; if (!m) return [];
  const out: string[] = [], seen = new Set<string>();
  for (const rows of Object.values(m.groups)) {
    let k = 0;
    for (const r of rows) {
      if (k >= n) break; const i = app.findGene(r.gene); if (i < 0) continue;
      const nm = app.geneNames[i]; if (!seen.has(nm)) { seen.add(nm); out.push(nm); } k++;
    }
  }
  return out;
}

function dotPanel(app: App, kind: 'dot' | 'heat'): Panel {
  const title = kind === 'dot' ? 'Dot plot' : 'Heatmap';
  const s = shell(kind, title, `<label>Group by</label><select data-k="grp"></select><label>Genes</label><select data-k="src"><option value="markers">top markers</option><option value="custom">custom list</option></select>
    <label data-k="nlab">per group</label><input type="number" data-k="n" value="3" min="1" max="20" style="width:56px;min-width:0">
    ${kind === 'dot' ? '<select data-k="scale"><option value="gene">scale per gene</option><option value="global">global scale</option></select>' : ''}
    <button class="hbtn" data-act="compute" title="Run one-vs-rest differential expression for every group">Compute markers</button>${SVG_BTN}`);
  const custom = h('<textarea data-k="list" placeholder="Gene names, one per line or comma-separated…" style="width:100%;height:56px;display:none;margin-bottom:6px"></textarea>') as HTMLTextAreaElement;
  const cv = document.createElement('canvas'); s.body.append(custom, cv);
  const grp = s.q<HTMLSelectElement>('[data-k=grp]'), src = s.q<HTMLSelectElement>('[data-k=src]'), nIn = s.q<HTMLInputElement>('[data-k=n]');
  const scale = kind === 'dot' ? s.q<HTMLSelectElement>('[data-k=scale]') : null;
  let chart: Chart | null = null, seq = 0;
  const p: Panel = {
    id: kind, el: s.el, open: false,
    refreshSelectors() { fill(grp, catKeys(app)); },
    leftChanged() { /* group-by is independent once chosen */ },
    async refresh() {
      if (!grp.options.length) {
        fill(grp, catKeys(app), app.markers?.groupby ?? app.leftObs);
        if (!app.markers) src.value = 'custom';
      }
      custom.style.display = src.value === 'custom' ? 'block' : 'none';
      s.q<HTMLElement>('[data-k=nlab]').style.display = nIn.style.display = src.value === 'markers' ? '' : 'none';
      const c = app.ds.obs[grp.value]; if (!isCat(c)) return;
      let names: string[], idx: number[];
      if (src.value === 'markers') { const r = app.resolveGenes(topMarkerGenes(app, +nIn.value || 3)); names = r.names; idx = r.idx; }
      else { const r = app.resolveGenes(custom.value.split(/[\s,;]+/)); names = r.names; idx = r.idx; }
      if (!idx.length) { cv.width = cv.height = 0; cv.style.width = cv.style.height = '0'; s.body.dataset.msg = ''; hint(s.body, src.value === 'markers' && !app.markers ? (app.remote ? 'This dataset has no precomputed marker genes. Switch to a custom gene list, or open the .h5ad locally to compute them.' : 'No marker genes found in this file. Use “Compute markers” or switch to a custom gene list.') : 'Enter gene names above.'); return; }
      hint(s.body, '');
      const my = ++seq;
      const st = await app.client.groupStats(app.layerInfo.name, idx, c.codes, c.categories.length, app.transform);
      if (my !== seq) return;
      if (kind === 'dot') {
        const dc: DotChart = dotPlot({ groups: c.categories, genes: names, mean: st.mean, pct: st.pct, scale: (scale!.value as 'gene' | 'global'), map: app.cmap });
        chart = dc; paint(cv, dc);
        cv.style.cursor = 'pointer';
        cv.onclick = (e) => { const r = cv.getBoundingClientRect(), gi = Math.floor((e.clientX - r.left - dc.padL) / dc.cell); if (gi >= 0 && gi < names.length) app.selectGene(names[gi]); };
      } else { chart = heatmap({ groups: c.categories, genes: names, mean: st.mean, map: app.cmap }); paint(cv, chart); }
    },
  };
  grp.onchange = src.onchange = nIn.onchange = custom.oninput = () => p.refresh();
  if (scale) scale.onchange = () => p.refresh();
  s.q('[data-act=svg]').onclick = () => chart && exportSvg(chart, `${kind}plot_${grp.value}.svg`);
  const computeBtn = s.q<HTMLButtonElement>('[data-act=compute]');
  if (app.remote) {
    // Marker finding reads every gene once per group; over HTTP that is one request per gene
    // per group, so it is offered only for a locally opened file. Hosted datasets instead
    // carry markers computed at pack time (scbpack --markers), so say so rather than
    // showing a control that cannot be used.
    const note = document.createElement('span');
    note.className = 'pill';
    note.textContent = app.markers ? 'markers precomputed' : 'no stored markers';
    note.title = app.markers
      ? `Marker genes were computed when this dataset was packed${app.markers.groupby ? ` (grouped by \u201c${app.markers.groupby}\u201d)` : ''}, so nothing is computed here. To rank markers for a different annotation, open the .h5ad locally.`
      : 'This dataset was published without precomputed marker genes. Enter a custom gene list, or open the .h5ad locally to compute markers.';
    computeBtn.replaceWith(note);
  } else {
    computeBtn.onclick = () => app.guard(async () => { await computeMarkers(app, grp.value); src.value = 'markers'; p.refresh(); });
  }
  s.el.addEventListener('resized', () => p.refresh());
  fill(grp, catKeys(app), app.markers?.groupby ?? app.leftObs);
  return p;
}
function hint(body: HTMLElement, msg: string) {
  let d = body.querySelector<HTMLElement>('.hintmsg');
  if (!d) { d = document.createElement('div'); d.className = 'hintmsg'; d.style.cssText = 'color:var(--mut);font-size:12px;padding:8px'; body.appendChild(d); }
  d.textContent = msg; d.style.display = msg ? 'block' : 'none';
}

/** One-vs-rest Wilcoxon for every category; keeps the top genes per group as `app.markers`. */
export async function computeMarkers(app: App, key: string, topN = 30) {
  const c = app.ds.obs[key]; if (!isCat(c)) return;
  const groups: Markers['groups'] = {};
  for (let k = 0; k < c.categories.length; k++) {
    app.showLoading(`Finding markers: ${c.categories[k]} (${k + 1}/${c.categories.length})`, k / c.categories.length);
    const mask = new Uint8Array(c.codes.length); let cnt = 0;
    for (let i = 0; i < mask.length; i++) if (c.codes[i] === k) { mask[i] = 1; cnt++; }
    if (cnt < 3 || cnt > mask.length - 3) { groups[c.categories[k]] = []; continue; }
    const r = await app.client.de(app.layerInfo.name, mask, null, app.transform);
    const order = Array.from(r.z.keys()).filter((g) => r.lfc[g] > 0).sort((a, b) => r.z[b] - r.z[a]).slice(0, topN);
    groups[c.categories[k]] = order.map((g) => ({ gene: app.geneNames[g], score: r.z[g], lfc: r.lfc[g], padj: r.padjW[g] }));
  }
  app.hideLoading();
  app.markers = { groupby: key, groups };
}

// ---------------------------------------------------------------- gene vs gene
function g2gPanel(app: App): Panel {
  const s = shell('g2g', 'Gene vs gene', `<label>X</label><input type="text" data-k="x" style="min-width:100px;width:110px"><label>Y</label><input type="text" data-k="y" style="min-width:100px;width:110px"><button class="hbtn" data-act="plot">Plot</button><span class="pill" data-k="r"></span><span style="font-size:11px">points coloured by the left pane</span>${SVG_BTN}`);
  const xi = s.q<HTMLInputElement>('[data-k=x]'), yi = s.q<HTMLInputElement>('[data-k=y]'), rl = s.q<HTMLElement>('[data-k=r]');
  const cv = document.createElement('canvas'); s.body.appendChild(cv);
  let chart: Chart | null = null;
  const p: Panel = {
    id: 'g2g', el: s.el, open: false,
    async refresh() {
      if (!xi.value && app.gene) xi.value = app.gene;
      if (!yi.value) yi.value = app.geneNames[Math.min(1, app.geneNames.length - 1)] ?? '';
      const [a, b] = await Promise.all([app.getGene(xi.value), app.getGene(yi.value)]);
      if (!a || !b) { rl.textContent = 'gene not found'; return; }
      const rgba = app.panes[0].baseRgba;
      const colors = rgba ? (i: number) => `rgb(${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]})` : null;
      chart = pointScatter({ x: a, y: b, colors, xLabel: xi.value, yLabel: yi.value });
      paint(cv, chart);
      let ma = 0, mb = 0; const n = a.length; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
      let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
      rl.textContent = `Pearson r = ${(sab / Math.sqrt(saa * sbb || 1)).toFixed(3)}`;
    },
  };
  s.q('[data-act=plot]').onclick = () => app.guard(async () => { await p.refresh(); });
  for (const i of [xi, yi]) i.onkeydown = (e) => { if (e.key === 'Enter') app.guard(async () => { await p.refresh(); }); };
  s.q('[data-act=svg]').onclick = () => chart && exportSvg(chart, `${xi.value}_vs_${yi.value}.svg`);
  return p;
}

// ---------------------------------------------------------------- gene set
function gsetPanel(app: App): Panel {
  const s = shell('gset', 'Gene set score', `<span style="font-size:11px">mean expression of the genes, shown in the right pane</span><button class="hbtn sp" data-act="clear">Back to gene</button>`);
  const ta = h('<textarea placeholder="Paste gene names, one per line or comma-separated…" style="width:100%;height:60px;margin-bottom:6px"></textarea>') as HTMLTextAreaElement;
  const row = h('<div style="display:flex;gap:10px;align-items:center"><button class="hbtn" data-act="run">Score cells</button><span data-k="msg" style="font-size:12px;color:var(--mut)"></span></div>');
  s.body.append(ta, row);
  const msg = row.querySelector<HTMLElement>('[data-k=msg]')!;
  row.querySelector<HTMLElement>('[data-act=run]')!.onclick = () => app.guard(async () => {
    const r = await app.setGeneSet(ta.value.split(/[\s,;]+/).filter(Boolean));
    msg.textContent = r.found ? `${r.found} genes used${r.missing.length ? `, ${r.missing.length} not found (${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? '…' : ''})` : ''}` : 'None of those genes are in this dataset.';
  });
  s.q('[data-act=clear]').onclick = () => { app.right = { kind: 'gene' }; app.refreshSpecs(1); msg.textContent = ''; };
  return { id: 'gset', el: s.el, open: false, refresh() { /* static */ } };
}

// ---------------------------------------------------------------- notes
function notesPanel(app: App): Panel {
  const s = shell('notes', 'Group notes', `<label>Group</label><select data-k="g"></select><button class="hbtn" data-act="save">Save</button><button class="hbtn" data-act="export">Export all</button><span data-k="st" style="font-size:11px"></span>`);
  const sel = s.q<HTMLSelectElement>('[data-k=g]'), st = s.q<HTMLElement>('[data-k=st]');
  const ta = h('<textarea placeholder="Notes about this group (saved in this browser)…" style="width:100%;height:78px"></textarea>') as HTMLTextAreaElement;
  s.body.appendChild(ta);
  const store = () => `anndata-browser:notes:${app.ds.name}:${app.ds.n}`;
  const load = (): Record<string, Record<string, string>> => { try { return JSON.parse(localStorage.getItem(store()) ?? '{}'); } catch { return {}; } };
  const save = (all: Record<string, Record<string, string>>) => { try { localStorage.setItem(store(), JSON.stringify(all)); } catch { /* storage unavailable */ } };
  const key = () => app.leftObs;
  const show = () => { ta.value = load()[key()]?.[sel.value] ?? ''; };
  const p: Panel = {
    id: 'notes', el: s.el, open: false,
    leftChanged() { this.refresh(); },
    refresh() {
      const c = app.ds.obs[app.leftObs]; if (!isCat(c)) { sel.innerHTML = ''; return; }
      fill(sel, groupsOf(c)); show();
    },
  };
  sel.onchange = show;
  s.q('[data-act=save]').onclick = () => { const all = load(); (all[key()] ??= {})[sel.value] = ta.value; save(all); st.textContent = 'Saved ✓'; setTimeout(() => (st.textContent = ''), 1500); };
  s.q('[data-act=export]').onclick = () => {
    const all = load(); const lines: string[] = [];
    for (const [col, g] of Object.entries(all)) for (const [name, txt] of Object.entries(g)) if (txt.trim()) lines.push(`## ${col} / ${name}\n${txt}`);
    downloadText(lines.join('\n\n') || '(no notes)', `${app.ds.name}_notes.txt`);
  };
  return p;
}

// ---------------------------------------------------------------- selection / differential expression
function selectionPanel(app: App): Panel {
  const s = shell('selection', 'Selection & differential expression', `<span class="pill" data-k="cnt">0 cells selected</span>
    <button class="hbtn" data-act="clear">Clear</button><button class="hbtn" data-act="ids">Export IDs</button><button class="hbtn" data-act="annot">Save as annotation…</button><button class="hbtn" data-act="annexp" title="Export all annotations you created in this session">Export annotations</button>`);
  s.body.innerHTML = `
    <div style="font-size:12px;color:var(--mut);margin-bottom:8px">Use the <b>Box</b> / <b>Lasso</b> tools (or shift-drag) on either plot to select cells. ⌘/Ctrl-drag adds, Alt-drag removes, Esc clears.</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px">
      <label>Test</label>
      <select data-k="a"><option value="sel">selected cells</option><option value="cat">cells in</option></select>
      <span data-k="acat" style="display:none"><select data-k="acol"></select><select data-k="aval"></select></span>
      <label>vs</label>
      <select data-k="b"><option value="rest">all other cells</option><option value="cat">cells in</option></select>
      <span data-k="bcat" style="display:none"><select data-k="bcol"></select><select data-k="bval"></select></span>
      <button class="hbtn" data-act="run" style="background:var(--acc);color:#fff;border-color:var(--acc)">Run DE</button>
      <select data-k="view"><option value="up">top up in test</option><option value="down">top down in test</option><option value="abs">top |z|</option></select>
      <button class="hbtn" data-act="csv">⬇ CSV (all genes)</button>
    </div>
    <div class="bp-split"><div data-k="tbl" style="max-height:230px;overflow:auto;min-width:420px"></div><canvas data-k="vol"></canvas></div>`;
  const q = <T extends HTMLElement>(k: string) => s.body.querySelector(`[data-k=${k}]`) as T;
  const cnt = s.q<HTMLElement>('[data-k=cnt]');
  const aSel = q<HTMLSelectElement>('a'), bSel = q<HTMLSelectElement>('b'), acat = q('acat'), bcat = q('bcat');
  const acol = q<HTMLSelectElement>('acol'), aval = q<HTMLSelectElement>('aval'), bcol = q<HTMLSelectElement>('bcol'), bval = q<HTMLSelectElement>('bval');
  let res: DeResult | null = null, volChart: Chart | null = null;
  const setVals = (col: HTMLSelectElement, val: HTMLSelectElement) => { const c = app.ds.obs[col.value]; fill(val, isCat(c) ? c.categories : [], ''); };
  const refreshCols = () => { const k = catKeys(app); fill(acol, k, app.leftObs); fill(bcol, k, app.leftObs); setVals(acol, aval); setVals(bcol, bval); };
  const maskFor = (which: 'a' | 'b'): Uint8Array | null => {
    const mode = (which === 'a' ? aSel : bSel).value;
    if (mode === 'sel') return app.selection ? app.selection.slice() : null;
    if (mode === 'rest') return null;
    const col = app.ds.obs[(which === 'a' ? acol : bcol).value]; if (!isCat(col)) return null;
    const code = col.categories.indexOf((which === 'a' ? aval : bval).value), m = new Uint8Array(col.codes.length);
    for (let i = 0; i < m.length; i++) m[i] = col.codes[i] === code ? 1 : 0;
    return m;
  };
  const renderTable = () => {
    const box = q('tbl'); if (!res) { box.innerHTML = ''; return; }
    const r = res, G = r.gene.length, view = q<HTMLSelectElement>('view').value;
    let order = Array.from({ length: G }, (_, i) => i);
    const sortBy = (f: (g: number) => number) => order.sort((x, y) => f(y) - f(x));
    if (view === 'up') order = sortBy((g) => r.z[g]); else if (view === 'down') order = sortBy((g) => -r.z[g]); else order = sortBy((g) => Math.abs(r.z[g]));
    const rows = order.slice(0, 100).map((g) => `<tr class="g" data-g="${g}"><td>${esc(app.geneNames[g])}</td><td>${r.lfc[g].toFixed(2)}</td><td>${(r.pctA[g] * 100).toFixed(0)}%</td><td>${(r.pctB[g] * 100).toFixed(0)}%</td><td>${r.z[g].toFixed(1)}</td><td>${r.padjW[g] < 1e-3 ? r.padjW[g].toExponential(1) : r.padjW[g].toFixed(3)}</td></tr>`).join('');
    box.innerHTML = `<div style="font-size:11px;color:var(--mut);margin-bottom:4px">${r.nA.toLocaleString()} cells vs ${r.nB.toLocaleString()} cells · Wilcoxon rank-sum, BH-adjusted · click a gene to colour the right pane</div><table class="tbl"><thead><tr><th>gene</th><th>log2FC</th><th>% test</th><th>% ref</th><th>z</th><th>p adj</th></tr></thead><tbody>${rows}</tbody></table>`;
    box.querySelectorAll<HTMLElement>('tr.g').forEach((tr) => (tr.onclick = () => app.selectGene(app.geneNames[+tr.dataset.g!])));
    volChart = volcano({ lfc: r.lfc, p: r.padjW, names: app.geneNames.slice(0, G), labelTop: 12 });
    paint(q<HTMLCanvasElement>('vol'), volChart);
  };
  const p: Panel = {
    id: 'selection', el: s.el, open: false,
    refreshSelectors: refreshCols,
    refresh() { cnt.textContent = `${app.selCount.toLocaleString()} cells selected`; if (!acol.options.length) refreshCols(); renderTable(); },
  };
  aSel.onchange = () => (acat.style.display = aSel.value === 'cat' ? '' : 'none');
  bSel.onchange = () => (bcat.style.display = bSel.value === 'cat' ? '' : 'none');
  acol.onchange = () => setVals(acol, aval); bcol.onchange = () => setVals(bcol, bval);
  q<HTMLSelectElement>('view').onchange = renderTable;
  s.q('[data-act=clear]').onclick = () => app.setSelection(null);
  s.q('[data-act=ids]').onclick = () => {
    if (!app.selCount) return app.toast('Nothing selected.');
    downloadText(['cell_id', ...app.selectionIds()].join('\n'), `${app.ds.name}_selected_cells.csv`, 'text/csv');
  };
  s.q('[data-act=annot]').onclick = () => {
    if (!app.selCount) return app.toast('Select some cells first.');
    const name = prompt('Name for the new annotation column:', 'selection'); if (!name) return;
    const grp = prompt('Label for the selected cells:', 'selected'); if (!grp) return;
    app.addAnnotation(name, app.makeAnnotationFromSelection(name, grp));
    app.leftObs = name; (document.getElementById('obs-sel') as HTMLSelectElement).value = name; app.refreshSpecs(0);
  };
  s.q('[data-act=annexp]').onclick = () => { if (!app.customAnnotations.length) return app.toast('No custom annotations yet. Select cells, then “Save as annotation…”.'); app.exportAnnotations(app.customAnnotations); };
  body_run(s, () => app.guard(async () => {
    const A = maskFor('a'); if (!A) return app.toast('Select cells first (Box / Lasso tool) or choose a category to test.');
    const B = maskFor('b');
    res = await app.client.de(app.layerInfo.name, A, B, app.transform, (m, f) => app.showLoading(m, f ?? null));
    app.hideLoading(); renderTable();
  }));
  if (app.remote) {
    // Every gene gets tested, which over HTTP is one request per gene. Keep the panel visible
    // — selections, cell-ID export and annotations all still work — but disable the test.
    const runBtn = s.body.querySelector<HTMLButtonElement>('[data-act=run]')!;
    runBtn.disabled = true;
    runBtn.style.background = runBtn.style.color = runBtn.style.borderColor = '';
    runBtn.title = 'Differential expression reads every gene in the matrix. That is quick on a file opened from your own disk, but a request per gene for a dataset served over the network.';
    const note = document.createElement('span');
    note.className = 'pill';
    note.textContent = 'local files only';
    note.title = runBtn.title;
    runBtn.after(note);
  }
  q('vol').style.display = 'block';
  s.q('[data-act=csv]');
  (s.body.querySelector('[data-act=csv]') as HTMLElement).onclick = () => {
    if (!res) return app.toast('Run a test first.'); const r = res;
    app.exportCsv(`${app.ds.name}_DE.csv`, ['gene', 'log2FC', 'pct_test', 'pct_ref', 'mean_test', 'mean_ref', 'z', 'p_wilcoxon', 'p_adj', 't', 'p_welch'],
      Array.from({ length: r.gene.length }, (_, g) => [app.geneNames[g], r.lfc[g], r.pctA[g], r.pctB[g], r.meanA[g], r.meanB[g], r.z[g], r.pW[g], r.padjW[g], r.t[g], r.pT[g]]));
  };
  return p;
}
function body_run(s: { body: HTMLElement }, fn: () => void) { (s.body.querySelector('[data-act=run]') as HTMLElement).onclick = fn; }
