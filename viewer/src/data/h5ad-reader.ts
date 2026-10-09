// Reads AnnData .h5ad structure from an open h5wasm File. Environment-agnostic (worker or node).
// Nothing here assumes any particular dataset: all column names, embeddings and genes come from the file.
import {
  type CatCol, type Codes, type DatasetPayload, type Embedding, type LayerInfo, type Markers, type MarkerRow,
  type ObsCol, type SpatialInfo, catFromValues, makeCodes,
} from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type H5 = any;

const enc = (node: H5): string => {
  const a = node?.attrs?.['encoding-type'];
  return a ? String(a.value) : '';
};
const num = (x: unknown) => (typeof x === 'bigint' ? Number(x) : (x as number));

export function readStrings(ds: H5): string[] {
  const v = ds.value;
  return Array.isArray(v) ? v.map(String) : Array.from(v as ArrayLike<unknown>, String);
}

function toF32(v: ArrayLike<number | bigint>, mask?: ArrayLike<number> | null): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = mask && mask[i] ? NaN : Number(v[i]);
  return out;
}

/** Read one obs/var column (any anndata encoding). Returns null if unsupported. */
export function readColumn(group: H5, key: string, n: number, colorsFrom?: H5): ObsCol | null {
  const node = group.get(key);
  if (!node) return null;
  const type = enc(node);
  // categorical (anndata >= 0.7)
  if (type === 'categorical' || (node.keys && node.keys().includes('codes') && node.keys().includes('categories'))) {
    const cats = readStrings(node.get('categories'));
    const raw = node.get('codes').value as ArrayLike<number>;
    const codes = makeCodes(n, cats.length);
    for (let i = 0; i < n; i++) codes[i] = raw[i];
    const col: CatCol = { kind: 'cat', codes, categories: cats };
    const cn = colorsFrom?.get?.(`${key}_colors`);
    if (cn) {
      const cs = readStrings(cn);
      if (cs.length >= cats.length) col.colors = cs.slice(0, cats.length);
    }
    return col;
  }
  // nullable integer / boolean
  if (type === 'nullable-integer' || type === 'nullable-boolean' || type === 'nullable-string-array') {
    const vals = node.get('values').value;
    const mask = node.get('mask')?.value as ArrayLike<number> | undefined;
    if (type === 'nullable-string-array') {
      const s = Array.isArray(vals) ? vals.map((x: unknown, i: number) => (mask && mask[i] ? null : String(x))) : [];
      return catOrStr(s);
    }
    if (type === 'nullable-boolean') {
      const s = Array.from(vals as ArrayLike<number>, (x, i) => (mask && mask[i] ? null : x ? 'True' : 'False'));
      return catFromValues(s);
    }
    return { kind: 'num', values: toF32(vals, mask) };
  }
  // plain dataset
  if (node.shape) {
    if (node.shape.length !== 1) return null;
    const dt = String(node.dtype);
    const v = node.value;
    if (dt.includes('S') || dt === 'string' || Array.isArray(v) || dt.startsWith('Reference')) {
      return catOrStr(readStrings(node));
    }
    if (dt === '<b' || dt === '|b1' || dt === 'b') {
      // h5py bool (stored as enum / int8)
      return catFromValues(Array.from(v as ArrayLike<number>, (x) => (x ? 'True' : 'False')));
    }
    return { kind: 'num', values: toF32(v) };
  }
  return null;
}

function catOrStr(vals: (string | null)[]): ObsCol {
  const set = new Set<string>();
  for (const v of vals) { if (v != null) set.add(v); if (set.size > 2000) break; }
  if (set.size <= 2000) return catFromValues(vals);
  return { kind: 'str', values: vals.map((v) => v ?? '') };
}

export interface ReadOptions {
  fileName: string;
  fileSize: number;
  onProgress?: (msg: string, frac?: number) => void;
}

export interface ReadResult {
  payload: DatasetPayload;
  /** names of each layer's matrix node in the file, in payload.layers order */
  layerNodes: Record<string, string>;
}

/** Index column name of a dataframe group. */
function indexName(g: H5): string {
  const a = g.attrs?.['_index'];
  return a ? String(a.value) : '_index';
}
function columnOrder(g: H5): string[] {
  const a = g.attrs?.['column-order'];
  if (!a) return [];
  const v = a.value;
  return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
}

