// The dev server must answer HEAD and Range the way the viewer's httpSource expects:
// a HEAD for the size, then 206 responses for each section and gene block.
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '../dist');
let handler: any;
let dataDir: string;
const BODY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'scb-'));
  writeFileSync(join(dataDir, 'x.scb'), BODY);
  const realCreate = http.createServer;
  (http as any).createServer = (h: any) => { handler = h; return { listen: (_p: number, cb?: () => void) => { cb?.(); return {}; } }; };
  process.argv = [...process.argv.slice(0, 2), '--data', dataDir];
  await import('../scripts/serve-dist.mjs');
  (http as any).createServer = realCreate;
});

function call(method: string, url: string, range?: string): Promise<{ status: number; headers: any; body: Buffer }> {
  return new Promise((done) => {
    const res: any = new PassThrough();
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done({ status: res.statusCode, headers: res.headers ?? {}, body: Buffer.concat(chunks) }));
    res.writeHead = (c: number, h: any) => { res.statusCode = c; res.headers = h; return res; };
    handler({ method, url, headers: range ? { range } : {} }, res);
  });
}

describe.skipIf(!existsSync(join(DIST, '_headers')))('dev server range support', () => {
  it('HEAD returns the size and advertises ranges, with no body', async () => {
    const r = await call('HEAD', '/data/x.scb');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Length']).toBe('256');
    expect(r.headers['Accept-Ranges']).toBe('bytes');
    expect(r.body.length).toBe(0);
  });

  it('a range request returns 206 with exactly those bytes', async () => {
    const r = await call('GET', '/data/x.scb', 'bytes=10-19');
    expect(r.status).toBe(206);
    expect(r.headers['Content-Range']).toBe('bytes 10-19/256');
    expect(Array.from(r.body)).toEqual(Array.from(BODY.subarray(10, 20)));
  });

  it('an open-ended range runs to the last byte', async () => {
    const r = await call('GET', '/data/x.scb', 'bytes=250-');
    expect(r.status).toBe(206);
    expect(r.headers['Content-Range']).toBe('bytes 250-255/256');
    expect(r.body.length).toBe(6);
  });

  it('a suffix range returns the tail (the .scb footer is read this way)', async () => {
    const r = await call('GET', '/data/x.scb', 'bytes=-12');
    expect(r.status).toBe(206);
    expect(r.headers['Content-Range']).toBe('bytes 244-255/256');
    expect(Array.from(r.body)).toEqual(Array.from(BODY.subarray(244)));
  });

  it('an unsatisfiable range is refused with 416', async () => {
    const r = await call('GET', '/data/x.scb', 'bytes=999-1200');
    expect(r.status).toBe(416);
    expect(r.headers['Content-Range']).toBe('bytes */256');
  });

  it('no Range header still serves the whole file', async () => {
    const r = await call('GET', '/data/x.scb');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(256);
  });

  it('paths outside the served roots are refused', async () => {
    const r = await call('GET', '/data/../../../etc/passwd');
    expect(r.status).toBe(404);
  });
});
