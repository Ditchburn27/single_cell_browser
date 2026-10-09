"""Python-side checks:  python3 -m pytest tests/test_scbpack.py  (or run directly)."""
import json, os, subprocess, sys, tempfile
import numpy as np, anndata as ad
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
