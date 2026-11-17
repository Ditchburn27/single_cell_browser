// @vitest-environment jsdom
// Cancelling must actually stop the worker, not just stop listening to it: the worker
// computes in synchronous loops, so an unterminated one keeps burning CPU (and, for a
// hosted dataset, keeps issuing HTTP reads) long after the UI has moved on.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const spawned: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: any[] = [];
  terminated = false;
  constructor() { spawned.push(this); }
  postMessage(m: any) { this.posted.push(m); }
  terminate() { this.terminated = true; }
}

let DataClient: typeof import('../src/data/client').DataClient;

beforeEach(async () => {
  spawned.length = 0;
  vi.stubGlobal('Worker', FakeWorker);
  ({ DataClient } = await import('../src/data/client'));
});

describe('cancelling work', () => {
  it('terminates the worker that was running', () => {
    const c = new DataClient();
    expect(spawned).toHaveLength(1);
    c.cancel();
    expect(spawned[0].terminated).toBe(true);
  });

  it('rejects every in-flight call, flagged as cancelled rather than failed', async () => {
    const c = new DataClient();
    const a = c.prepare('X');
    const b = c.gene('X', 7, 'none');
    c.cancel();
    for (const p of [a, b]) {
      await expect(p).rejects.toMatchObject({ cancelled: true });
    }
  });

  it('spawns a replacement so the app keeps working afterwards', () => {
    const c = new DataClient();
    c.cancel();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].terminated).toBe(false);
    c.prepare('X');
    expect(spawned[1].posted).toHaveLength(1);       // routed to the new worker
    expect(spawned[0].posted).toHaveLength(0);
  });

  it('drops replies from the terminated worker instead of resolving stale work', async () => {
    const c = new DataClient();
    const pending = c.prepare('X');
    const id = (spawned[0].posted[0] as { id: number }).id;
    c.cancel();
    await expect(pending).rejects.toMatchObject({ cancelled: true });
    // a late message from the old worker must not resolve anything
    expect(() => spawned[0].onmessage?.({ data: { id, type: 'result', result: true } })).not.toThrow();
  });
});
