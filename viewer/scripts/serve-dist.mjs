// Serve dist/ with the same headers Cloudflare Pages will apply (from public/_headers). Optional: --fixtures exposes ../tests/fixtures at /fixtures (for local testing only).
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const here = import.meta.dirname, root = resolve(here, '../dist');
const fixtures = process.argv.includes('--fixtures') ? resolve(here, '../../tests/fixtures') : null, port = +(process.env.PORT ?? 4173);
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
  if (!file.startsWith(root) && !(fixtures && file.startsWith(fixtures)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': String(statSync(file).size) };
  for (const r of rules) if (r.match(p)) Object.assign(headers, r.h);
  res.writeHead(200, headers); createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving dist on http://localhost:${port}`));
