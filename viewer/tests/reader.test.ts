import { describe, it, expect } from 'vitest';
import * as h5wasm from 'h5wasm/node';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readH5adMeta } from '../src/data/h5ad-reader';
import { openSource } from '../src/data/gene-source';
import { denseGene, groupStats, de } from '../src/data/compute';

const small = resolve(__dirname, '../../tests/fixtures/golden_small.h5ad');
const full = resolve(__dirname, '../../tests/fixtures/golden_full.h5ad');

describe.skipIf(!existsSync(small))('h5ad reader (small fixture)', () => {
  it('reads structure generically', async () => {
    await h5wasm.ready;
    const f = new h5wasm.File(small, 'r');
    const r = readH5adMeta(f, { fileName: 'x.h5ad', fileSize: 1 });
    const p = r.payload;
    expect(p.n).toBe(3000);
    expect(p.embeddings.length).toBeGreaterThan(0);
    expect(p.layers[0].varNames.length).toBe(2000);
    expect(p.layers[0].storage).toBe('csr');
    const cats = Object.values(p.obs).filter((c) => c.kind === 'cat');
    expect(cats.length).toBeGreaterThan(3);
    expect(p.markers && Object.keys(p.markers.groups).length).toBeGreaterThan(0);
    expect(p.markers!.groupby).not.toBeNull();
    f.close();
  });

  it('CSR→CSC matches a dense reference for every gene column', async () => {
    await h5wasm.ready;
    const f = new h5wasm.File(small, 'r');
    const r = readH5adMeta(f, { fileName: 'x.h5ad', fileSize: 1 });
    const node = f.get('X');
    const src = openSource(node, 'csr', r.payload.n, 2000);
    // reference: row-wise scatter
    const indptr = Array.from(node.get('indptr').value as ArrayLike<number>, Number);
    const ind = node.get('indices').value as ArrayLike<number>, dat = node.get('data').value as ArrayLike<number>;
    const ref = new Float32Array(3000 * 2000);
    for (let row = 0; row < 3000; row++) for (let k = indptr[row]; k < indptr[row + 1]; k++) ref[row * 2000 + ind[k]] = dat[k];
    const comp = { src, totals: null, transform: 'none' as const };
    for (const g of [0, 1, 777, 1999]) {
      const v = denseGene(comp, g);
      for (let row = 0; row < 3000; row++) expect(v[row]).toBe(ref[row * 2000 + g]);
    }
    f.close();
  });

  it('group stats and DE are sane', async () => {
    await h5wasm.ready;
    const f = new h5wasm.File(small, 'r');
    const r = readH5adMeta(f, { fileName: 'x.h5ad', fileSize: 1 });
    const src = openSource(f.get('X'), 'csr', 3000, 2000);
    const comp = { src, totals: null, transform: 'none' as const };
    const col = Object.values(r.payload.obs).find((c) => c.kind === 'cat' && c.categories.length > 2 && c.categories.length < 50)!;
    if (col.kind !== 'cat') throw new Error();
    const gs = groupStats(comp, [0, 1], col.codes, col.categories.length);
    expect(gs.mean.length).toBe(2 * col.categories.length);
    const maskA = new Uint8Array(3000);
    for (let i = 0; i < 3000; i++) maskA[i] = col.codes[i] === 0 ? 1 : 0;
    const res = de(comp, maskA, null);
    expect(res.padjW.every((p) => p >= 0 && p <= 1)).toBe(true);
    // genes with the smallest p-value should have non-trivial effect
    const best = Array.from(res.pW.keys()).sort((a, b) => res.pW[a] - res.pW[b])[0];
    expect(Math.abs(res.z[best])).toBeGreaterThan(3);
    f.close();
  });
});

describe.skipIf(!existsSync(full))('full fixture', () => {
  it('transposes 26.7M nnz quickly', async () => {
    await h5wasm.ready;
    const f = new h5wasm.File(full, 'r');
    const r = readH5adMeta(f, { fileName: 'full.h5ad', fileSize: 1 });
    expect(r.payload.n).toBe(19414);
    const t0 = performance.now();
    const src = openSource(f.get('X'), 'csr', r.payload.n, r.payload.layers[0].varNames.length);
    expect(performance.now() - t0).toBeLessThan(20000);
    expect(src.readGene(0).rows.length).toBeGreaterThanOrEqual(0);
    f.close();
  });
});

import { readFileSync } from 'node:fs';
const refPath = resolve(__dirname, '../../tests/fixtures/de_ref.json');
describe.skipIf(!existsSync(refPath) || !existsSync(small))('DE matches scipy', () => {
  it('Wilcoxon z / p and Welch t agree with scipy.stats', async () => {
    await h5wasm.ready;
    const ref = JSON.parse(readFileSync(refPath, 'utf8')) as { column: string; code: number; rows: { gene: number; z: number; p: number; t: number; pt: number }[] };
    const f = new h5wasm.File(small, 'r');
    const r = readH5adMeta(f, { fileName: 'x.h5ad', fileSize: 1 });
    const col = r.payload.obs[ref.column];
    if (col.kind !== 'cat') throw new Error('expected categorical');
    const src = openSource(f.get('X'), 'csr', 3000, 2000);
    const mask = new Uint8Array(3000);
    for (let i = 0; i < 3000; i++) mask[i] = col.codes[i] === ref.code ? 1 : 0;
    const res = de({ src, totals: null, transform: 'none' }, mask, null);
    for (const row of ref.rows) {
      expect(res.z[row.gene]).toBeCloseTo(row.z, 2);
      expect(res.t[row.gene]).toBeCloseTo(row.t, 2);
      // p-values via a 1e-7-accurate erfc: compare in absolute terms
      expect(Math.abs(res.pW[row.gene] - row.p)).toBeLessThan(1e-5);
    }
    f.close();
  });
});