function readFrame(g: H5, n: number, colorsFrom?: H5): { index: string[]; order: string[]; cols: Record<string, ObsCol> } {
  const idxKey = indexName(g);
  const idxNode = g.get(idxKey) ?? g.get('index');
  const index = idxNode ? readStrings(idxNode) : Array.from({ length: n }, (_, i) => String(i));
  let order = columnOrder(g);
  if (!order.length) order = g.keys().filter((k: string) => k !== idxKey && k !== '__categories' && k !== 'index');
  const cols: Record<string, ObsCol> = {};
  const legacy = g.get('__categories');
  for (const k of order) {
    let col: ObsCol | null = null;
    try {
      col = readColumn(g, k, n, colorsFrom);
      // legacy anndata <0.7: int codes + __categories/<k>
      if (col && col.kind === 'num' && legacy?.keys?.().includes(k)) {
        const cats = readStrings(legacy.get(k));
        const codes = makeCodes(n, cats.length);
        for (let i = 0; i < n; i++) codes[i] = Number.isNaN(col.values[i]) ? -1 : col.values[i];
        col = { kind: 'cat', codes, categories: cats };
      }
    } catch (e) {
      console.warn('skipping column', k, e);
    }
    if (col) cols[k] = col;
  }
  return { index, order: order.filter((k) => cols[k]), cols };
}

function matrixInfo(node: H5): { storage: 'csr' | 'csc' | 'dense'; nrow: number; ncol: number; nnz: number } | null {
  if (!node) return null;
  const t = enc(node);
  if (node.keys && (t === 'csr_matrix' || t === 'csc_matrix')) {
    const shape = Array.from(node.attrs['shape'].value as ArrayLike<number | bigint>, num);
    return { storage: t === 'csr_matrix' ? 'csr' : 'csc', nrow: shape[0], ncol: shape[1], nnz: num(node.get('data').shape[0]) };
  }
  if (node.shape && node.shape.length === 2) return { storage: 'dense', nrow: node.shape[0], ncol: node.shape[1], nnz: node.shape[0] * node.shape[1] };
  return null;
}

/** Detect integer-valued (count-like) data from a small sample. */
function sampleLooksLikeCounts(node: H5, storage: string): boolean {
  try {
    let v: ArrayLike<number> | null = null;
    if (storage === 'dense') v = node.slice([[0, Math.min(50, node.shape[0])], [0, Math.min(200, node.shape[1])]]);
    else {
      const d = node.get('data');
      v = d.slice([[0, Math.min(5000, d.shape[0])]]);
    }
    if (!v || !v.length) return false;
    let ints = 0, nz = 0;
    for (let i = 0; i < v.length; i++) { const x = Number(v[i]); if (x !== 0) { nz++; if (Number.isInteger(x)) ints++; } }
    return nz > 0 && ints / nz > 0.999;
  } catch { return false; }
}

function guessSpecies(names: string[]): 'mouse' | 'human' | 'unknown' {
  let up = 0, cap = 0, tot = 0;
  const step = Math.max(1, Math.floor(names.length / 3000));
  for (let i = 0; i < names.length; i += step) {
    const s = names[i];
    if (!/^[A-Za-z]/.test(s) || /^ENS/i.test(s)) continue;
    tot++;
    if (s === s.toUpperCase()) up++;
    else if (/^[A-Z][a-z0-9]/.test(s)) cap++;
  }
  if (tot < 50) return 'unknown';
  if (up / tot > 0.6) return 'human';
  if (cap / tot > 0.6) return 'mouse';
  return 'unknown';
}

const ENSEMBL = /^ENS[A-Z]{0,6}G\d{6,}/i;
/** If the var index is Ensembl-like and a symbol column exists, return its name. */
function pickGeneLabelColumn(varFrame: { index: string[]; cols: Record<string, ObsCol>; order: string[] }): string | null {
  const sample = varFrame.index.slice(0, 200);
  const ensFrac = sample.filter((s) => ENSEMBL.test(s)).length / Math.max(1, sample.length);
  if (ensFrac < 0.8) return null;
  const pref = /^(gene[_ ]?(name|symbol)s?|symbols?|feature[_ ]?name|gene)$/i;
  for (const k of varFrame.order) {
    const c = varFrame.cols[k];
    if (!c) continue;
    if (pref.test(k) && (c.kind === 'str' || c.kind === 'cat')) return k;
  }
  return null;
}
function colAsStrings(c: ObsCol, n: number): string[] {
  if (c.kind === 'str') return c.values;
  if (c.kind === 'cat') return Array.from({ length: n }, (_, i) => (c.codes[i] >= 0 ? c.categories[c.codes[i]] : ''));
  return Array.from({ length: n }, (_, i) => String((c as { values: Float32Array }).values[i]));
}

