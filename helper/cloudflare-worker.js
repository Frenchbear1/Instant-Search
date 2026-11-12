// Instant Search download helper — a Cloudflare Worker (free plan is plenty).
//
// Your Instant Search site runs entirely in the browser, and browsers won't let it read files from
// sites like faa.gov directly. This worker fetches the file for it and passes it straight back.
//
// It only fetches from the sites listed in ALLOWED_SITES, so nobody else can use it as a general proxy.
// Add any other site you want to link documents from (subdomains are included automatically).

const ALLOWED_SITES = [
  'faa.gov',
  'govinfo.gov', // the official CFR (FARs) PDFs
  'ecfr.gov',
  // 'ntsb.gov',
];

// Optional: only answer requests coming from your own Instant Search site, e.g.
// const ALLOWED_PAGES = ['https://frenchbear1.github.io'];
const ALLOWED_PAGES = [];

const CORS = {
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified, Content-Length, Content-Type, X-Final-Url, X-Helper-Error',
  'Access-Control-Max-Age': '86400',
};

function allowedSite(hostname) {
  hostname = hostname.toLowerCase();
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

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Instant Search download helper is running.', { headers: { ...corsFor(request), 'Content-Type': 'text/plain' } });

    let url;
    try { url = new URL(target); } catch { return refuse(request, "That isn't a valid link", 400); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse(request, 'Only web links can be fetched', 400);
    if (!allowedSite(url.hostname)) return refuse(request, `The helper isn't set up to fetch from ${url.hostname}. Add it to ALLOWED_SITES in the worker.`);

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
