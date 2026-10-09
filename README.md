# AnnData Browser

Explore any annotated single-cell dataset (`.h5ad`) in your browser — and share it by just sending the file.
Fully client-side: the file is read locally by the page, nothing is uploaded (the deployed site's Content-Security-Policy
only allows requests to itself).

## For collaborators

1. Open the site, **drop an `.h5ad`** (or a packed `.scb`) on the page.
2. Explore: two linked embeddings (colour by annotation / gene / gene-set score), legend with counts and per-group marker
   genes, hover tooltips, box/lasso selection, differential expression, dot plot, heatmap, violin, composition, counts,
   gene-vs-gene, notes, PNG/SVG export, save/load the view.

What your file needs: an embedding in `obsm` (e.g. `X_umap`, `X_tsne`, `spatial`, or any 2+ column array/dataframe),
annotations in `obs`, an expression matrix (`X`, `raw/X` or `layers/*`; CSR, CSC or dense; gzip is fine).
Optional extras that are picked up automatically: marker genes from `sc.tl.rank_genes_groups` (`uns`), category colours
(`uns['<col>_colors']`), Visium tissue image (`uns['spatial']`), Ensembl-ID gene indexes with a symbol column.
Nothing about gene names, obs columns or species is hard-coded; defaults are chosen from the file's contents.

### Big files → pack them first

A raw `.h5ad` must fit in browser memory (≈ 8–12 bytes per non-zero for CSR). Larger files show a message telling you to pack:

```bash
pip install ./packer          # once (needs anndata, scipy, pandas)
scbpack big.h5ad -o big.scb --genes hvg:5000 --max-cells 200000
```

`.scb` opens instantly and only decompresses the genes you look at. Example: a 4 GB CSC ATAC object → 14 MB; a 224 MB
RNA object → 54 MB. Options: `--layer X|raw|<name>` (repeatable), `--embedding`, `--genes all|hvg:N|file.txt`,
`--min-cells`, `--max-cells`, `--quant auto|u8|f16|f32`, `--obs-keep a,b,c`. Format: [docs/scb-format.md](docs/scb-format.md).

Annotations you create in the browser (select cells → *Save as annotation…*) can be exported and merged back:

```bash
scbpack apply-annotations my_dataset_annotations.json original.h5ad -o annotated.h5ad
```

## Develop

```bash
cd viewer
npm install
npm run dev          # http://localhost:5173
npm test             # vitest: reader, CSR→CSC, .scb cross-language round trip, DE vs scipy
npm run build        # → dist/ (static; the h5wasm worker is ~4.8 MB)
```

Test fixtures are generated from any viewer HTML of the old format / synthetic data:
`python3 tests/make_fixture.py <old_viewer.html> tests/fixtures`, `python3 tests/make_spatial_fixture.py tests/fixtures/spatial_synth.h5ad`,
`python3 tests/make_de_reference.py tests/fixtures/golden_small.h5ad tests/fixtures/de_ref.json`; then `scbpack` them to `.scb`.
Python tests: `python3 tests/test_scbpack.py`. Opt-in smoke test over your own files:
`FILES=a.h5ad,b.h5ad npx vitest run tests/real-files.test.ts`.

## Deploy to Cloudflare

Deployed as Workers static assets (Cloudflare's current path for static sites; `viewer/wrangler.toml`).

```bash
cd viewer
npx wrangler login          # once
npm run deploy              # build + wrangler deploy
```

`public/_headers` ships the CSP (no cross-origin isolation is needed, so third-party images such as the optional Allen ISH
panel keep working). Preview exactly what is served: `npm run build && node scripts/serve-dist.mjs`.

## Architecture

```
viewer/src/data     schema, h5ad reader (h5wasm in a worker, WORKERFS = no whole-file read), CSR→CSC, .scb reader, DE/stats
viewer/src/render   WebGL2 scatter (1M points @ 140 fps), colour maps, hover grid, lasso hit-testing
viewer/src/panels   charts written once against a Draw API with canvas + SVG backends (every plot exports as SVG)
viewer/src/ui       panes (legend, labels, interaction), dock panels (selection/DE, dot, heatmap, …)
viewer/src/plugins  optional, data-gated side panels (Allen mouse-brain ISH, shown only for mouse-like gene symbols)
packer/scbpack      Python packer + annotation merge
```

## Ideas not built yet

Faceted embeddings, two-gene blends, QC dashboard, composition statistics, pseudobulk DE, `?data=<url>` loading from R2,
shared comments (D1), computing missing embeddings in `scbpack`, Zarr/Loom/Seurat inputs, gene-info link-outs.
