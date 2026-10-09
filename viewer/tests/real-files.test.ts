// Opt-in smoke test over arbitrary local .h5ad files:  FILES=a.h5ad,b.h5ad npx vitest run tests/real-files.test.ts
import { it } from 'vitest';
import * as h5wasm from 'h5wasm/node';
import { readH5adMeta } from '../src/data/h5ad-reader';
import { pickAnnotation, pickEmbedding } from '../src/state/defaults';

const files = (process.env.FILES ?? '').split(',').filter(Boolean);
if (!files.length) it.skip('set FILES=a.h5ad,b.h5ad to run', () => {});
const say = (o: unknown) => process.stdout.write('RESULT ' + JSON.stringify(o) + '\n');

for (const path of files) {
  it('summarise ' + path.split('/').pop(), async () => {
    await h5wasm.ready;
    const t0 = performance.now();
    const f = new h5wasm.File(path, 'r');
    try {
      const p = readH5adMeta(f, { fileName: path.split('/').pop()!, fileSize: 0 }).payload;
      say({
        file: p.name, ms: Math.round(performance.now() - t0), n: p.n, obs: p.obsOrder.length,
        kinds: p.obsOrder.reduce((a: Record<string, number>, k) => ((a[p.obs[k].kind] = (a[p.obs[k].kind] ?? 0) + 1), a), {}),
        layers: p.layers.map((l) => `${l.name}:${l.storage}:${l.varNames.length}:counts=${l.looksLikeCounts}`),
        emb: p.embeddings.map((e) => `${e.name}[${e.dim}]`), pickEmb: pickEmbedding(p.embeddings)?.name ?? null,
        pickAnn: pickAnnotation(p), markers: p.markers ? Object.keys(p.markers.groups).length : 0, species: p.meta.species,
      });
    } catch (e) { say({ file: path.split('/').pop(), error: (e as Error).message }); }
    f.close();
  }, 600000);
}
