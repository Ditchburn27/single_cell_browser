# `.scb` — packed single-cell file for AnnData Browser

Designed so a browser can open multi-GB datasets instantly: only the footer, the small per-cell sections and the
genes you actually look at are ever read (`Blob.slice()` locally, HTTP `Range` when hosted).

```
[ section bytes ... ][ header JSON (utf-8) ][ u64 LE headerLength ][ "SCB1" ]
```

* Every section is an independent **gzip** stream; `offset`/`length` in the header are absolute file positions.
* Header JSON (`version: 1`):
  * `name`, `n` (cells), `obsNames` (section: JSON string array)
  * `obs[]`: `{name, kind: "cat"|"num"|"str", ...}`
    * `cat`: `categories[]`, optional `colors[]`, `codes` (section: int16/int32 LE per `dtype`, `-1` = missing)
    * `num`: `values` (section: float32 LE, NaN = missing)
    * `str`: `values` (section: JSON string array)
  * `embeddings[]`: `{name, dim, data}` (section: float32 LE, row-major `n x dim`)
  * `layers[]`: `{name, nGenes, quant: "u8"|"f16"|"f32", looksLikeCounts, varNames (section: JSON), index (section: float64 LE, nGenes+1 absolute block offsets)}`
  * `markers`: `{groupby, groups: {group: [{gene, score, lfc, padj}]}}` or `null`
  * `meta`: `{species, geneLabelCol, spatial, defaults?}`
    * `defaults`: `{annotation?, gene?, embedding?}` - the opening view, written by
      `scbpack --default-annotation/--default-gene/--default-embedding`. Names are validated at pack
      time against the columns, genes and embeddings actually kept. The viewer falls back to its
      generic heuristics for anything absent.
* **Gene block** `g` = bytes `[index[g], index[g+1])`, gzip of  
  `u32 nnz | f32 scale | u32 rowDelta[nnz] | values[nnz]`  
  rows are ascending; `rowDelta[0]` is the first row, the rest are differences. Values: `u8` → `byte / 255 * scale`,
  `f16` → IEEE half, `f32` → float32.
