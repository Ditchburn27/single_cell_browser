// Per-layer gene access. Every source exposes sparse columns (cells with non-zero values for a gene).
// Heavy computations (group stats, DE, gene-set scores) live in compute.ts and work on any GeneSource.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type H5 = any;

export interface SparseCol { rows: Uint32Array | Int32Array; vals: Float32Array }

export interface GeneSource {
  nCells: number;
  nGenes: number;
  readGene(g: number): SparseCol;
}

/** In-memory CSC. */
export class CscSource implements GeneSource {
  constructor(public nCells: number, public nGenes: number, private indptr: Uint32Array | Float64Array,
              private rows: Uint32Array, private vals: Float32Array) {}
  readGene(g: number): SparseCol {
    const a = this.indptr[g], b = this.indptr[g + 1];
    return { rows: this.rows.subarray(a, b), vals: this.vals.subarray(a, b) };
  }
}

/** CSC stored on disk: slice indptr/indices/data per requested gene (cached). */
export class DiskCscSource implements GeneSource {
  private indptr: Float64Array;
  private cache = new Map<number, SparseCol>();
  constructor(public nCells: number, public nGenes: number, private node: H5) {
    this.indptr = Float64Array.from(node.get('indptr').value as ArrayLike<number | bigint>, Number);
  }
  readGene(g: number): SparseCol {
    const hit = this.cache.get(g);
    if (hit) { this.cache.delete(g); this.cache.set(g, hit); return hit; }
    const a = this.indptr[g], b = this.indptr[g + 1];
    let col: SparseCol;
    if (b <= a) col = { rows: new Uint32Array(0), vals: new Float32Array(0) };
    else {
      const r = this.node.get('indices').slice([[a, b]]);
      const v = this.node.get('data').slice([[a, b]]);
      col = { rows: Uint32Array.from(r as ArrayLike<number>), vals: Float32Array.from(v as ArrayLike<number>) };
    }
    this.cache.set(g, col);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value as number);
    return col;
  }
}

/** Dense matrix on disk: read one column hyperslab. */
export class DenseSource implements GeneSource {
  constructor(public nCells: number, public nGenes: number, private node: H5) {}
  readGene(g: number): SparseCol {
    const v = this.node.slice([[0, this.nCells], [g, g + 1]]) as ArrayLike<number>;
    let nz = 0;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) nz++;
    const rows = new Uint32Array(nz), vals = new Float32Array(nz);
    let k = 0;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) { rows[k] = i; vals[k] = v[i]; k++; }
    return { rows, vals };
  }
}

export const DEFAULT_BUDGET_BYTES = 1.5e9;

export class TooBigError extends Error {
  constructor(public nnz: number, public bytes: number) {
    super(`This matrix has ${(nnz / 1e6).toFixed(0)}M non-zero values (~${(bytes / 1e9).toFixed(1)} GB in memory), which is more than the browser can hold. ` +
      `Pack it first:  scbpack in.h5ad -o out.scb --genes hvg:5000   (then open the .scb file).`);
  }
}

/** Transpose an on-disk CSR matrix to an in-memory CSC (two block-streamed passes). */
export function csrToCsc(node: H5, nRows: number, nCols: number, budget = DEFAULT_BUDGET_BYTES,
                         onProgress?: (frac: number) => void): CscSource {
  const dataset = node.get('data');
  const nnz = Number(dataset.shape[0]);
  if (nnz * 8 > budget) throw new TooBigError(nnz, nnz * 8);
  const ind = node.get('indices');
  const ptr = Float64Array.from(node.get('indptr').value as ArrayLike<number | bigint>, Number);
  const B = 8_000_000;
  const counts = new Uint32Array(nCols + 1);
  for (let s = 0; s < nnz; s += B) {
    const a = ind.slice([[s, Math.min(nnz, s + B)]]) as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) counts[a[i] + 1]++;
    onProgress?.(0.5 * Math.min(1, (s + B) / nnz));
  }
  for (let i = 0; i < nCols; i++) counts[i + 1] += counts[i];
  const rows = new Uint32Array(nnz), vals = new Float32Array(nnz);
  const pos = counts.slice(0, nCols);
  let r = 0;
  for (let s = 0; s < nnz; s += B) {
    const e = Math.min(nnz, s + B);
    const a = ind.slice([[s, e]]) as ArrayLike<number>, v = dataset.slice([[s, e]]) as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) {
      const k = s + i;
      while (ptr[r + 1] <= k) r++;
      const p = pos[a[i]]++;
      rows[p] = r; vals[p] = v[i];
    }
    onProgress?.(0.5 + 0.5 * Math.min(1, e / nnz));
  }
  return new CscSource(nRows, nCols, counts, rows, vals);
}

/** Build the right GeneSource for a layer node. */
export function openSource(node: H5, storage: 'csr' | 'csc' | 'dense', nCells: number, nGenes: number,
                           onProgress?: (frac: number) => void): GeneSource {
  if (storage === 'csc') return new DiskCscSource(nCells, nGenes, node);
  if (storage === 'dense') return new DenseSource(nCells, nGenes, node);
  return csrToCsc(node, nCells, nGenes, DEFAULT_BUDGET_BYTES, onProgress);
}
