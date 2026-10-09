/// <reference lib="webworker" />
// Data worker: owns the HDF5 file and the expression matrices; the UI thread only receives typed arrays.
import * as h5wasm from 'h5wasm';
import { readH5adMeta, type ReadResult } from './h5ad-reader';
import { openSource, TooBigError, type GeneSource } from './gene-source';
import { blobSource, readScb, type ScbFile } from './scb';
import { computeTotals, de, denseGene, geneSetScore, groupStats, type Computer, type Transform } from './compute';
import type { DatasetPayload } from './schema';

let H5: Awaited<typeof h5wasm.ready> | null = null;
let file: any = null;
let read: ReadResult | null = null;
let payload: DatasetPayload | null = null;
let scb: ScbFile | null = null;
const sources = new Map<string, GeneSource>();
const totalsCache = new Map<string, Float32Array>();

const post = (m: unknown, tr: Transferable[] = []) => (self as unknown as Worker).postMessage(m, tr);
const progress = (id: number) => (msg: string, frac?: number) => post({ id, type: 'progress', msg, frac });

function collectBuffers(p: DatasetPayload): Transferable[] {
  const out: Transferable[] = [];
  for (const c of Object.values(p.obs)) {
    if (c.kind === 'cat') out.push(c.codes.buffer);
    else if (c.kind === 'num') out.push(c.values.buffer);
  }
  for (const e of p.embeddings) out.push(e.data.buffer);
  if (p.meta.spatial?.rgba) out.push(p.meta.spatial.rgba.buffer);
  return out;
}

async function openFile(id: number, f: File) {
  if (file) { try { file.close(); } catch { /* ignore */ } file = null; }
  sources.clear(); totalsCache.clear(); scb = null; read = null;
  if (/\.scb$/i.test(f.name)) {
    scb = readScb(blobSource(f), f.name, progress(id));
    payload = scb.payload;
    return payload;
  }
  H5 = await h5wasm.ready;
  const FS = H5.FS!;
  try { FS.unmount('/work'); } catch { /* not mounted */ }
  try { FS.mkdir('/work'); } catch { /* exists */ }
  FS.mount(FS.filesystems.WORKERFS, { files: [f] }, '/work');
  file = new h5wasm.File(`/work/${f.name}`, 'r');
  read = readH5adMeta(file, { fileName: f.name, fileSize: f.size, onProgress: progress(id) });
  payload = read.payload;
  return payload;
}

function sourceFor(id: number, layer: string): GeneSource {
  let s = sources.get(layer);
  if (s) return s;
  if (!payload) throw new Error('No file open');
  const info = payload.layers.find((l) => l.name === layer);
  if (!info) throw new Error(`Unknown layer ${layer}`);
  if (scb) { s = scb.source(layer); sources.set(layer, s); return s; }
  if (!read) throw new Error('No file open');
  const node = file.get(read.layerNodes[layer]);
  progress(id)(`Indexing ${layer} for fast gene lookup…`, 0);
  s = openSource(node, info.storage, payload.n, info.varNames.length, (f) => progress(id)(`Indexing ${layer} for fast gene lookup…`, f));
  sources.set(layer, s);
  return s;
}

function computer(id: number, layer: string, transform: Transform): Computer {
  const src = sourceFor(id, layer);
  let totals: Float32Array | null = null;
  if (transform !== 'none') {
    totals = totalsCache.get(layer) ?? null;
    if (!totals) {
      progress(id)('Computing per-cell totals…', 0);
      totals = computeTotals(src, (f) => progress(id)('Computing per-cell totals…', f));
      totalsCache.set(layer, totals);
    }
  }
  return { src, totals, transform };
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  const { id } = m;
  try {
    switch (m.type) {
      case 'open': {
        const p = await openFile(id, m.file);
        post({ id, type: 'result', result: p }, collectBuffers(p));
        break;
      }
      case 'gene': {
        const v = denseGene(computer(id, m.layer, m.transform), m.gene);
        post({ id, type: 'result', result: v }, [v.buffer]);
        break;
      }
      case 'geneSet': {
        const v = geneSetScore(computer(id, m.layer, m.transform), m.genes);
        post({ id, type: 'result', result: v }, [v.buffer]);
        break;
      }
      case 'groupStats': {
        const r = groupStats(computer(id, m.layer, m.transform), m.genes, m.codes, m.nGroups);
        post({ id, type: 'result', result: r }, [r.mean.buffer, r.pct.buffer, r.sizes.buffer]);
        break;
      }
      case 'de': {
        const r = de(computer(id, m.layer, m.transform), m.maskA, m.maskB ?? null, (f) => progress(id)('Testing genes…', f));
        const tr = Object.values(r).filter((x) => ArrayBuffer.isView(x)).map((x) => (x as ArrayBufferView).buffer as ArrayBuffer);
        post({ id, type: 'result', result: r }, tr);
        break;
      }
      case 'prepare': {
        sourceFor(id, m.layer);
        post({ id, type: 'result', result: true });
        break;
      }
      default:
        throw new Error(`unknown message ${m.type}`);
    }
  } catch (e) {
    const err = e as Error;
    post({ id, type: 'error', message: err.message, tooBig: e instanceof TooBigError });
  }
};
