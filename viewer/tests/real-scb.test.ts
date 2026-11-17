// Cross-language check on a real packed file: scbpack (Python) -> viewer reader (TS).
//   SCB=/tmp/full_umap.scb REF=/tmp/scb_ref.json npx vitest run tests/real-scb.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, openSync, readSync, fstatSync, readFileSync } from 'node:fs';
import { readScb, type ByteSource } from '../src/data/scb';
import { pickAnnotation, pickGene, pickEmbedding } from '../src/state/defaults';

const scbPath = process.env.SCB ?? '', refPath = process.env.REF ?? '';

// Same shape an HTTP Range source would take: size + read(offset, length).
function fileSource(path: string): ByteSource {
  const fd = openSync(path, 'r');
  return { size: fstatSync(fd).size, read: (o, l) => { const b = new Uint8Array(l); readSync(fd, b, 0, l, o); return b; } };
}

const havePacked = !!scbPath && !!refPath && existsSync(scbPath) && existsSync(refPath);

describe.skipIf(!havePacked)('.scb from scbpack read by the viewer', () => {
  // Loaded in beforeAll, not at collection time: a skipped suite still evaluates this
  // callback, so reading the fixtures here would fail the run wherever they are absent.
  let ref: any, scb: ReturnType<typeof readScb>, p: ReturnType<typeof readScb>['payload'];
  beforeAll(() => {
    ref = JSON.parse(readFileSync(refPath, 'utf8'));
    scb = readScb(fileSource(scbPath), 'full_umap.scb');
    p = scb.payload;
  });

  it('header: cells, obs columns, embedding', () => {
    expect(p.n).toBe(ref.nCells);
    expect(p.obsOrder.length).toBe(ref.obsCols.length);
    expect(p.obsOrder.slice().sort()).toEqual(ref.obsCols.slice().sort());
    expect(p.embeddings.map((e: any) => e.name)).toContain('X_umap');
    const emb = p.embeddings.find((e: any) => e.name === 'X_umap')!;
    expect(emb.dim).toBe(2);
    for (let i = 0; i < 6; i++) expect(emb.data[i]).toBeCloseTo(ref.umapHead[i], 4);
  });

  it('categorical obs round-trips as labels', () => {
    const col: any = p.obs['Major Cluster'];
    expect(col.kind).toBe('cat');
    for (let i = 0; i < 6; i++) expect(col.categories[col.codes[i]]).toBe(ref.majorClusterHead[i]);
  });

  it('gene columns match the source matrix within the u8 quantisation bound', () => {
    const src = scb.source('X');
    expect(src.nGenes).toBe(ref.nGenes);
    for (const [name, g] of Object.entries<any>(ref.genes)) {
      const col = src.readGene(g.index);
      expect.soft(col.rows.length, `${name} nnz`).toBe(g.nnz);
      expect.soft(Array.from(col.rows.slice(0, 8)), `${name} rows`).toEqual(g.rowsHead);
      expect.soft(Array.from(col.rows.slice(-4)), `${name} rows tail`).toEqual(g.rowsTail);
      const bound = g.max / 510 + 1e-6;              // per-gene u8 scaling: half a step
      for (let i = 0; i < 8; i++)
        expect.soft(Math.abs(col.vals[i] - g.valsHead[i]), `${name} val ${i}`).toBeLessThanOrEqual(bound);
      let mx = 0, sum = 0;
      for (const v of col.vals) { mx = Math.max(mx, v); sum += v; }
      expect.soft(Math.abs(mx - g.max), `${name} max`).toBeLessThanOrEqual(bound);
      expect.soft(Math.abs(sum - g.sum) / g.sum, `${name} sum`).toBeLessThan(1e-3);
    }
  });

  it('opening view recorded by scbpack --default-* is honoured', () => {
    const want = process.env.EXPECT_DEFAULTS ? JSON.parse(process.env.EXPECT_DEFAULTS) : null;
    if (!want) return;                                   // only meaningful for a file packed with defaults
    expect(p.meta.defaults).toBeTruthy();
    if (want.annotation) {
      expect(p.meta.defaults!.annotation).toBe(want.annotation);
      expect(pickAnnotation(p)).toBe(want.annotation);   // overrides the generic heuristic
    }
    if (want.gene) {
      expect(p.meta.defaults!.gene).toBe(want.gene);
      expect(pickGene(p, p.layers[0].varNames)).toBe(want.gene);
    }
    expect(pickEmbedding(p.embeddings, p.meta.defaults?.embedding)?.name).toBe('X_umap');
  });

  it('falls back to the heuristic when a default names something absent', () => {
    const fake = { ...p, meta: { ...p.meta, defaults: { annotation: 'No Such Column', gene: 'NOSUCHGENE' } } };
    expect(pickAnnotation(fake as typeof p)).not.toBe('No Such Column');
    expect(pickAnnotation(fake as typeof p)).toBeTruthy();
    expect(pickGene(fake as typeof p, p.layers[0].varNames)).not.toBe('NOSUCHGENE');
  });

  it('reads a gene with only the bytes that gene needs', () => {
    let bytes = 0;
    const fd = openSync(scbPath, 'r');
    const counting: ByteSource = { size: fstatSync(fd).size,
      read: (o, l) => { bytes += l; const b = new Uint8Array(l); readSync(fd, b, 0, l, o); return b; } };
    const s2 = readScb(counting, 'x.scb');
    const upfront = bytes; bytes = 0;
    s2.source('X').readGene(ref.genes['LHX6'].index);
    process.stdout.write(`RESULT upfront=${(upfront / 1e6).toFixed(2)}MB geneRead=${(bytes / 1e3).toFixed(1)}KB fileSize=${(counting.size / 1e6).toFixed(0)}MB\n`);
    expect(bytes).toBeLessThan(200_000);
    expect(upfront).toBeLessThan(15_000_000);
  });
});
