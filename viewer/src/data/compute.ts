// Expression computations on any GeneSource. Pure functions, no DOM.
import type { GeneSource } from './gene-source';

export type Transform = 'none' | 'log1p-cp10k';

export interface Computer {
  src: GeneSource;
  /** per-cell total (sum over all genes), required for the log1p-cp10k transform */
  totals: Float32Array | null;
  transform: Transform;
}

export function computeTotals(src: GeneSource, onProgress?: (f: number) => void): Float32Array {
  const t = new Float32Array(src.nCells);
  for (let g = 0; g < src.nGenes; g++) {
    const { rows, vals } = src.readGene(g);
    for (let i = 0; i < rows.length; i++) t[rows[i]] += vals[i];
    if (onProgress && (g & 1023) === 0) onProgress(g / src.nGenes);
  }
  return t;
}

function tv(c: Computer, row: number, v: number): number {
  if (c.transform === 'none' || !c.totals) return v;
  const t = c.totals[row] || 1;
  return Math.log1p((v / t) * 1e4);
}

export function denseGene(c: Computer, g: number): Float32Array {
  const out = new Float32Array(c.src.nCells);
  const { rows, vals } = c.src.readGene(g);
  for (let i = 0; i < rows.length; i++) out[rows[i]] = tv(c, rows[i], vals[i]);
  return out;
}

export function geneSetScore(c: Computer, genes: number[]): Float32Array {
  const out = new Float32Array(c.src.nCells);
  if (!genes.length) return out;
  for (const g of genes) {
    const { rows, vals } = c.src.readGene(g);
    for (let i = 0; i < rows.length; i++) out[rows[i]] += tv(c, rows[i], vals[i]);
  }
  for (let i = 0; i < out.length; i++) out[i] /= genes.length;
  return out;
}

/** mean expression and fraction expressing, per gene x group. codes: -1 = ignore. Result index = gi*nGroups + group. */
export function groupStats(c: Computer, genes: number[], codes: ArrayLike<number>, nGroups: number) {
  const sizes = new Float64Array(nGroups);
  for (let i = 0; i < codes.length; i++) if (codes[i] >= 0) sizes[codes[i]]++;
  const mean = new Float32Array(genes.length * nGroups), pct = new Float32Array(genes.length * nGroups);
  genes.forEach((g, gi) => {
    const { rows, vals } = c.src.readGene(g);
    const base = gi * nGroups;
    for (let i = 0; i < rows.length; i++) {
      const k = codes[rows[i]];
      if (k < 0) continue;
      const v = tv(c, rows[i], vals[i]);
      mean[base + k] += v;
      if (v > 0) pct[base + k]++;
    }
    for (let k = 0; k < nGroups; k++) {
      const s = sizes[k] || 1;
      mean[base + k] /= s; pct[base + k] /= s;
    }
  });
  return { mean, pct, sizes: Float32Array.from(sizes) };
}

export interface DeResult {
  gene: Int32Array;
  meanA: Float32Array; meanB: Float32Array;
  pctA: Float32Array; pctB: Float32Array;
  lfc: Float32Array; // log2 fold change of means (expm1 scale), as in common practice
  t: Float32Array;
  pT: Float32Array; // two-sided Welch p
  z: Float32Array; // Wilcoxon z
  pW: Float32Array; // two-sided Wilcoxon p (normal approx, tie-corrected)
  padjW: Float32Array; // Benjamini–Hochberg on pW
  nA: number; nB: number;
}

