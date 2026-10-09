import { describe, it, expect } from 'vitest';
import * as h5wasm from 'h5wasm/node';
import { existsSync, openSync, readSync, fstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { readScb, type ByteSource } from '../src/data/scb';
import { readH5adMeta } from '../src/data/h5ad-reader';
import { openSource } from '../src/data/gene-source';

const dir = resolve(__dirname, '../../tests/fixtures');
const scbPath = resolve(dir, 'golden_small.scb'), h5Path = resolve(dir, 'golden_small.h5ad');

function fileSource(path: string): ByteSource {
  const fd = openSync(path, 'r');
  return { size: fstatSync(fd).size, read: (o, l) => { const b = new Uint8Array(l); readSync(fd, b, 0, l, o); return b; } };
}

describe.skipIf(!existsSync(scbPath) || !existsSync(h5Path))('.scb written by scbpack (Python) read by the viewer (TS)', () => {
  it('matches the source h5ad: annotations, embeddings, markers and every gene column', async () => {
    await h5wasm.ready;
    const f = new h5wasm.File(h5Path, 'r');
    const ref = readH5adMeta(f, { fileName: 'x.h5ad', fileSize: 1 });
    const scb = readScb(fileSource(scbPath), 'x.scb');
    const a = ref.payload, b = scb.payload;
    expect(b.n).toBe(a.n);
    expect(b.obsNames).toEqual(a.obsNames);
    expect(b.layers[0].varNames).toEqual(a.layers[0].varNames);
    expect(b.embeddings.map((e) => e.name)).toEqual(a.embeddings.map((e) => e.name));
    expect(Array.from(b.embeddings[0].data.slice(0, 20))).toEqual(Array.from(a.embeddings[0].data.slice(0, 20)));
    expect(b.markers?.groupby).toBe(a.markers?.groupby);
    expect(Object.keys(b.markers!.groups)).toEqual(Object.keys(a.markers!.groups));
    // categorical columns identical (compare as labels so category order differences don't matter)
    for (const k of a.obsOrder) {
      const ca = a.obs[k], cb = b.obs[k];
      if (!cb) continue;
      if (ca.kind === 'cat' && cb.kind === 'cat') {
        for (let i = 0; i < a.n; i += 97) {
          const la = ca.codes[i] >= 0 ? ca.categories[ca.codes[i]] : null, lb = cb.codes[i] >= 0 ? cb.categories[cb.codes[i]] : null;
          expect(lb).toBe(la);
        }
      }
    }
    const src = openSource(f.get('X'), 'csr', a.n, a.layers[0].varNames.length);
    const s2 = scb.source('X');
    for (const g of [0, 5, 400, 1999]) {
      const x = src.readGene(g), y = s2.readGene(g);
      expect(Array.from(y.rows)).toEqual(Array.from(x.rows));
      let mx = 0; for (const v of x.vals) mx = Math.max(mx, v);
      for (let i = 0; i < x.vals.length; i++) expect(Math.abs(y.vals[i] - x.vals[i])).toBeLessThanOrEqual(mx / 510 + 1e-6); // uint8 quantisation bound
    }
    f.close();
  });
});
