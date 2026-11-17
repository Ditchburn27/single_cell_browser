/**
 * Serves the packed .scb datasets out of R2 at /data/<key>, and hands everything else to the
 * static assets (the built viewer).
 *
 * The viewer reads a .scb with HTTP Range requests — a HEAD for the size, then one range read
 * per section and per gene — so range support here is not an optimisation, it is the contract.
 * Serving the data from the Worker's own origin also keeps the Content-Security-Policy in
 * public/_headers (`connect-src 'self'`) unchanged.
 */

const PREFIX = '/data/';

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return env.ASSETS.fetch(request);

    const key = decodeURIComponent(url.pathname.slice(PREFIX.length));
    if (!key || key.includes('..')) return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });

    // HEAD: size and range support only — the viewer asks for this before anything else.
    if (request.method === 'HEAD') {
      const meta = await env.DATA.head(key);
      if (!meta) return notFound();
      const headers = new Headers();
      meta.writeHttpMetadata(headers);
      headers.set('content-length', String(meta.size));
      headers.set('accept-ranges', 'bytes');
      headers.set('etag', meta.httpEtag);
      headers.set('cache-control', 'public, max-age=3600');
      return new Response(null, { status: 200, headers });
    }

    const object = await env.DATA.get(key, { range: request.headers, onlyIf: request.headers });
    if (!object) return notFound();

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', 'public, max-age=3600');

    // `body` is absent when onlyIf turned this into a conditional miss (304).
    if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });

    const ranged = object.range && 'offset' in object.range;
    if (ranged) {
      const { offset, length } = object.range;
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set('content-length', String(length));
    } else {
      headers.set('content-length', String(object.size));
    }
    return new Response(object.body, { status: ranged ? 206 : 200, headers });
  },
};
