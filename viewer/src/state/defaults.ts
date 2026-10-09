// Pick sensible defaults from whatever is in the file. No dataset-specific names: only generic heuristics.
import { isCat, type DatasetPayload, type Embedding } from '../data/schema';

const ANNOT_HINT = /cell[\s_.-]*(type|class|ident|label|annot)|annot|celltype|cluster|leiden|louvain|identity|label|population|subclass|class/i;
const TECH_HINT = /batch|sample|donor|patient|plate|lane|barcode|well|library|run|date|id$|^id|_id|index|doublet|phase|n_|total_|pct_|percent|mito|ribo/i;

export function scoreAnnotation(ds: DatasetPayload, key: string): number {
  const c = ds.obs[key];
  if (!isCat(c)) return -1e9;
  const k = c.categories.length;
  if (k < 2) return -100;
  let s = 0;
  if (k >= 4 && k <= 60) s += 4; else if (k <= 120) s += 2; else s -= (k / 100);
  if (ANNOT_HINT.test(key)) s += 5;
  if (TECH_HINT.test(key)) s -= 4;
  if (ds.markers?.groupby === key) s += 10;
  if (k > ds.n * 0.5) s -= 20;
  return s;
}

export function pickAnnotation(ds: DatasetPayload): string | null {
  let best: string | null = null, bs = -Infinity;
  for (const k of ds.obsOrder) { const s = scoreAnnotation(ds, k); if (s > bs) { bs = s; best = k; } }
  return bs > -50 ? best : null;
}

export function pickEmbedding(list: Embedding[]): Embedding | null {
  if (!list.length) return null;
  const order = [/umap/i, /tsne|t-sne/i, /spatial/i, /phate|draw_graph|fa$/i, /pca/i];
  for (const re of order) { const e = list.find((x) => re.test(x.name)); if (e) return e; }
  return list[0];
}

export function pickGene(ds: DatasetPayload, varNames: string[]): string | null {
  const g = ds.markers && Object.values(ds.markers.groups).find((rows) => rows.length)?.[0]?.gene;
  if (g && varNames.includes(g)) return g;
  return varNames[0] ?? null;
}
