// Reader for the packed .scb container (see docs/scb-format.md). Synchronous so it can feed GeneSource.
import { gunzipSync } from 'fflate';
import type { GeneSource, SparseCol } from './gene-source';
import type { CatCol, DatasetPayload, Embedding, LayerInfo, Markers, ObsCol, SpatialInfo } from './schema';

export interface ByteSource { size: number; read(offset: number, length: number): Uint8Array }

/** Worker-side Blob reader (FileReaderSync). */
export function blobSource(blob: Blob): ByteSource {
  const rd = new FileReaderSync();
  return { size: blob.size, read: (o, l) => new Uint8Array(rd.readAsArrayBuffer(blob.slice(o, o + l))) };
}

interface Ref { offset: number; length: number }
interface ObsEntry { name: string; kind: 'cat' | 'num' | 'str'; categories?: string[]; colors?: string[]; dtype?: string; codes?: Ref; values?: Ref }
interface LayerEntry { name: string; nGenes: number; quant: 'u8' | 'f16' | 'f32'; looksLikeCounts: boolean; varNames: Ref; index: Ref }
interface Header {
  version: number; name: string; n: number; obsNames: Ref; obs: ObsEntry[];
  embeddings: { name: string; dim: number; data: Ref }[]; layers: LayerEntry[]; markers: Markers | null;
  meta: { species: 'mouse' | 'human' | 'unknown'; geneLabelCol: string | null; spatial: null | { library: string; imageKey: string; scale: number; spotDiameter: number; width: number; height: number; rgb: Ref } };
}

const dec = new TextDecoder();
const section = (s: ByteSource, r: Ref) => gunzipSync(s.read(r.offset, r.length));
const json = <T>(s: ByteSource, r: Ref) => JSON.parse(dec.decode(section(s, r))) as T;
function aligned<T extends ArrayBufferView>(u8: Uint8Array, ctor: { new (b: ArrayBuffer, o: number, l: number): T; BYTES_PER_ELEMENT: number }): T {
  const copy = u8.byteOffset % ctor.BYTES_PER_ELEMENT === 0 ? u8 : u8.slice();
  return new ctor(copy.buffer as ArrayBuffer, copy.byteOffset, Math.floor(copy.byteLength / ctor.BYTES_PER_ELEMENT));
}

function half(h: number): number {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export class ScbSource implements GeneSource {
  private offsets: Float64Array;
  private cache = new Map<number, SparseCol>();
  constructor(private src: ByteSource, public nCells: number, private entry: LayerEntry) {
    this.nGenes = entry.nGenes;
    this.offsets = aligned(section(src, entry.index), Float64Array);
  }
  nGenes: number;
  readGene(g: number): SparseCol {
    const hit = this.cache.get(g);
    if (hit) { this.cache.delete(g); this.cache.set(g, hit); return hit; }
    const a = this.offsets[g], b = this.offsets[g + 1];
    const raw = gunzipSync(this.src.read(a, b - a));
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const nnz = dv.getUint32(0, true), scale = dv.getFloat32(4, true);
    const rows = new Uint32Array(nnz), vals = new Float32Array(nnz);
    let acc = 0, p = 8;
    for (let i = 0; i < nnz; i++, p += 4) { acc += dv.getUint32(p, true); rows[i] = acc; }
    const q = this.entry.quant;
    if (q === 'u8') for (let i = 0; i < nnz; i++) vals[i] = (raw[p + i] / 255) * scale;
    else if (q === 'f16') for (let i = 0; i < nnz; i++) vals[i] = half(dv.getUint16(p + 2 * i, true));
    else for (let i = 0; i < nnz; i++) vals[i] = dv.getFloat32(p + 4 * i, true);
    const col = { rows, vals };
    this.cache.set(g, col);
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value as number);
    return col;
  }
}

export interface ScbFile { payload: DatasetPayload; source(layer: string): GeneSource }

export function readScb(src: ByteSource, fileName: string, onProgress?: (m: string, f?: number) => void): ScbFile {
  const p = onProgress ?? (() => {});
  const tail = src.read(src.size - 12, 12);
  if (dec.decode(tail.subarray(8, 12)) !== 'SCB1') throw new Error('Not a .scb file (bad footer).');
  const hl = Number(new DataView(tail.buffer, tail.byteOffset, 12).getBigUint64(0, true));
  const header = JSON.parse(dec.decode(src.read(src.size - 12 - hl, hl))) as Header;
  if (header.version !== 1) throw new Error(`Unsupported .scb version ${header.version}`);
  p('Reading annotations…');
  const n = header.n, obs: Record<string, ObsCol> = {}, order: string[] = [];
  for (const e of header.obs) {
    if (e.kind === 'cat') {
      const raw = section(src, e.codes!);
      const codes = e.dtype === 'i4' ? aligned(raw, Int32Array) : aligned(raw, Int16Array);
      const col: CatCol = { kind: 'cat', codes, categories: e.categories!, colors: e.colors };
      obs[e.name] = col;
    } else if (e.kind === 'num') obs[e.name] = { kind: 'num', values: aligned(section(src, e.values!), Float32Array) };
    else obs[e.name] = { kind: 'str', values: json<string[]>(src, e.values!) };
    order.push(e.name);
  }
  p('Reading embeddings…');
  const embeddings: Embedding[] = header.embeddings.map((e) => ({ name: e.name, dim: e.dim, data: aligned(section(src, e.data), Float32Array) }));
  const layers: LayerInfo[] = [], entries = new Map<string, LayerEntry>();
  for (const l of header.layers) {
    layers.push({ name: l.name, varNames: json<string[]>(src, l.varNames), storage: 'csc', looksLikeCounts: l.looksLikeCounts });
    entries.set(l.name, l);
  }
  let spatial: SpatialInfo | null = null;
  const sm = header.meta.spatial;
  if (sm) {
    const rgb = section(src, sm.rgb), px = sm.width * sm.height, rgba = new Uint8ClampedArray(px * 4);
    for (let i = 0; i < px; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
    spatial = { library: sm.library, imageKey: sm.imageKey, scale: sm.scale, spotDiameter: sm.spotDiameter, width: sm.width, height: sm.height, rgba };
  }
  const sources = new Map<string, ScbSource>();
  return {
    payload: {
      name: header.name || fileName.replace(/\.scb$/i, ''), n, obsNames: json<string[]>(src, header.obsNames), obsOrder: order, obs, embeddings, layers,
      markers: header.markers, meta: { species: header.meta.species, geneLabelCol: header.meta.geneLabelCol, source: 'scb', fileSize: src.size, spatial },
    },
    source(layer) {
      let s = sources.get(layer);
      if (!s) { s = new ScbSource(src, n, entries.get(layer)!); sources.set(layer, s); }
      return s;
    },
  };
}
