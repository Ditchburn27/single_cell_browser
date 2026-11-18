"""Python-side checks:  python3 -m pytest tests/test_scbpack.py  (or run directly)."""
import json, os, subprocess, sys, tempfile
import numpy as np, pandas as pd, anndata as ad
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'packer'))
from scbpack.writer import pack  # noqa: E402
from scbpack.annotations import apply_annotations  # noqa: E402

SMALL = os.path.join(ROOT, 'tests/fixtures/golden_small.h5ad')


def test_pack_subset_and_footer():
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, 'x.scb')
        pack(SMALL, out, genes='hvg:100', max_cells=500)
        raw = open(out, 'rb').read()
        assert raw[-4:] == b'SCB1'
        hl = int.from_bytes(raw[-12:-4], 'little')
        header = json.loads(raw[-12 - hl:-12])
        assert header['n'] == 500 and header['layers'][0]['nGenes'] >= 100


def test_annotation_roundtrip():
    a = ad.read_h5ad(SMALL)
    labels = ['a' if i % 2 else 'b' for i in range(a.n_obs)]
    payload = {'app': 'anndata-browser', 'version': 1, 'dataset': 'x', 'cell_ids': list(a.obs_names),
               'columns': {'my_sel': {'categories': ['a', 'b'], 'labels': labels}}}
    with tempfile.TemporaryDirectory() as d:
        j, o = os.path.join(d, 'a.json'), os.path.join(d, 'o.h5ad')
        json.dump(payload, open(j, 'w'))
        apply_annotations(j, SMALL, o)
        b = ad.read_h5ad(o)
        assert list(b.obs['my_sel']) == labels


if __name__ == '__main__':
    test_pack_subset_and_footer(); test_annotation_roundtrip(); print('ok')


def test_marker_wilcoxon_matches_scipy():
    """One-vs-rest z and log fold change agree with scipy's tie-corrected Mann-Whitney."""
    import scipy.sparse as sp
    from scipy.stats import mannwhitneyu
    from scbpack.writer import _MarkerAccum

    rng = np.random.default_rng(0)
    n, G, K = 300, 25, 3
    codes = rng.integers(0, K, n)
    M = sp.random(n, G, density=0.25, format='csc', random_state=1)
    M.data = np.round(M.data * 6, 2)          # force ties
    M.eliminate_zeros(); M.sort_indices()

    acc = _MarkerAccum(codes, K, G)
    for j in range(G):
        a, b = M.indptr[j], M.indptr[j + 1]
        acc.add(M.indices[a:b], M.data[a:b])

    D = np.asarray(M.todense())
    for j in range(G):
        v = D[:, j]
        _, cnt = np.unique(v, return_counts=True)
        tie = float(np.sum(cnt.astype(float) ** 3 - cnt))
        for k in range(K):
            A, B = v[codes == k], v[codes != k]
            U, _ = mannwhitneyu(A, B, use_continuity=False, method='asymptotic')
            nA, nB = len(A), len(B)
            sd = np.sqrt(nA * nB / 12.0 * ((n + 1) - tie / (n * (n - 1.0))))
            assert abs((U - nA * nB / 2.0) / sd - acc.z[j, k]) < 1e-4
            eA, eB = np.expm1(A).mean(), np.expm1(B).mean()
            assert abs(np.log2((eA + 1e-3) / (eB + 1e-3)) - acc.lfc[j, k]) < 1e-4


def test_pack_computes_markers():
    """--markers stores ranked genes per group, and the planted gene tops its group."""
    import scipy.sparse as sp
    rng = np.random.default_rng(1)
    n, G = 240, 40
    groups = np.array(['g%d' % (i % 3) for i in range(n)])
    X = rng.random((n, G)).astype('float32') * 0.4
    X[groups == 'g1', 7] += 6.0                       # gene 7 marks group g1
    a = ad.AnnData(sp.csr_matrix(X))
    a.obs['grp'] = groups
    a.obs['grp'] = a.obs['grp'].astype('category')
    a.var_names = ['G%d' % i for i in range(G)]
    a.obsm['X_umap'] = rng.random((n, 2)).astype('float32')
    with tempfile.TemporaryDirectory() as d:
        src, out = os.path.join(d, 'in.h5ad'), os.path.join(d, 'out.scb')
        a.write_h5ad(src)
        pack(src, out, markers='grp', markers_top=5)
        raw = open(out, 'rb').read()
        hl = int.from_bytes(raw[-12:-4], 'little')
        m = json.loads(raw[-12 - hl:-12])['markers']
        assert m['groupby'] == 'grp'
        assert set(m['groups']) == {'g0', 'g1', 'g2'}
        assert all(len(v) <= 5 for v in m['groups'].values())
        assert m['groups']['g1'][0]['gene'] == 'G7'
        assert m['groups']['g1'][0]['lfc'] > 0 and m['groups']['g1'][0]['padj'] < 0.01