function readMarkers(f: H5, obsKeys: string[]): Markers | null {
  try {
    if (!f.keys().includes('uns')) return null;
    const uns = f.get('uns');
    if (!uns.keys().includes('rank_genes_groups')) return null;
    const r = uns.get('rank_genes_groups');
    const names = r.get('names');
    const members: string[] = names.metadata?.compound_type?.members?.map((m: H5) => m.name) ?? [];
    if (!members.length) return null;
    const rows = names.value as unknown[][];
    const grab = (key: string): unknown[][] | null => (r.keys().includes(key) ? (r.get(key).value as unknown[][]) : null);
    const scores = grab('scores'), lfc = grab('logfoldchanges'), padj = grab('pvals_adj');
    const groups: Record<string, MarkerRow[]> = {};
    members.forEach((g, j) => {
      const out: MarkerRow[] = [];
      for (let i = 0; i < rows.length; i++) {
        const gene = rows[i][j];
        if (gene == null || gene === '') continue;
        const cell = (a: unknown[][] | null) => {
          if (!a) return null;
          const x = Number(a[i][j]);
          return Number.isFinite(x) ? x : null;
        };
        out.push({ gene: String(gene), score: cell(scores), lfc: cell(lfc), padj: cell(padj) });
      }
      groups[g.trim()] = out;
    });
    let groupby: string | null = null;
    try {
      const gb = r.get('params/groupby')?.value;
      groupby = gb == null ? null : String(Array.isArray(gb) ? gb[0] : gb);
    } catch { /* optional */ }
    if (groupby && !obsKeys.includes(groupby)) groupby = null;
    return { groupby, groups };
  } catch (e) {
    console.warn('could not read rank_genes_groups', e);
    return null;
  }
}

/** First library under uns/spatial that carries an image (Visium-style layout). */
function readSpatial(f: H5): SpatialInfo | null {
  try {
    if (!f.keys().includes('uns')) return null;
    const uns = f.get('uns');
    if (!uns.keys().includes('spatial')) return null;
    const sp = uns.get('spatial');
    for (const lib of sp.keys()) {
      const L = sp.get(lib);
      if (!L?.keys?.().includes('images')) continue;
      const imgs = L.get('images');
      const key = ['hires', 'lowres'].find((k) => imgs.keys().includes(k)) ?? imgs.keys()[0];
      if (!key) continue;
      const node = imgs.get(key);
      if (!node?.shape || node.shape.length !== 3) continue;
      const [h, w, c] = node.shape as number[];
      if (h * w > 40_000_000) continue;
      const raw = node.value as ArrayLike<number>;
      const floaty = !(raw instanceof Uint8Array || raw instanceof Uint8ClampedArray);
      const rgba = new Uint8ClampedArray(h * w * 4);
      for (let i = 0; i < h * w; i++) {
        for (let k = 0; k < 3; k++) { const v = raw[i * c + Math.min(k, c - 1)]; rgba[i * 4 + k] = floaty ? Number(v) * 255 : Number(v); }
        rgba[i * 4 + 3] = 255;
      }
      const sf = L.keys().includes('scalefactors') ? L.get('scalefactors') : null;
      const num2 = (k: string) => { try { const v = sf?.get(k)?.value; return v == null ? null : Number(Array.isArray(v) || ArrayBuffer.isView(v) ? (v as ArrayLike<number>)[0] : v); } catch { return null; } };
      const scale = num2(`tissue_${key}_scalef`) ?? 1;
      return { library: String(lib), imageKey: String(key), scale, spotDiameter: num2('spot_diameter_fullres') ?? 0, width: w, height: h, rgba };
    }
  } catch (e) { console.warn('could not read spatial image', e); }
  return null;
}

