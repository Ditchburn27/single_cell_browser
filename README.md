# AnnData Browser

Explore any annotated single-cell dataset (`.h5ad`) in your browser — and share it by just sending the file.
Fully client-side: the file is read locally by the page, nothing is uploaded (the deployed site's Content-Security-Policy
only allows requests to itself).

## For collaborators

1. Open the site, **drop an `.h5ad`** (or a packed `.scb`) on the page - or open a hosted one directly with
   `?data=<url>` (see [Hosting a `.scb`](#hosting-a-scb)).
2. Explore: two linked embeddings (colour by annotation / gene / gene-set score), a legend with counts and per-group
   marker genes, hover tooltips, box/lasso selection, differential expression, dot plot, heatmap, violin, composition,
   counts, gene-vs-gene, notes, PNG/SVG export, save/load the view.

**? Help** in the header (or the `?` key) describes every control, and every button has a hover tooltip. Things worth knowing:

- **Selection tools toggle.** Click the lit tool (Pan / Box / Lasso) again to turn it off: the plot still pans, the
  selection is cleared, and you are back to the whole dataset. Shortcuts: `p`, `b`, `l`; shift-drag selects with any tool,
  ⌘/Ctrl-drag adds, Alt-drag removes, `Esc` clears.
- **Legend.** Click a label to hide it, double-click to show only that group, click a swatch to recolour it. Hiding the
  last visible group (or double-clicking the group already on its own) restores every group, so the full dataset is always
  one click away.
- **Cancel.** Long operations (opening a big file, differential expression, computing markers) show a **Cancel** button.
  It stops the worker outright and then reopens the dataset, which resets the view and closes the panels.
- **Failed opens say so.** If a file fails to open while another dataset is on screen, the message states that nothing
  was loaded and which dataset you are still viewing.
- **Touch.** Drag to pan, pinch to zoom, double-tap to reset, tap a point to inspect it (stands in for hover).

What your file needs: an embedding in `obsm` (e.g. `X_umap`, `X_tsne`, `spatial`, or any 2+ column array/dataframe),
annotations in `obs`, an expression matrix (`X`, `raw/X` or `layers/*`; CSR, CSC or dense; gzip is fine).
Optional extras that are picked up automatically: marker genes from `sc.tl.rank_genes_groups` (`uns`), category colours
(`uns['<col>_colors']`, or `uns['<col>_colors_dict']` keyed by category name), Visium tissue image (`uns['spatial']`),
Ensembl-ID gene indexes with a symbol column.
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

To choose the view a dataset opens on - otherwise picked by generic heuristics - record it in the file:

```bash
scbpack big.h5ad -o big.scb --default-annotation 'Major Cluster' --default-gene RORB
```

`--default-embedding` does the same for the obsm key. Names are matched case-insensitively and checked
against what was actually packed, so a typo warns at pack time instead of being silently ignored.

Marker genes can be computed once at pack time instead of in the browser:

```bash
scbpack big.h5ad -o big.scb --markers 'Major Cluster'      # --markers-top N, default 30
```

Each gene is ranked once and the ranks summed per group, so every group costs a single pass over the
matrix (154k cells x 28k genes x 19 groups adds about a minute and 46 KB to the file). The statistics
match the viewer's own *Compute markers* - one-vs-rest Wilcoxon with tie correction, log fold change on
the `expm1` scale, Benjamini-Hochberg adjusted - so the stored result is what that button would produce.
Files that already carry `sc.tl.rank_genes_groups` are picked up without this flag.

This matters for a dataset served over HTTP: *Compute markers* reads every gene once per group, which is
one request per gene per group, so the viewer offers it only for a locally opened file and uses the
stored markers otherwise.

Every packed layer also carries per-cell totals, summed during packing. The viewer needs them for the
log1p-CP10k transform and would otherwise have to read the whole matrix to get them - again one request
per gene when the file is served over HTTP. A `.scb` written by an older version has none, and the viewer
then declines the transform for a hosted dataset rather than issuing those requests.

Category order defaults to the file's own. To display a categorical in a stored order - stages, timepoints,
doses - name the `uns` key that holds it. The key must list exactly the categories present, otherwise the file's
order is kept and a warning says why:

```bash
scbpack big.h5ad -o big.scb --obs-order 'Maturation Stage=stage_order'
```

Palettes are permuted with the categories, so each colour stays with its label.

Colours come from `uns['<col>_colors_dict']` (keyed by category name, preferred) or `uns['<col>_colors']`
(positional). For a palette stored under some other key, name it:

```bash
scbpack big.h5ad -o big.scb --obs-colors 'Sub Cluster=sub_clust_colors'
```

A partial palette is refused rather than applied, with a warning naming the categories it could not colour: a
positional list of the wrong length, or a dict inherited from a larger object, would otherwise mis-colour the
plot silently. The packer reports which columns ended up with one.

Annotations you create in the browser (select cells → *Save as annotation…*) can be exported and merged back:

```bash
scbpack apply-annotations my_dataset_annotations.json original.h5ad -o annotated.h5ad
```

## Develop

Needs **Node 22.14 or newer** (Vite 8 and jsdom 31 require it; `viewer/.node-version`, `.nvmrc` and the `engines` field pin it,
and Cloudflare's build reads the same file).

```bash
cd viewer
npm install
npm run dev          # http://localhost:5173
npm test             # vitest, see below
npm run build        # tsc + vite build → dist/ (static; the h5wasm worker is ~4.8 MB)
```

What the tests cover: the h5ad reader and CSR→CSC; the `.scb` round trip between the Python packer and the TypeScript
reader; differential expression against scipy; the HTTP Range source (`http-source`) and the dev server's `HEAD`/`Range`
handling (`serve-dist`); cancel terminating the worker (`client-cancel`); the legend's hide/isolate rules (`legend`); and
tooltips (`tooltip`, run in jsdom).

Test fixtures are generated from any viewer HTML of the old format / synthetic data:
`python3 tests/make_fixture.py <old_viewer.html> tests/fixtures`, `python3 tests/make_spatial_fixture.py tests/fixtures/spatial_synth.h5ad`,
`python3 tests/make_de_reference.py tests/fixtures/golden_small.h5ad tests/fixtures/de_ref.json`; then `scbpack` them to `.scb`.
Tests that need a fixture skip themselves when it is missing, so a fresh checkout runs a subset.

Python tests: `python3 tests/test_scbpack.py`.

Opt-in checks against your own files:

```bash
FILES=a.h5ad,b.h5ad npx vitest run tests/real-files.test.ts                      # reader smoke test on raw .h5ad files
SCB=big.scb REF=ref.json npx vitest run tests/real-scb.test.ts tests/http-source.test.ts   # packed file vs a reference dump
```

## Deploy to Cloudflare

Deployed as Workers static assets (Cloudflare's current path for static sites; `viewer/wrangler.toml`).

**Automatic.** The site is connected to this repo through Cloudflare **Workers Builds**, so a push to `main` builds and
deploys it, and other branches get preview builds. The build settings are:

| setting | value |
| --- | --- |
| Root directory | `viewer` |
| Build command | `npm ci && npm run build` |
| Deploy command | `npx wrangler deploy` |

Node comes from `viewer/.node-version`. Do not set `NODE_ENV=production` in the build variables: the build needs the dev
dependencies (`vite`, `typescript`). If a build fails, its log is under the Worker's **Builds** tab in the dashboard.

**Manual**, from your machine:

```bash
cd viewer
npx wrangler login          # once
npm run deploy              # build + wrangler deploy
```

`public/_headers` ships the CSP (no cross-origin isolation is needed, so third-party images such as the optional Allen ISH
panel keep working). Preview exactly what is served: `npm run build && node scripts/serve-dist.mjs`.

### Hosting a `.scb`

A `.scb` is designed to be read where it sits: the viewer issues a `HEAD` for the size, then one HTTP `Range`
request per section and per gene. Point it at one with `?data=`:

```
https://your-site.workers.dev/?data=/data/big.scb
```

Try it locally first - the dev server speaks `HEAD` and `Range`, so this is the same path the browser takes
in production:

```bash
npm run build
node scripts/serve-dist.mjs --data /path/to/folder/with/scb   # /data -> that folder
# http://localhost:4173/?data=/data/big.scb
```

An individual static asset file is capped at 25 MiB, so anything larger lives in R2. `worker/index.js` serves
`/data/<key>` from an R2 bucket with `HEAD` and `Range` support and hands every other path to the static assets.

The R2 binding in `wrangler.toml` is commented out, so a default deploy is a plain static site and `/data/*`
simply 404s. To serve a dataset from R2, create a bucket, uncomment the binding and name it:

```bash
npx wrangler r2 bucket create my-datasets
# wrangler.toml:  [[r2_buckets]]  binding = "DATA"  bucket_name = "my-datasets"
npx wrangler r2 object put my-datasets/big.scb --file big.scb    # up to ~315 MB
```

`wrangler r2 object put` refuses files much over 315 MB; for a larger `.scb` use an S3 client against the R2
endpoint (rclone, `aws s3`). With rclone, pass `--s3-no-check-bucket` - without it the upload tries to create
the bucket and fails with `403 AccessDenied`.

Two things worth knowing:

- `not_found_handling = "single-page-application"` answers `/data/*` with `index.html` unless
  `run_worker_first = ["/data/*"]` is set (wrangler >= 4.20.0).
- Serving the data from the Worker's own origin keeps the shipped CSP (`connect-src 'self'`) unchanged. A
  cross-origin URL works too, but that origin has to be added to `connect-src` in `public/_headers`, and the host
  must honour `Range`.

For scale: a 154,748 x 28,267 dataset packs to 661 MB, of which opening it reads 8.59 MB and each gene a further
8-110 KB.

### What a hosted dataset will not do

Reading a `.scb` over HTTP costs one request per gene, so anything that has to walk the *whole* gene axis is
refused when the dataset was opened from a URL, and offered as normal for a file the user opens themselves:

| operation | genes read | hosted |
| --- | --- | --- |
| differential expression (`de`) | all | refused in `worker.ts`; the panel's other actions still work |
| marker finding (`de` per group) | all x groups | replaced by the markers stored at pack time |
| per-cell totals for log1p-CP10k | all | read from the file; refused if it carries none |
| gene view, violin, gene vs gene, dot plot, heatmap, gene set score | only the genes named | works |

The guard lives in the worker's `de` case rather than in each button, so a new caller cannot route around it.
If you add an operation that scans every gene, guard it there too.

## Architecture

```
viewer/src/data     schema, h5ad reader (h5wasm in a worker, WORKERFS = no whole-file read), CSR→CSC, .scb reader
                    (local file or HTTP Range), DE/stats; the worker is terminated to cancel (client.ts)
viewer/src/render   WebGL2 scatter (1M points @ 140 fps), colour maps, hover grid, lasso hit-testing
viewer/src/panels   charts written once against a Draw API with canvas + SVG backends (every plot exports as SVG)
viewer/src/ui       panes (legend, labels, interaction), dock panels (selection/DE, dot, heatmap, …), themed tooltips
viewer/src/state    default view heuristics (`defaults.ts`), legend hide/isolate rules (`legend.ts`)
viewer/src/plugins  optional, data-gated side panels (Allen mouse-brain ISH, shown only for mouse-like gene symbols)
viewer/worker       Cloudflare Worker serving .scb from R2 by HTTP Range at /data/<key>
packer/scbpack      Python packer + annotation merge
```

## Ideas not built yet

Faceted embeddings, two-gene blends, QC dashboard, composition statistics, pseudobulk DE,
shared comments (D1), computing missing embeddings in `scbpack`, Zarr/Loom/Seurat inputs, gene-info link-outs.
