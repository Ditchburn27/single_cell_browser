// Exercises the real httpSource against a strict XMLHttpRequest stub backed by a local .scb,
// so the hosted path (HEAD for size, 206 range reads, error handling) is covered without a socket.
//   SCB=/path/full_umap.scb REF=/path/scb_ref.json npx vitest run tests/http-source.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, openSync, readSync, fstatSync, readFileSync } from 'node:fs';
import { httpSource, readScb } from '../src/data/scb';

const scbPath = process.env.SCB ?? '', refPath = process.env.REF ?? '';
const URL_ = 'http://localhost:8777/data/full_umap.scb';

interface Opts { acceptRanges?: string | null; ignoreRange?: boolean; status?: number }
let opts: Opts = {};
let requests: Array<{ method: string; range: string | null; bytes: number }> = [];

/** Minimal, strict stand-in for the browser object: only what httpSource is allowed to use. */
class FakeXHR {
  private method = ''; private headers: Record<string, string> = {};
  status = 0; response: ArrayBuffer | null = null; responseType = '';
  private resHeaders: Record<string, string> = {};
  open(method: string, url: string, async: boolean) {
    expect(async, 'httpSource must use synchronous XHR (it runs in a worker)').toBe(false);
    expect(url).toBe(URL_);
    this.method = method;
  }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  getResponseHeader(k: string) { return this.resHeaders[k.toLowerCase()] ?? null; }
  send() {
    const fd = openSync(scbPath, 'r'); const size = fstatSync(fd).size;
    if (opts.status) { this.status = opts.status; requests.push({ method: this.method, range: null, bytes: 0 }); return; }
    if (this.method === 'HEAD') {
      this.status = 200;
      this.resHeaders = { 'content-length': String(size) };
      if (opts.acceptRanges !== null) this.resHeaders['accept-ranges'] = opts.acceptRanges ?? 'bytes';
      requests.push({ method: 'HEAD', range: null, bytes: 0 });
      return;
    }
    const range = this.headers['Range'] ?? null;
    expect(range, 'every GET must carry a Range header').toMatch(/^bytes=\d+-\d+$/);
    const [a, b] = range!.slice(6).split('-').map(Number);
    if (opts.ignoreRange) {          // a host with no Range support returns the whole body, 200
      this.status = 200; this.response = new ArrayBuffer(0);
      requests.push({ method: 'GET', range, bytes: size });
      return;
    }
    const len = Math.min(b, size - 1) - a + 1;
    const buf = new Uint8Array(len); readSync(fd, buf, 0, len, a);
    this.status = 206;
    this.resHeaders = { 'content-range': `bytes ${a}-${a + len - 1}/${size}` };
    this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + len);
    requests.push({ method: 'GET', range, bytes: len });
  }
}

describe.skipIf(!existsSync(scbPath) || !existsSync(refPath))('httpSource (hosted .scb over HTTP Range)', () => {
  beforeEach(() => { opts = {}; requests = []; (globalThis as any).XMLHttpRequest = FakeXHR; });

  it('reports the file size from a HEAD request without downloading it', () => {
    const src = httpSource(URL_);
    expect(src.size).toBe(fstatSync(openSync(scbPath, 'r')).size);
    expect(requests).toEqual([{ method: 'HEAD', range: null, bytes: 0 }]);
  });

  it('opens the dataset and reads genes, fetching only the bytes needed', () => {
    const ref = JSON.parse(readFileSync(refPath, 'utf8'));
    const scb = readScb(httpSource(URL_), 'full_umap.scb');
    expect(scb.payload.n).toBe(ref.nCells);
    expect(scb.payload.meta.defaults?.annotation).toBe('Major Cluster');
    expect(scb.payload.meta.defaults?.gene).toBe('RORB');
    const upfront = requests.reduce((a, r) => a + r.bytes, 0);

    const src = scb.source('X');
    requests = [];
    const col = src.readGene(ref.genes['LHX6'].index);
    expect(col.rows.length).toBe(ref.genes['LHX6'].nnz);
    const geneBytes = requests.reduce((a, r) => a + r.bytes, 0);

    process.stdout.write(`RESULT upfront=${(upfront / 1e6).toFixed(2)}MB geneRead=${(geneBytes / 1e3).toFixed(1)}KB of ${(scb.payload.meta.fileSize / 1e6).toFixed(0)}MB\n`);
    expect(upfront).toBeLessThan(15e6);
    expect(geneBytes).toBeLessThan(200e3);
  });

  it('refuses a host that advertises no Range support', () => {
    opts = { acceptRanges: 'none' };
    expect(() => httpSource(URL_)).toThrow(/Range/);
  });

  it('errors clearly when a host ignores Range and returns the whole file', () => {
    opts = { ignoreRange: true };
    const src = httpSource(URL_);
    expect(() => src.read(0, 100)).toThrow(/ignored a Range request/);
  });

  it('surfaces an HTTP error instead of hanging', () => {
    opts = { status: 404 };
    expect(() => httpSource(URL_)).toThrow(/HTTP 404/);
  });

  it('still works when the host omits Accept-Ranges but honours Range', () => {
    opts = { acceptRanges: null };
    const src = httpSource(URL_);
    expect(src.read(0, 4)).toHaveLength(4);
  });
});
