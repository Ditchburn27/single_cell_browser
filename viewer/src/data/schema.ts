// Shared, structured-clone-friendly dataset schema. Both the .h5ad and .scb loaders produce this.

export type Codes = Int16Array | Int32Array; // -1 = missing

export interface CatCol {
  kind: 'cat';
  codes: Codes;
  categories: string[];
  colors?: string[]; // from uns[<col>_colors]
}
export interface NumCol {
  kind: 'num';
  values: Float32Array; // NaN = missing
}
export interface StrCol {
  kind: 'str'; // high-cardinality text (barcodes, free-text notes): tooltip/search only
  values: string[];
}
export type ObsCol = CatCol | NumCol | StrCol;

export interface Embedding {
  name: string; // e.g. X_umap
  dim: number; // columns
  data: Float32Array; // row-major n x dim
}

export interface LayerInfo {
  name: string; // 'X' | 'raw' | layers/<name>
  varNames: string[];
  storage: 'csr' | 'csc' | 'dense';
  looksLikeCounts: boolean; // integer-valued sample → offer normalise
}

export interface MarkerRow {
  gene: string;
  score: number | null;
  lfc: number | null;
  padj: number | null;
}
export interface Markers {
  groupby: string | null;
  groups: Record<string, MarkerRow[]>;
}

export interface SpatialInfo {
  library: string;
  imageKey: string;
  scale: number; // spot→image pixel factor
  spotDiameter: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray | null;
}

export interface DatasetMeta {
  species: 'mouse' | 'human' | 'unknown';
  geneLabelCol: string | null;
  source: 'h5ad' | 'scb';
  fileSize: number;
  spatial: SpatialInfo | null;
}

export interface DatasetPayload {
  name: string;
  n: number;
  obsNames: string[];
  obsOrder: string[];
  obs: Record<string, ObsCol>;
  embeddings: Embedding[];
  layers: LayerInfo[];
  markers: Markers | null;
  meta: DatasetMeta;
}

export const isCat = (c: ObsCol | undefined): c is CatCol => !!c && c.kind === 'cat';
export const isNum = (c: ObsCol | undefined): c is NumCol => !!c && c.kind === 'num';

export function makeCodes(n: number, ncat: number): Codes {
  return ncat < 32000 ? new Int16Array(n) : new Int32Array(n);
}

/** Build a categorical column from arbitrary values, ordering categories by `sort`. */
export function catFromValues(vals: ArrayLike<string | number | null | undefined>, sort: 'natural' | 'first' = 'natural'): CatCol {
  const n = vals.length;
  const seen = new Map<string, number>();
  const order: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) continue;
    const s = String(v);
    if (!seen.has(s)) { seen.set(s, 0); order.push(s); }
  }
  if (sort === 'natural') order.sort(naturalCompare);
  order.forEach((s, i) => seen.set(s, i));
  const codes = makeCodes(n, order.length);
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    codes[i] = v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? -1 : seen.get(String(v))!;
  }
  return { kind: 'cat', codes, categories: order };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function naturalCompare(a: string, b: string): number { return collator.compare(a, b); }
