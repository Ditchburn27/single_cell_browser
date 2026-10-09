"""Merge annotations exported from AnnData Browser (JSON) back into a copy of an .h5ad."""
import json

import anndata
import pandas as pd


def apply_annotations(json_path, h5ad_in, h5ad_out):
    with open(json_path) as f:
        payload = json.load(f)
    if payload.get("app") != "anndata-browser":
        raise SystemExit("not an AnnData Browser annotation file")
    ids = payload["cell_ids"]
    adata = anndata.read_h5ad(h5ad_in)
    pos = pd.Series(range(len(ids)), index=pd.Index(ids))
    missing = [c for c in adata.obs_names if c not in pos.index]
    if missing:
        raise SystemExit("%d cells in the h5ad are not in the annotation file (e.g. %s)" % (len(missing), missing[0]))
    order = pos.loc[adata.obs_names].to_numpy()
    for name, col in payload["columns"].items():
        labels = [col["labels"][i] for i in order]
        adata.obs[name] = pd.Categorical(labels, categories=col["categories"])
    adata.write_h5ad(h5ad_out)
    return list(payload["columns"].keys())
