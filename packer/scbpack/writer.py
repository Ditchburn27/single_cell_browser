"""Write the .scb container (see docs/scb-format.md). Dataset-agnostic: nothing is assumed about the data."""
import gzip
import json
import struct
import sys

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.special import erfc

MAGIC = b"SCB1"


class _Out:
    def __init__(self, path):
        self.f = open(path, "wb")
        self.pos = 0

    def add(self, raw, level=6):
        b = gzip.compress(raw, compresslevel=level, mtime=0)
        ref = {"offset": self.pos, "length": len(b)}
        self.f.write(b)
        self.pos += len(b)
        return ref

    def add_json(self, obj):
        return self.add(json.dumps(obj, separators=(",", ":")).encode("utf-8"))

    def finish(self, header):
        hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
        self.f.write(hb)
        self.f.write(struct.pack("<Q", len(hb)))
        self.f.write(MAGIC)
        self.f.close()


def _log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _guess_species(names):
    names = [n for n in names[:: max(1, len(names) // 3000)] if n[:1].isalpha() and not n.upper().startswith("ENS")]
    if len(names) < 50:
        return "unknown"
    up = sum(1 for n in names if n == n.upper())
    cap = sum(1 for n in names if n[:1].isupper() and n[1:2].islower() or n[1:2].isdigit() and n[:1].isupper() and n != n.upper())
    if up / len(names) > 0.6:
        return "human"
    if cap / len(names) > 0.6:
        return "mouse"
    return "unknown"


def _palette(name, cats, uns, override=None):
    """Colours for a categorical column, in order of the categories actually packed.

    Three sources, most explicit first:
      1. `override` - an uns key given on the command line as --obs-colors 'Column=uns_key'.
      2. uns['<column>_colors']      - positional list, the AnnData/scanpy convention.
      3. uns['<column>_colors_dict'] - mapping category -> colour. Preferred when present
         because it survives category reordering and subsetting: a dict may legitimately
         carry more entries than this object has categories (e.g. a palette inherited from
         a larger parent object), and each category is looked up by name.

    Returns None rather than a partial palette - a positional list shorter than the
    categories, or a dict missing some of them, would silently mis-colour the plot.
    """
    if uns is None:
        return None

    def _s(v):
        return v.decode() if isinstance(v, bytes) else str(v)

    def _from(key, explicit):
        obj = uns.get(key)
        if obj is None:
            if explicit:
                _log("  warning: --obs-colors %s=%s - no such uns key, ignoring" % (name, key))
            return None
        if hasattr(obj, "keys") and not isinstance(obj, (str, bytes)):
            lut = {_s(k): _s(v) for k, v in dict(obj).items()}
            missing = [c for c in cats if c not in lut]
            if missing:
                _log("  warning: uns[%r] has no colour for %d/%d categories of %r (e.g. %s)"
                     % (key, len(missing), len(cats), name, ", ".join(missing[:3])))
                return None
            return [lut[c] for c in cats]
        seq = list(obj)
        if len(seq) < len(cats):
            _log("  warning: uns[%r] has %d colours but %r has %d categories - ignoring"
                 % (key, len(seq), name, len(cats)))
            return None
        return [_s(c) for c in seq[: len(cats)]]

    if override:
        return _from(override, True)
    return _from(name + "_colors_dict", False) or _from(name + "_colors", False)


def _category_order(name, cats, uns, key=None):
    """Display order for a categorical, read from an explicitly named `uns` key.

    Only used when the caller asks for it with --obs-order COLUMN=UNS_KEY. Without the
    flag the file's own category order is kept, so nothing is inferred from key names.
    An order that does not name exactly the categories present is refused with a
    warning rather than applied partially.
    """
    if not key or key not in uns:
        if key:
            _log("  warning: --obs-order key %r for %r is not in uns; keeping the file's order" % (key, name))
        return None
    want = [str(x) for x in list(uns[key])]
    if sorted(want) != sorted(cats):
        missing = [c for c in cats if c not in want]
        _log("  warning: uns[%r] does not list the categories of %r (%d vs %d%s); keeping the file's order"
             % (key, name, len(want), len(cats),
                ", e.g. missing " + ", ".join(missing[:3]) if missing else ""))
        return None
    return None if want == cats else want


def _obs_column(name, s, uns, color_key=None, order_key=None):
    """Return header entry (without section refs) and payload bytes for a pandas Series."""
    if pd.api.types.is_categorical_dtype(s) or s.dtype == object or pd.api.types.is_bool_dtype(s) or pd.api.types.is_string_dtype(s):
        if pd.api.types.is_bool_dtype(s):
            s = s.map({True: "True", False: "False"})
        if not pd.api.types.is_categorical_dtype(s):
            vals = s.astype(object).where(s.notna(), None)
            if vals.nunique() > 2000:
                return {"kind": "str"}, [("values", json.dumps(["" if v is None else str(v) for v in vals]).encode())]
            s = vals.astype("category")
        cats = [str(c) for c in s.cat.categories]
        # Resolve the palette against the ORIGINAL order first: a positional
        # uns['<col>_colors'] is written in that order, so it has to be permuted with the
        # categories rather than re-read afterwards.
        colors = _palette(name, cats, uns, color_key)
        order = _category_order(name, cats, uns, order_key)
        if order:
            perm = [cats.index(c) for c in order]
            by_name = {str(c): c for c in s.cat.categories}
            s = s.cat.reorder_categories([by_name[c] for c in order])
            cats = order
            if colors:
                colors = [colors[i] for i in perm]
            _log("  %r reordered from uns (%s)" % (name, ", ".join(cats[:4]) + ("…" if len(cats) > 4 else "")))
        codes = s.cat.codes.to_numpy()
        dtype = "i2" if len(cats) < 32000 else "i4"
        ent = {"kind": "cat", "categories": cats, "dtype": dtype}
        if colors:
            ent["colors"] = colors
        return ent, [("codes", codes.astype("<" + dtype).tobytes())]
    if pd.api.types.is_numeric_dtype(s):
        arr = pd.to_numeric(s, errors="coerce").to_numpy(dtype="float32")
        return {"kind": "num"}, [("values", arr.astype("<f4").tobytes())]
    return None, None


def _markers(adata, topn=60):
    rg = adata.uns.get("rank_genes_groups") if hasattr(adata, "uns") else None
    if rg is None or "names" not in rg:
        return None
    names = rg["names"]
    groups = list(names.dtype.names)
    out = {}
    for g in groups:
        rows = []
        for i in range(min(topn, len(names))):
            def pick(key):
                if key in rg:
                    v = rg[key][g][i]
                    return float(v) if np.isfinite(v) else None
                return None
            rows.append({"gene": str(names[g][i]), "score": pick("scores"), "lfc": pick("logfoldchanges"), "padj": pick("pvals_adj")})
        out[str(g).strip()] = rows
    groupby = None
    params = rg.get("params") if hasattr(rg, "get") else None
    if params is not None and "groupby" in params:
        gb = params["groupby"]
        groupby = str(gb if not isinstance(gb, (list, tuple, np.ndarray)) else gb[0])
    if groupby not in adata.obs.columns:
        groupby = None
    return {"groupby": groupby, "groups": out}


def _bh(p):
    """Benjamini-Hochberg adjusted p-values."""
    m = len(p)
    if m == 0:
        return p
    order = np.argsort(p)
    adj = p[order] * m / np.arange(1, m + 1)
    adj = np.minimum.accumulate(adj[::-1])[::-1]
    out = np.empty(m)
    out[order] = np.clip(adj, 0, 1)
    return out


class _MarkerAccum:
    """One-vs-rest Wilcoxon for every category of one obs column, gene by gene.

    Each gene's values are ranked once and the ranks summed per group, so all groups
    cost a single pass over the matrix. (The viewer's "Compute markers" button instead
    re-reads the whole matrix once per group, which is why it is only usable on a
    locally opened file.) Statistics match the viewer's `de()`: Wilcoxon z with tie
    correction, log2 fold change on the expm1 scale with a 1e-3 floor, BH-adjusted p.
    """

    def __init__(self, codes, n_groups, n_genes):
        self.codes = np.asarray(codes, dtype=np.int64)
        self.n = len(self.codes)
        self.K = int(n_groups)
        # one extra bucket absorbs cells with no category; it is never reported
        self.sizes = np.bincount(self.codes, minlength=self.K + 1).astype(np.float64)
        self.z = np.zeros((n_genes, self.K + 1), dtype=np.float32)
        self.lfc = np.zeros((n_genes, self.K + 1), dtype=np.float32)
        self.p = np.ones((n_genes, self.K + 1), dtype=np.float64)
        self.j = 0

    def add(self, rows, vals):
        j = self.j
        self.j += 1
        if j >= self.z.shape[0] or len(rows) == 0:
            return
        n, K = self.n, self.K
        sizes = self.sizes
        v = np.asarray(vals, dtype=np.float64)
        nz = len(v)
        zeros = n - nz
        order = np.argsort(v, kind="stable")
        vs = v[order]
        uniq, inv, cnt = np.unique(vs, return_inverse=True, return_counts=True)
        csum = np.concatenate([[0], np.cumsum(cnt)])
        # all zeros tie below every positive value, so nonzero ranks start at `zeros`
        avg = zeros + (csum[:-1] + csum[1:] + 1) / 2.0
        ranks = np.empty(nz)
        ranks[order] = avg[inv]
        g = self.codes[np.asarray(rows, dtype=np.int64)]
        rank_sum = np.bincount(g, weights=ranks, minlength=K + 1)
        cnt_nz = np.bincount(g, minlength=K + 1).astype(np.float64)
        rank_sum += (sizes - cnt_nz) * ((zeros + 1) / 2.0)
        tie = (zeros ** 3 - zeros) + float(np.sum(cnt.astype(np.float64) ** 3 - cnt))
        nA = sizes
        nB = n - nA
        mu = nA * (n + 1) / 2.0
        var = nA * nB / 12.0 * ((n + 1) - tie / (n * (n - 1.0)))
        sd = np.sqrt(np.maximum(var, 0.0))
        zz = np.where(sd > 0, (rank_sum - mu) / np.where(sd > 0, sd, 1.0), 0.0)
        e = np.expm1(v)
        expA = np.bincount(g, weights=e, minlength=K + 1)
        expB = e.sum() - expA
        with np.errstate(divide="ignore", invalid="ignore"):
            lfc = np.log2((expA / nA + 1e-3) / (expB / nB + 1e-3))
        ok = (nA >= 1) & (nB >= 1)
        self.z[j] = np.where(ok, zz, 0.0)
        self.lfc[j] = np.where(ok, np.nan_to_num(lfc), 0.0)
        self.p[j] = erfc(np.abs(self.z[j]) / np.sqrt(2.0))

    def finish(self, groupby, categories, gene_names, topn=30):
        groups = {}
        for k, name in enumerate(categories):
            key = str(name).strip()
            nA = self.sizes[k]
            if nA < 3 or nA > self.n - 3:
                groups[key] = []
                continue
            padj = _bh(self.p[:, k])
            z = self.z[:, k]
            lfc = self.lfc[:, k]
            cand = np.flatnonzero(lfc > 0)
            cand = cand[np.argsort(-z[cand])][:topn]
            groups[key] = [{"gene": str(gene_names[i]), "score": float(z[i]),
                            "lfc": float(lfc[i]), "padj": float(padj[i])} for i in cand]
        return {"groupby": groupby, "groups": groups}


def _spatial(adata, out):
    """Tissue image + scale factors from uns['spatial'] (Visium-style), if present."""
    try:
        sp_ = adata.uns["spatial"]
        for lib in sp_.keys():
            L = sp_[lib]
            if "images" not in L:
                continue
            key = next((k for k in ("hires", "lowres") if k in L["images"]), next(iter(L["images"].keys()), None))
            if key is None:
                continue
            img = np.asarray(L["images"][key])
            if img.ndim != 3 or img.shape[0] * img.shape[1] > 40000000:
                continue
            if img.dtype != np.uint8:
                img = np.clip(img * 255.0, 0, 255).astype("u1")
            img = img[:, :, :3] if img.shape[2] >= 3 else np.repeat(img[:, :, :1], 3, axis=2)
            sf = L.get("scalefactors", {})
            return {"library": str(lib), "imageKey": key, "scale": float(sf.get("tissue_%s_scalef" % key, 1.0)),
                    "spotDiameter": float(sf.get("spot_diameter_fullres", 0.0)),
                    "width": int(img.shape[1]), "height": int(img.shape[0]), "rgb": out.add(np.ascontiguousarray(img).tobytes())}
    except KeyError:
        return None
    except Exception as e:  # pragma: no cover
        _log("  (could not read spatial image: %s)" % e)
    return None


def _read_matrix_rows(X, start, stop):
    chunk = X[start:stop]
    return chunk.tocsr() if sp.issparse(chunk) else sp.csr_matrix(np.asarray(chunk))


def _iter_selected(X, cells, n_all, chunk):
    """Yield CSR blocks containing only the selected cells (in order), streaming contiguous source rows."""
    for a in range(0, n_all, chunk):
        b = min(a + chunk, n_all)
        lo, hi = np.searchsorted(cells, a), np.searchsorted(cells, b)
        if hi <= lo:
            continue
        m = _read_matrix_rows(X, a, b)
        sel = cells[lo:hi] - a
        yield m if len(sel) == b - a else m[sel]


def _matrix_format(X):
    f = getattr(X, "format_str", None) or getattr(X, "format", None)
    if f in ("csr", "csc"):
        return f
    return "csr"


def _col_block(X, j0, j1):
    m = X[:, j0:j1]
    return m.tocsc() if sp.issparse(m) else sp.csc_matrix(np.asarray(m))


def _col_select(X, cols):
    """Columns of a (possibly backed) CSC matrix. Contiguous runs are read as slices (fast on disk)."""
    runs = np.split(cols, np.flatnonzero(np.diff(cols) != 1) + 1)
    return sp.hstack([_col_block(X, int(r[0]), int(r[-1]) + 1) for r in runs], format="csc")


def _gene_stats(X, fmt, cells, n_all, G, chunk, counts_like):
    """Per-gene sum, sum of squares and detected-cell count (on log1p-CP10k when the data are counts). Streams the file."""
    s1 = np.zeros(G); s2 = np.zeros(G); nz = np.zeros(G)
    if fmt == "csc":
        totals = _cell_totals(X, fmt, cells, n_all, G, chunk) if counts_like else None
        for j0 in range(0, G, 2000):
            m = _col_block(X, j0, min(G, j0 + 2000))
            v = (m[cells] if len(cells) != n_all else m).astype("float64").tocsc()
            if totals is not None:
                v = (sp.diags(1e4 / totals) @ v).tocsc(); v.data = np.log1p(v.data)
            j1 = j0 + v.shape[1]
            s1[j0:j1] = np.asarray(v.sum(axis=0)).ravel(); s2[j0:j1] = np.asarray(v.multiply(v).sum(axis=0)).ravel(); nz[j0:j1] = np.diff(v.indptr)
    else:
        for m in _iter_selected(X, cells, n_all, chunk):
            v = m.astype("float64").tocsr()
            if counts_like:
                tot = np.asarray(v.sum(axis=1)).ravel(); tot[tot == 0] = 1
                v = (sp.diags(1e4 / tot) @ v).tocsr(); v.data = np.log1p(v.data)
            s1 += np.asarray(v.sum(axis=0)).ravel(); s2 += np.asarray(v.multiply(v).sum(axis=0)).ravel()
            nz += np.bincount(v.indices, minlength=G)
    return s1, s2, nz


def _cell_totals(X, fmt, cells, n_all, G, chunk):
    if fmt == "csc":
        tot = np.zeros(n_all)
        for j0 in range(0, G, 2000):
            tot += np.asarray(_col_block(X, j0, min(G, j0 + 2000)).sum(axis=1)).ravel()
        tot = tot[cells]
    else:
        tot = np.concatenate([np.asarray(m.sum(axis=1)).ravel() for m in _iter_selected(X, cells, n_all, chunk)])
    tot = tot.astype("float64"); tot[tot == 0] = 1
    return tot


def _gene_block(rows, vals, q):
    rows = np.asarray(rows).astype("<u4"); vals = np.asarray(vals).astype("float32")
    delta = np.diff(rows, prepend=np.uint32(0)).astype("<u4") if len(rows) else rows
    scale = float(vals.max()) if len(vals) and vals.max() > 0 else 1.0
    if q == "u8":
        enc = np.clip(np.round(vals / scale * 255.0), 0, 255).astype("u1").tobytes()
    elif q == "f16":
        enc = vals.astype("<f2").tobytes()
    else:
        enc = vals.astype("<f4").tobytes()
    return struct.pack("<If", int(len(rows)), scale) + delta.tobytes() + enc


def _select_cells(n, max_cells, seed):
    if max_cells and n > max_cells:
        rng = np.random.default_rng(seed)
        return np.sort(rng.choice(n, max_cells, replace=False))
    return np.arange(n)


def _layer_matrix(adata, spec):
    """Return (matrix-like supporting row slicing, var_names list)."""
    if spec == "X":
        return adata.X, list(adata.var_names)
    if spec == "raw":
        return adata.raw.X, list(adata.raw.var_names)
    return adata.layers[spec], list(adata.var_names)


def _looks_like_counts(sample):
    v = sample.data if sp.issparse(sample) else np.asarray(sample).ravel()
    v = v[v != 0][:20000]
    return bool(len(v) and np.all(np.mod(v, 1) == 0))


def _resolve_defaults(requested, obs_cols, gene_names, emb_names):
    """Validate the opening view requested on the command line against what was actually packed.

    Returns a dict with only the keys that resolved; warns about the ones that did not, so a
    typo in a column or gene name is visible at pack time rather than silently ignored later.
    Matching is exact first, then case-insensitive, so --default-gene rorb finds RORB.
    """
    out = {}
    for key, want, pool, label in (
        ("annotation", requested.get("annotation"), obs_cols, "obs column"),
        ("gene", requested.get("gene"), gene_names, "gene"),
        ("embedding", requested.get("embedding"), emb_names, "embedding"),
    ):
        if not want:
            continue
        hit = want if want in pool else next((c for c in pool if c.lower() == want.lower()), None)
        if hit is None:
            _log("  warning: default %s %r not found among %d %ss — ignoring"
                 % (key, want, len(pool), label))
            continue
        if hit != want:
            _log("  default %s %r matched %r" % (key, want, hit))
        out[key] = hit
    return out


def pack(path, out_path, layers=("X",), embeddings=None, genes="all", max_cells=0, quant="auto",
         obs_keep=None, min_cells=0, seed=0, chunk=20000, keep_markers=True, name=None,
         defaults=None, obs_colors=None, obs_order=None, markers=None, markers_top=30):
    import anndata

    _log("reading %s (backed)…" % path)
    adata = anndata.read_h5ad(path, backed="r")
    n_all = adata.n_obs
    cells = _select_cells(n_all, max_cells, seed)
    n = len(cells)
    obs = adata.obs.iloc[cells]
    uns = adata.uns

    out = _Out(out_path)
    header = {"version": 1, "name": name or str(path).rsplit("/", 1)[-1].replace(".h5ad", ""), "n": int(n)}
    header["obsNames"] = out.add_json([str(x) for x in obs.index])

    # obs columns
    keep = list(obs.columns) if not obs_keep else [c for c in obs_keep if c in obs.columns]
    cols = []
    for c in keep:
        try:
            ent, parts = _obs_column(c, obs[c], uns, (obs_colors or {}).get(c), (obs_order or {}).get(c))
        except Exception as e:  # pragma: no cover
            _log("  skipping obs column %s: %s" % (c, e))
            continue
        if ent is None:
            continue
        if ent["kind"] != "str" and obs[c].isna().all():
            continue
        ent["name"] = c
        for key, raw in parts:
            ent[key] = out.add(raw)
        cols.append(ent)
    header["obs"] = cols
    _log("  %d cells, %d obs columns" % (n, len(cols)))
    tinted = [c["name"] for c in cols if c.get("colors")]
    _log("  palettes kept for %d column(s): %s" % (len(tinted), ", ".join(tinted) or "none"))

    # embeddings
    emb_names = embeddings or [k for k in adata.obsm.keys() if np.asarray(adata.obsm[k]).ndim == 2 and np.asarray(adata.obsm[k]).shape[1] >= 2]
    embs = []
    for k in emb_names:
        arr = np.asarray(adata.obsm[k])[cells]
        dim = min(arr.shape[1], 10)
        embs.append({"name": k, "dim": int(dim), "data": out.add(np.ascontiguousarray(arr[:, :dim], dtype="<f4").tobytes())})
    header["embeddings"] = embs
    accum = None
    mk_cats = mk_codes = None
    if markers:
        if markers not in obs.columns:
            _log("  WARNING: --markers column %r not found; skipping marker computation" % markers)
        else:
            cat = obs[markers].astype("category")
            mk_cats = list(cat.cat.categories)
            mk_codes = np.asarray(cat.cat.codes, dtype=np.int64)
            mk_codes[mk_codes < 0] = len(mk_cats)  # uncategorised cells, never reported
            _log("  markers: one-vs-rest Wilcoxon over %d group(s) of %r" % (len(mk_cats), markers))
    header["markers"] = None if markers else _markers(adata)
    marker_genes = set()
    if keep_markers and header["markers"]:
        for rows in header["markers"]["groups"].values():
            marker_genes.update(r["gene"] for r in rows)

    # expression layers
    layer_entries = []
    first_layer_genes = []
    for spec in layers:
        X, var_names = _layer_matrix(adata, spec)
        G = len(var_names)
        fmt = _matrix_format(X)
        _log("layer %s: %d genes (%s)" % (spec, G, fmt))
        sample = _read_matrix_rows(X, 0, min(2000, n_all)) if fmt != "csc" else _col_block(X, 0, min(200, G))
        counts_like = _looks_like_counts(sample)
        need_stats = genes.startswith("hvg:") or min_cells > 0
        s1 = np.zeros(G); s2 = np.zeros(G); nz = np.zeros(G)
        if need_stats:
            _log("  pass 1: gene statistics…")
            s1, s2, nz = _gene_stats(X, fmt, cells, n_all, G, chunk, counts_like)
        selected = np.ones(G, dtype=bool)
        if min_cells > 0:
            selected &= nz >= min_cells
        if genes.startswith("hvg:"):
            k = int(genes.split(":")[1])
            mean = s1 / n; var = s2 / n - mean ** 2
            score = np.where(selected, var / np.maximum(mean, 1e-6), -1)
            sel = np.zeros(G, dtype=bool); sel[np.argsort(-score)[:k]] = True
            selected = sel
        elif genes != "all":
            wanted = {w.strip() for w in open(genes).read().replace(",", "\n").split() if w.strip()}
            selected = np.array([g in wanted for g in var_names])
        if marker_genes:
            selected |= np.array([g in marker_genes for g in var_names])
        gidx = np.flatnonzero(selected)
        _log("  keeping %d / %d genes" % (len(gidx), G))
        if mk_codes is not None and accum is None and not layer_entries:
            accum = _MarkerAccum(mk_codes, len(mk_cats), len(gidx))

        q = quant
        if q == "auto":
            q = "f32" if counts_like else "u8"
        offsets = np.zeros(len(gidx) + 1, dtype="<f8")
        pos0 = out.pos

        def write_csc(M, first):
            for j in range(M.shape[1]):
                a_, b_ = M.indptr[j], M.indptr[j + 1]
                offsets[first + j] = out.pos
                out.add(_gene_block(M.indices[a_:b_], M.data[a_:b_], q), level=4)
                if accum is not None:
                    accum.add(M.indices[a_:b_], M.data[a_:b_])

        # Per-cell totals for the log1p-CP10k transform. Summed here while the matrix is
        # already in hand: the viewer would otherwise have to read every gene to get them,
        # which is one HTTP request per gene for a dataset served over the network.
        tot = np.zeros(n, dtype=np.float64)
        _log("  pass 2: writing gene blocks…")
        if fmt == "csc":
            written = 0
            for a0 in range(0, len(gidx), 2000):
                cols_ = gidx[a0:a0 + 2000]
                M = _col_select(X, cols_)[cells].tocsc() if len(cells) != n_all else _col_select(X, cols_).tocsc()
                M.sort_indices()
                tot += np.asarray(M.sum(axis=1)).ravel()
                write_csc(M, written)
                written += M.shape[1]
                _log("    %d / %d genes" % (written, len(gidx)))
        else:
            parts = []; done = 0
            for m in _iter_selected(X, cells, n_all, chunk):
                parts.append(m[:, gidx].tocsr()); done += m.shape[0]
                if len(parts) % 5 == 1:
                    _log("    %d / %d cells" % (done, n))
            M = sp.vstack(parts, format="csc"); M.sort_indices()
            tot += np.asarray(M.sum(axis=1)).ravel()
            write_csc(M, 0)
        offsets[len(gidx)] = out.pos
        kept_names = [var_names[i] for i in gidx]
        if not first_layer_genes:
            first_layer_genes = kept_names
        layer_entries.append({
            "name": spec, "nGenes": int(len(gidx)), "quant": q, "looksLikeCounts": bool(counts_like),
            "varNames": out.add_json(kept_names),
            "index": out.add(offsets.tobytes()),
            "totals": out.add(tot.astype("<f4").tobytes()),
        })
        _log("  layer %s written (%.1f MB)" % (spec, (out.pos - pos0) / 1e6))
    header["layers"] = layer_entries
    if accum is not None:
        header["markers"] = accum.finish(markers, mk_cats, first_layer_genes, markers_top)
        kept = sum(1 for v in header["markers"]["groups"].values() if v)
        _log("  markers: %d / %d group(s) with ranked genes" % (kept, len(mk_cats)))
    header["meta"] = {"species": _guess_species(list(adata.var_names)), "geneLabelCol": None,
                      "spatial": _spatial(adata, out)}
    if defaults:
        resolved = _resolve_defaults(defaults, [c["name"] for c in cols], first_layer_genes,
                                     [e["name"] for e in embs])
        if resolved:
            header["meta"]["defaults"] = resolved
            _log("  opening view: " + ", ".join("%s=%s" % kv for kv in sorted(resolved.items())))
    out.finish(header)
    _log("wrote %s (%.1f MB)" % (out_path, out.pos / 1e6))
