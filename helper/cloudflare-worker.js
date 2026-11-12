// Instant Search download helper — a Cloudflare Worker (free plan is plenty).
//
// Your Instant Search site runs entirely in the browser, and browsers won't let it read files from
// sites like faa.gov directly. This worker fetches the file for it and passes it straight back.
//
// Easiest setup: in Instant Search, open "Add from a web link" -> "Download helper" -> "Copy helper code".
// That copies this code with your own secret key already filled in. Paste it here and deploy.

// Which sites the helper may fetch from. '*' means any site; it needs ACCESS_KEY below, so only you can use it.
// To allow only certain sites instead, list them, e.g. ['faa.gov', 'govinfo.gov'] (subdomains included).
const ALLOWED_SITES = ['*'];

// Your secret key. The app adds it to every request (it's part of the helper address you paste into the app,
// e.g. https://instant-search-helper.you.workers.dev/?key=...). Without it, nobody else can use your helper.
const ACCESS_KEY = '';

// Optional: also only answer requests coming from your own Instant Search site, e.g.
// const ALLOWED_PAGES = ['https://frenchbear1.github.io'];
const ALLOWED_PAGES = [];

const BLOCK_PRIVATE = true; // never fetch from local or private network addresses

const CORS = {
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified, Content-Length, Content-Type, X-Final-Url, X-Helper-Error',
  'Access-Control-Max-Age': '86400',
};

function privateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function allowedSite(hostname) {
  hostname = hostname.toLowerCase();
  if (BLOCK_PRIVATE && privateHost(hostname)) return false;
  if (ALLOWED_SITES.includes('*')) return !!ACCESS_KEY;
  return ALLOWED_SITES.some((s) => hostname === s || hostname.endsWith('.' + s));
}

function corsFor(request) {
  const origin = request.headers.get('Origin') || '';
  const ok = !ALLOWED_PAGES.length || ALLOWED_PAGES.includes(origin);
  return { ...CORS, 'Access-Control-Allow-Origin': ok ? origin || '*' : 'null', Vary: 'Origin' };
}

function refuse(request, message, status = 403) {
  return new Response(message, { status, headers: { ...corsFor(request), 'X-Helper-Error': message, 'Content-Type': 'text/plain' } });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(request) });
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(request, 'Only GET and HEAD are allowed', 405);

    const params = new URL(request.url).searchParams;
    const keyOk = !ACCESS_KEY || params.get('key') === ACCESS_KEY;
    const target = params.get('url');
    if (!target) {
      const state = !keyOk ? (params.get('key') ? ' (key wrong)' : ' (key missing)') : ALLOWED_SITES.includes('*') ? (ACCESS_KEY ? ' (any site)' : ' (needs a key: use Copy helper code in the app)') : ' (listed sites only)';
      return new Response('Instant Search download helper is running.' + state, { headers: { ...corsFor(request), 'Content-Type': 'text/plain' } });
    }
    if (!keyOk) return refuse(request, "The helper's key doesn't match. Paste the full helper address (with ?key=...) into the app.");

    let url;
    try { url = new URL(target); } catch { return refuse(request, "That isn't a valid link", 400); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse(request, 'Only web links can be fetched', 400);
    if (!allowedSite(url.hostname)) {
      if (BLOCK_PRIVATE && privateHost(url.hostname)) return refuse(request, "The helper doesn't fetch from local or private network addresses");
      if (ALLOWED_SITES.includes('*')) return refuse(request, `The helper isn't set up to fetch from ${url.hostname}: it needs its key. Use Copy helper code in the app.`);
      return refuse(request, `The helper isn't set up to fetch from ${url.hostname}. Add it to ALLOWED_SITES in the worker.`);
    }

    const headers = { 'User-Agent': 'Mozilla/5.0 (Instant Search download helper)', Accept: '*/*' };
    for (const h of ['If-None-Match', 'If-Modified-Since']) {
      const v = request.headers.get(h);
      if (v) headers[h] = v;
    }

    let upstream;
    try {
      upstream = await fetch(url.toString(), { method: request.method, headers, redirect: 'follow' });
    } catch (e) {
      return refuse(request, `Couldn't reach ${url.hostname}`, 502);
    }
    // a redirect must not lead somewhere outside the allowed sites
    const finalUrl = upstream.url || url.toString();
    if (!allowedSite(new URL(finalUrl).hostname)) return refuse(request, "The link redirected to a site that isn't allowed");

    const out = new Headers(corsFor(request));
    for (const h of ['Content-Type', 'Content-Length', 'ETag', 'Last-Modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('X-Final-Url', finalUrl);
    out.set('Cache-Control', 'no-store');
    // the body is streamed straight through, so large handbooks work too
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
  },
};