def _ordered_fixture(d, uns_key='stage_plot_order', order=('Fetal', 'Neonatal', 'Adult'),
                     colors=None):
    """Small object whose category order lives in uns, not in the categorical."""
    import scipy.sparse as sp
    rng = np.random.default_rng(3)
    n = 60
    labels = np.array(['Fetal', 'Neonatal', 'Adult'] * (n // 3))
    a = ad.AnnData(sp.csr_matrix(rng.random((n, 12)).astype('float32')))
    a.obs['stage'] = pd.Categorical(labels)          # pandas sorts these alphabetically
    a.obsm['X_umap'] = rng.random((n, 2)).astype('float32')
    a.uns[uns_key] = list(order)
    if colors is not None:
        a.uns['stage_colors'] = list(colors)
    src = os.path.join(d, 'o.h5ad'); a.write_h5ad(src)
    return src


def _cats(out, name='stage'):
    raw = open(out, 'rb').read()
    hl = int.from_bytes(raw[-12:-4], 'little')
    h = json.loads(raw[-12 - hl:-12])
    return next(c for c in h['obs'] if c['name'] == name)


def test_order_is_not_inferred_from_key_names():
    """Without --obs-order the file's own category order is kept, even if a conventional key exists."""
    with tempfile.TemporaryDirectory() as d:
        src = _ordered_fixture(d)                       # stage_plot_order present in uns
        out = os.path.join(d, 'x.scb')
        pack(src, out)
        assert _cats(out)['categories'] == ['Adult', 'Fetal', 'Neonatal']   # alphabetical


def test_explicit_obs_order_key():
    """--obs-order COLUMN=UNS_KEY applies the named order."""
    with tempfile.TemporaryDirectory() as d:
        src = _ordered_fixture(d, uns_key='my_funny_key')
        out = os.path.join(d, 'x.scb')
        pack(src, out, obs_order={'stage': 'my_funny_key'})
        assert _cats(out)['categories'] == ['Fetal', 'Neonatal', 'Adult']


def test_missing_order_key_is_ignored():
    """Naming a uns key that does not exist keeps the file's order rather than failing."""
    with tempfile.TemporaryDirectory() as d:
        src = _ordered_fixture(d)
        out = os.path.join(d, 'x.scb')
        pack(src, out, obs_order={'stage': 'no_such_key'})
        assert _cats(out)['categories'] == ['Adult', 'Fetal', 'Neonatal']


def test_partial_order_is_refused():
    """An order that does not name every category keeps the file's own order."""
    with tempfile.TemporaryDirectory() as d:
        src = _ordered_fixture(d, order=('Fetal', 'Neonatal'))      # 'Adult' missing
        out = os.path.join(d, 'x.scb')
        pack(src, out, obs_order={'stage': 'stage_plot_order'})
        assert _cats(out)['categories'] == ['Adult', 'Fetal', 'Neonatal']   # alphabetical


def test_positional_colors_follow_the_reorder():
    """A positional uns['<col>_colors'] is permuted with the categories, not left behind."""
    with tempfile.TemporaryDirectory() as d:
        # colours are written against the alphabetical order Adult, Fetal, Neonatal
        src = _ordered_fixture(d, colors=('#aa0000', '#00bb00', '#0000cc'))
        out = os.path.join(d, 'x.scb')
        pack(src, out, obs_order={'stage': 'stage_plot_order'})
        ent = _cats(out)
        assert ent['categories'] == ['Fetal', 'Neonatal', 'Adult']
        assert ent['colors'] == ['#00bb00', '#0000cc', '#aa0000']   # each colour kept its label