/** Read everything except the expression matrices. */
export function readH5adMeta(f: H5, o: ReadOptions): ReadResult {
  const p = o.onProgress ?? (() => {});
  p('Reading cell annotations…');
  const obsG = f.get('obs');
  if (!obsG || !obsG.keys) throw new Error('This file has no readable `obs` group (is it an AnnData .h5ad written by anndata ≥0.7?).');
  const uns = f.keys().includes('uns') ? f.get('uns') : undefined;

  // n from the index length
  const idxNode = obsG.get(indexName(obsG)) ?? obsG.get('index');
  const n = idxNode ? num(idxNode.shape[0]) : 0;
  if (!n) throw new Error('Could not determine the number of cells.');
  const obsFrame = readFrame(obsG, n, uns);

  p('Reading genes…');
  const layers: LayerInfo[] = [];
  const layerNodes: Record<string, string> = {};
  const varG = f.get('var');
  const nVar = varG ? num((varG.get(indexName(varG)) ?? varG.get('index')).shape[0]) : 0;
  const varFrame = varG ? readFrame(varG, nVar) : { index: [], order: [] as string[], cols: {} as Record<string, ObsCol> };
  const labelCol = pickGeneLabelColumn(varFrame);
  const mainNames = labelCol ? colAsStrings(varFrame.cols[labelCol], nVar) : varFrame.index;

  const addLayer = (name: string, path: string, varNames: string[]) => {
    const node = f.get(path);
    const info = matrixInfo(node);
    if (!info) return;
    if (info.nrow !== n) return;
    if (info.ncol !== varNames.length) return;
    layers.push({ name, varNames, storage: info.storage, looksLikeCounts: sampleLooksLikeCounts(node, info.storage) });
    layerNodes[name] = path;
  };
  if (f.keys().includes('X')) addLayer('X', 'X', mainNames);
  if (f.keys().includes('raw')) {
    const rv = f.get('raw/var');
    if (rv) {
      const rn = num((rv.get(indexName(rv)) ?? rv.get('index')).shape[0]);
      const rf = readFrame(rv, rn);
      const lc = pickGeneLabelColumn(rf);
      addLayer('raw', 'raw/X', lc ? colAsStrings(rf.cols[lc], rn) : rf.index);
    }
  }
  if (f.keys().includes('layers')) {
    for (const k of f.get('layers').keys()) addLayer(`layers/${k}`, `layers/${k}`, mainNames);
  }

  p('Reading embeddings…');
  const embeddings: Embedding[] = [];
  if (f.keys().includes('obsm')) {
    const om = f.get('obsm');
    for (const k of om.keys()) {
      const node = om.get(k);
      if (node?.keys && enc(node) === 'dataframe') {
        // obsm entry stored as a dataframe: stack its numeric columns
        const cols = columnOrder(node).map((c) => readColumn(node, c, n)).filter((c): c is Extract<ObsCol, { kind: 'num' }> => c?.kind === 'num').slice(0, 10);
        if (cols.length >= 2) {
          const data = new Float32Array(n * cols.length);
          cols.forEach((c, j) => { for (let i = 0; i < n; i++) data[i * cols.length + j] = c.values[i]; });
          embeddings.push({ name: k, dim: cols.length, data });
        }
        continue;
      }
      if (!node?.shape || node.shape.length !== 2) continue;
      const [rows, dim] = node.shape as number[];
      if (rows !== n || dim < 2) continue;
      const v = node.value as ArrayLike<number>;
      const data = v instanceof Float32Array ? v : Float32Array.from(v as ArrayLike<number>);
      // cap very wide embeddings (e.g. 50-PC) to the first 10 columns to keep memory sane
      if (dim > 10) {
        const keep = 10, out = new Float32Array(n * keep);
        for (let i = 0; i < n; i++) for (let j = 0; j < keep; j++) out[i * keep + j] = data[i * dim + j];
        embeddings.push({ name: k, dim: keep, data: out });
      } else embeddings.push({ name: k, dim, data });
    }
  }

  const species = guessSpecies(layers[0]?.varNames ?? mainNames);
  const markers = readMarkers(f, obsFrame.order);

  return {
    layerNodes,
    payload: {
      name: o.fileName.replace(/\.h5ad$/i, ''),
      n,
      obsNames: obsFrame.index,
      obsOrder: obsFrame.order,
      obs: obsFrame.cols,
      embeddings,
      layers,
      markers,
      meta: { species, geneLabelCol: labelCol, source: 'h5ad', fileSize: o.fileSize, spatial: readSpatial(f) },
    },
  };
}

export type { Codes };
