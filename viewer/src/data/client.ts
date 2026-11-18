// Promise-based client for the data worker.
import type { DatasetPayload } from './schema';
import type { DeResult, Transform } from './compute';

type Progress = (msg: string, frac?: number) => void;

/** Thrown into every in-flight call when the user cancels. */
export class CancelledError extends Error {
  readonly cancelled = true;
  constructor() { super('Cancelled.'); }
}

export class DataClient {
  private w = this.spawn();
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; prog?: Progress }>();
  onGlobalProgress: Progress | null = null;

  private spawn(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { (p.prog ?? this.onGlobalProgress)?.(m.msg, m.frac); return; }
      this.pending.delete(m.id);
      if (m.type === 'error') { const e = new Error(m.message); (e as any).tooBig = m.tooBig; p.rej(e); } else p.res(m.result);
    };
    return w;
  }

  /**
   * Stop whatever the worker is doing, right now.
   *
   * The worker computes in synchronous loops, so a 'stop' message would sit in its queue
   * until the work it was meant to stop had already finished. Terminating is the only way
   * to actually free the CPU and halt in-flight HTTP reads. The worker loses the open
   * dataset with it, so the caller has to reopen — see App.cancelWork().
   */
  cancel() {
    this.w.terminate();
    const err = new CancelledError();
    for (const p of this.pending.values()) p.rej(err);
    this.pending.clear();
    this.w = this.spawn();
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], prog?: Progress): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res, rej, prog });
      this.w.postMessage({ ...msg, id }, transfer);
    });
  }

  open(file: File, prog?: Progress) { return this.call<DatasetPayload>({ type: 'open', file }, [], prog); }
  openUrl(url: string, prog?: Progress) { return this.call<DatasetPayload>({ type: 'open', url }, [], prog); }
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
