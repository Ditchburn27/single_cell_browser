"""Rebuild an .h5ad from the supervisor's embedded-JSON viewer (golden fixture).

usage: python3 make_fixture.py <viewer.html> <out_dir>
Writes <out_dir>/golden_full.h5ad (all cells/genes) and golden_small.h5ad (3000 cells x 2000 genes).
"""
import sys, json, numpy as np, pandas as pd, scipy.sparse as sp, anndata as ad

html, out = sys.argv[1], sys.argv[2]
with open(html) as f:
    for line in f:
        if line.startswith('const D='):
            D = json.loads(line.strip()[len('const D='):-1]); break
d = D['datasets'][0]
n = d['n']; genes = list(d['genes'].keys()); G = len(genes)
rows, cols, vals = [], [], []
for j, g in enumerate(genes):
    c, v = d['genes'][g]
    rows.append(np.asarray(c, dtype=np.int32)); cols.append(np.full(len(c), j, dtype=np.int32)); vals.append(np.asarray(v, dtype=np.float32))
X = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, G))
obs = pd.DataFrame({k: v for k, v in d['obs'].items() if any(x is not None for x in v)})  # drop all-null columns
obs.index = obs['Cell_name'].astype(str).values; obs.index.name = None
for k in obs.columns:
    if obs[k].dtype == object: obs[k] = obs[k].astype('category')
var = pd.DataFrame(index=pd.Index(genes))
a = ad.AnnData(X=X, obs=obs, var=var)
a.obsm['X_umap'] = np.column_stack([d['xs'], d['ys']]).astype(np.float32)
# markers -> uns rank_genes_groups style
mk = {k.strip(): v for k, v in d['markers'].items()}
groups = list(mk.keys()); L = max(len(v) for v in mk.values())
def rec(idx, dt): return np.rec.fromarrays([np.array([(mk[g][i][idx] if i < len(mk[g]) and mk[g][i][idx] is not None else (0 if dt != 'U50' else '')) for i in range(L)], dtype=dt) for g in groups], names=groups)
groups_ = groups
a.uns['rank_genes_groups'] = {'params': {'groupby': next((c for c in obs.columns if set(obs[c].astype(str)) >= set(groups)), obs.columns[0])}, 'names': rec(0, 'U50'), 'scores': rec(1, 'f4'), 'logfoldchanges': rec(2, 'f4'), 'pvals_adj': rec(3, 'f4')}
a.write_h5ad(out + '/golden_full.h5ad')
rng = np.random.default_rng(0)
ci = np.sort(rng.choice(n, 3000, replace=False)); gi = np.sort(rng.choice(G, 2000, replace=False))
s = a[ci, gi].copy(); s.write_h5ad(out + '/golden_small.h5ad', compression='gzip')
print('ok', a.shape, s.shape)
