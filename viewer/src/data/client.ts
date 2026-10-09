// Promise-based client for the data worker.
import type { DatasetPayload } from './schema';
import type { DeResult, Transform } from './compute';

type Progress = (msg: string, frac?: number) => void;

export class DataClient {
  private w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; prog?: Progress }>();
  onGlobalProgress: Progress | null = null;

  constructor() {
    this.w.onmessage = (ev) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { (p.prog ?? this.onGlobalProgress)?.(m.msg, m.frac); return; }
      this.pending.delete(m.id);
      if (m.type === 'error') { const e = new Error(m.message); (e as any).tooBig = m.tooBig; p.rej(e); } else p.res(m.result);
    };
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], prog?: Progress): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res, rej, prog });
      this.w.postMessage({ ...msg, id }, transfer);
    });
  }

  open(file: File, prog?: Progress) { return this.call<DatasetPayload>({ type: 'open', file }, [], prog); }
  prepare(layer: string, prog?: Progress) { return this.call<boolean>({ type: 'prepare', layer }, [], prog); }
  gene(layer: string, gene: number, transform: Transform, prog?: Progress) { return this.call<Float32Array>({ type: 'gene', layer, gene, transform }, [], prog); }
  geneSet(layer: string, genes: number[], transform: Transform, prog?: Progress) { return this.call<Float32Array>({ type: 'geneSet', layer, genes, transform }, [], prog); }
  groupStats(layer: string, genes: number[], codes: ArrayLike<number>, nGroups: number, transform: Transform) {
    return this.call<{ mean: Float32Array; pct: Float32Array; sizes: Float32Array }>({ type: 'groupStats', layer, genes, codes, nGroups, transform });
  }
  de(layer: string, maskA: Uint8Array, maskB: Uint8Array | null, transform: Transform, prog?: Progress) {
    return this.call<DeResult>({ type: 'de', layer, maskA, maskB, transform }, [], prog);
  }
}
