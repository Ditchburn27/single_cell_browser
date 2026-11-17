import argparse

from .writer import pack


def _apply(argv):
    from .annotations import apply_annotations

    p = argparse.ArgumentParser(prog="scbpack apply-annotations", description="Write annotations exported from the browser into a copy of an .h5ad.")
    p.add_argument("annotations", help="JSON from 'Export annotations'")
    p.add_argument("input", help="original .h5ad")
    p.add_argument("-o", "--output", required=True, help="new .h5ad")
    a = p.parse_args(argv)
    cols = apply_annotations(a.annotations, a.input, a.output)
    print("added obs columns: " + ", ".join(cols))


def main(argv=None):
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == "apply-annotations":
        return _apply(args[1:])
    p = argparse.ArgumentParser(prog="scbpack", description="Pack an AnnData .h5ad into a compact .scb for AnnData Browser.")
    p.add_argument("input", help="input .h5ad")
    p.add_argument("-o", "--output", required=True, help="output .scb")
    p.add_argument("--layer", action="append", help="X (default), raw, or a layer name; repeat to include several")
    p.add_argument("--embedding", action="append", help="obsm key to keep (default: every 2+ column embedding)")
    p.add_argument("--genes", default="all", help="all | hvg:N (variance/mean ranked) | file.txt (one gene per line)")
    p.add_argument("--min-cells", type=int, default=0, help="drop genes detected in fewer cells")
    p.add_argument("--max-cells", type=int, default=0, help="randomly keep at most N cells")
    p.add_argument("--quant", choices=["auto", "u8", "f16", "f32"], default="auto",
                   help="value precision: auto = f32 for integer counts, u8 (per-gene scaled) otherwise")
    p.add_argument("--obs-keep", help="comma-separated obs columns to keep (default: all)")
    p.add_argument("--no-keep-markers", action="store_true", help="do not force rank_genes_groups genes to be kept")
    p.add_argument("--default-annotation", help="obs column the viewer should colour by on open (default: chosen heuristically)")
    p.add_argument("--default-gene", help="gene the viewer should show on open (default: chosen heuristically)")
    p.add_argument("--default-embedding", help="obsm key the viewer should open with (default: chosen heuristically)")
    p.add_argument("--obs-colors", action="append", metavar="COLUMN=UNS_KEY",
                   help="take an obs column's palette from a non-standard uns key, e.g. "
                        "--obs-colors 'Sub Cluster=sub_clust_colors'; repeatable")
    p.add_argument("--seed", type=int, default=0)
    a = p.parse_args(argv)
    defaults = {"annotation": a.default_annotation, "gene": a.default_gene, "embedding": a.default_embedding}
    obs_colors = dict(x.split("=", 1) for x in (a.obs_colors or []))
    pack(a.input, a.output, layers=tuple(a.layer or ["X"]), embeddings=a.embedding, genes=a.genes, max_cells=a.max_cells,
         quant=a.quant, obs_keep=a.obs_keep.split(",") if a.obs_keep else None, min_cells=a.min_cells, seed=a.seed,
         keep_markers=not a.no_keep_markers, defaults={k: v for k, v in defaults.items() if v},
         obs_colors=obs_colors)


if __name__ == "__main__":
    main()
