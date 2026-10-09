"""Synthetic Visium-like AnnData: spots on a hex-ish grid over a tissue picture, with regional gene programs."""
import sys, numpy as np, pandas as pd, scipy.sparse as sp, anndata as ad
out = sys.argv[1]
rng = np.random.default_rng(3)
nx, ny, step = 60, 50, 150.0
xs, ys = np.meshgrid(np.arange(nx), np.arange(ny))
x = (xs + (ys % 2) * 0.5) * step + 300; y = ys * step * 0.87 + 300
x, y = x.ravel(), y.ravel(); n = len(x)
cx, cy = x.mean(), y.mean()
r = np.hypot(x - cx, y - cy) / np.hypot(x.max() - cx, y.max() - cy)
region = np.where(r < 0.35, 'core', np.where(r < 0.7, 'middle', 'rim'))
G = 300
genes = ['gene%03d' % i for i in range(G)]
base = rng.gamma(0.3, 1.0, (n, G))
for k, reg in enumerate(['core', 'middle', 'rim']):
    m = region == reg
    base[np.ix_(m, np.arange(k * 20, k * 20 + 20))] += rng.gamma(4, 1.0, (m.sum(), 20))
X = sp.csr_matrix(np.log1p(base * (rng.random((n, G)) < 0.5)).astype('float32'))
obs = pd.DataFrame({'region': pd.Categorical(region), 'total_signal': np.asarray(X.sum(axis=1)).ravel()}, index=['spot%05d' % i for i in range(n)])
a = ad.AnnData(X=X, obs=obs, var=pd.DataFrame(index=genes))
a.obsm['spatial'] = np.column_stack([x, y]).astype('float32')
a.obsm['X_pca'] = rng.normal(size=(n, 10)).astype('float32')
H = W = 800; scalef = 0.2
yy, xx = np.mgrid[0:H, 0:W]
img = np.zeros((H, W, 3), dtype='u1'); d = np.hypot(xx - W / 2, yy - H / 2) / (W / 2)
img[..., 0] = np.clip(240 - 120 * d, 0, 255); img[..., 1] = np.clip(200 - 90 * d, 0, 255); img[..., 2] = np.clip(215 - 40 * d, 0, 255)
a.uns['spatial'] = {'libA': {'images': {'hires': img}, 'scalefactors': {'tissue_hires_scalef': scalef, 'spot_diameter_fullres': 120.0}}}
a.write_h5ad(out)
print('ok', a.shape)