function erfc(x: number): number {
  // Numerical Recipes erfcc, fractional error < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const pNormTwoSided = (z: number) => erfc(Math.abs(z) / Math.SQRT2);

/** Differential expression A vs B (B = everything else when maskB is null). */
export function de(c: Computer, maskA: Uint8Array, maskB: Uint8Array | null, onProgress?: (f: number) => void): DeResult {
  const n = c.src.nCells, G = c.src.nGenes;
  let nA = 0, nB = 0;
  const inB = (i: number) => (maskB ? maskB[i] === 1 : maskA[i] === 0);
  for (let i = 0; i < n; i++) { if (maskA[i]) nA++; else if (!maskB || maskB[i]) nB++; }
  if (maskB) { nB = 0; for (let i = 0; i < n; i++) if (maskB[i] && !maskA[i]) nB++; }
  const out: DeResult = {
    gene: new Int32Array(G), meanA: new Float32Array(G), meanB: new Float32Array(G), pctA: new Float32Array(G), pctB: new Float32Array(G),
    lfc: new Float32Array(G), t: new Float32Array(G), pT: new Float32Array(G), z: new Float32Array(G), pW: new Float32Array(G),
    padjW: new Float32Array(G), nA, nB,
  };
  if (nA < 2 || nB < 2) throw new Error('Need at least 2 cells in each group.');
  const scratchA = new Float64Array(nA), scratchB = new Float64Array(nB);
  for (let g = 0; g < G; g++) {
    out.gene[g] = g;
    const { rows, vals } = c.src.readGene(g);
    let kA = 0, kB = 0, sA = 0, sB = 0, qA = 0, qB = 0, expA = 0, expB = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], v = tv(c, r, vals[i]);
      if (maskA[r]) { if (v > 0) scratchA[kA++] = v; sA += v; qA += v * v; expA += Math.expm1(v); }
      else if (inB(r)) { if (v > 0) scratchB[kB++] = v; sB += v; qB += v * v; expB += Math.expm1(v); }
    }
    const mA = sA / nA, mB = sB / nB;
    const vA = Math.max(0, (qA - nA * mA * mA) / (nA - 1)), vB = Math.max(0, (qB - nB * mB * mB) / (nB - 1));
    out.meanA[g] = mA; out.meanB[g] = mB;
    out.pctA[g] = kA / nA; out.pctB[g] = kB / nB;
    out.lfc[g] = Math.log2((expA / nA + 1e-3) / (expB / nB + 1e-3));
    const se = Math.sqrt(vA / nA + vB / nB);
    const t = se > 0 ? (mA - mB) / se : 0;
    out.t[g] = t; out.pT[g] = pNormTwoSided(t);
    // Wilcoxon rank-sum on sparse data: all zeros are tied below every positive value
    const a = scratchA.subarray(0, kA).sort(), b = scratchB.subarray(0, kB).sort();
    const zerosA = nA - kA, zerosB = nB - kB, zeros = zerosA + zerosB, nTot = nA + nB;
    let rankSumA = zerosA * ((zeros + 1) / 2);
    let tieTerm = zeros > 1 ? zeros ** 3 - zeros : 0;
    let i = 0, j = 0, below = zeros;
    while (i < kA || j < kB) {
      const v = Math.min(i < kA ? a[i] : Infinity, j < kB ? b[j] : Infinity);
      let ca = 0, cb = 0;
      while (i < kA && a[i] === v) { i++; ca++; }
      while (j < kB && b[j] === v) { j++; cb++; }
      const cnt = ca + cb;
      rankSumA += ca * (below + (cnt + 1) / 2);
      below += cnt;
      if (cnt > 1) tieTerm += cnt ** 3 - cnt;
    }
    const expected = (nA * (nTot + 1)) / 2;
    const varU = ((nA * nB) / 12) * (nTot + 1 - tieTerm / (nTot * (nTot - 1)));
    const z = varU > 0 ? (rankSumA - expected) / Math.sqrt(varU) : 0;
    out.z[g] = z; out.pW[g] = pNormTwoSided(z);
    if (onProgress && (g & 255) === 0) onProgress(g / G);
  }
  // Benjamini–Hochberg
  const order = Array.from({ length: G }, (_, i) => i).sort((a, b) => out.pW[a] - out.pW[b]);
  let prev = 1;
  for (let r = G - 1; r >= 0; r--) {
    const gi = order[r];
    prev = Math.min(prev, (out.pW[gi] * G) / (r + 1));
    out.padjW[gi] = prev;
  }
  return out;
}
