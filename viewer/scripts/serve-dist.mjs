// Serve dist/ with the same headers Cloudflare applies (from public/_headers), including HEAD and
// Range so a packed .scb can be opened with ?data= exactly as it is in production.
// Optional: --fixtures exposes ../tests/fixtures at /fixtures; --data DIR serves DIR at /data
// (the local stand-in for the R2 bucket the Worker reads). Local testing only.
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const here = import.meta.dirname, root = resolve(here, '../dist');
const fixtures = process.argv.includes('--fixtures') ? resolve(here, '../../tests/fixtures') : null, port = +(process.env.PORT ?? 4173);
const dataArg = process.argv.indexOf('--data');
const dataDir = dataArg > -1 && process.argv[dataArg + 1] ? resolve(process.argv[dataArg + 1]) : null;
const rules = [];
let cur = null;
for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  if (!line.startsWith(' ')) { const pat = line.trim(); const re = new RegExp('^' + pat.replace(/\*/g, '.*') + '$'); cur = { match: (p) => re.test(p), h: {} }; rules.push(cur); }
  else { const i = line.indexOf(':'); cur.h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]); if (p === '/') p = '/index.html';
  let file = join(root, p);
  if (fixtures && p.startsWith('/fixtures/')) file = join(fixtures, p.slice('/fixtures/'.length));
  if (dataDir && p.startsWith('/data/')) file = join(dataDir, p.slice('/data/'.length));
  const roots = [root, fixtures, dataDir].filter(Boolean);
  if (!roots.some((r) => file.startsWith(r)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  const size = statSync(file).size;
  const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  for (const r of rules) if (r.match(p)) Object.assign(headers, r.h);

  // HEAD: the viewer asks for the size before reading any section of a .scb.
  if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': String(size) }); res.end(); return; }

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m) {
    let start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }   // suffix range
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` });
    createReadStream(file, { start, end }).pipe(res); return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(size) }); createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving dist on http://localhost:${port}${dataDir ? ` (/data -> ${dataDir})` : ''}`));
