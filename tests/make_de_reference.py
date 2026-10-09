"""Reference DE statistics from scipy for the golden_small fixture (group = first category of the first categorical obs column, vs rest)."""
import json, sys, numpy as np, anndata as ad, scipy.sparse as sp
from scipy import stats
a = ad.read_h5ad(sys.argv[1])
col = next(c for c in a.obs.columns if str(a.obs[c].dtype) == 'category' and 3 < a.obs[c].nunique() < 50)
codes = a.obs[col].cat.codes.to_numpy(); k = 2
mask = codes == k
X = a.X.tocsc() if sp.issparse(a.X) else sp.csc_matrix(a.X)
rng = np.random.default_rng(1)
genes = sorted(rng.choice(a.n_vars, 60, replace=False).tolist())
out = []
for g in genes:
    v = X[:, g].toarray().ravel()
    A, B = v[mask], v[~mask]
    if A.std() == 0 and B.std() == 0:
        continue
    u = stats.mannwhitneyu(A, B, alternative='two-sided', use_continuity=False, method='asymptotic')
    n1, n2 = len(A), len(B)
    z = (u.statistic - n1 * n2 / 2) / np.sqrt(n1 * n2 * (n1 + n2 + 1) / 12) if False else stats.norm.isf(u.pvalue / 2) * np.sign(u.statistic - n1 * n2 / 2)
    t = stats.ttest_ind(A, B, equal_var=False)
    out.append({'gene': g, 'z': float(z), 'p': float(u.pvalue), 't': float(t.statistic), 'pt': float(t.pvalue)})
json.dump({'column': col, 'code': k, 'rows': out}, open(sys.argv[2], 'w'))
print('wrote', len(out), 'genes for', col, 'group', k)
