// Downloading documents from websites.
// Browsers only let a page read another site's files when that site allows it (CORS). Many official
// sites don't, so requests fall back to your own "download helper" (a tiny Cloudflare Worker, see
// helper/cloudflare-worker.js), which fetches the file and hands it back.

import { kindOf } from './ingest.js';

const HELPER_KEY = 'instant-search:helper';
const DIRECT_KEY = 'instant-search:direct'; // origin -> true/false, remembers whether direct fetch works

export class NeedsHelper extends Error {
  constructor(url) {
    super('This site doesn’t allow direct downloads. Set up the download helper to link it.');
    this.url = url;
  }
}

export const helper = {
  get() { try { return localStorage.getItem(HELPER_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(HELPER_KEY, v.trim()) : localStorage.removeItem(HELPER_KEY); } catch {} },
};

function directMemory() {
  try { return JSON.parse(localStorage.getItem(DIRECT_KEY)) || {}; } catch { return {}; }
}
function rememberDirect(origin, ok) {
  const m = directMemory();
  m[origin] = ok;
  try { localStorage.setItem(DIRECT_KEY, JSON.stringify(m)); } catch {}
}

function viaHelper(url) {
  const h = helper.get();
  if (!h) return null;
  const u = new URL(h);
  u.searchParams.set('url', url);
  return u.toString();
}

/** fetch() a remote URL, directly when the site allows it, otherwise through the helper. */
export async function remoteFetch(url, { method = 'GET', headers = {}, signal } = {}) {
  if (navigator.onLine === false) throw new Error('you’re offline');
  const origin = new URL(url).origin;
  const known = directMemory()[origin];
  if (known !== false) {
    try {
      const res = await fetch(url, { method, headers, signal, mode: 'cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (known === undefined) rememberDirect(origin, true);
      return { res, finalUrl: res.url || url };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      rememberDirect(origin, false); // blocked by the site (or offline); use the helper from now on
    }
  }
  const proxied = viaHelper(url);
  if (!proxied) throw new NeedsHelper(url);
  const res = await fetch(proxied, { method, headers, signal, cache: 'no-store' });
  if (res.status === 403 && res.headers.get('X-Helper-Error')) throw new Error(res.headers.get('X-Helper-Error'));
  return { res, finalUrl: res.headers.get('X-Final-Url') || url };
}

function infoFrom(res, finalUrl) {
  const len = Number(res.headers.get('Content-Length'));
  return {
    status: res.status,
    etag: res.headers.get('ETag') || '',
    lastModified: res.headers.get('Last-Modified') || '',
    size: Number.isFinite(len) && len > 0 ? len : 0,
    type: (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(),
    finalUrl,
  };
}

/** Headers only (size, date, version tag). Falls back to a GET that's cancelled straight away. */
export async function remoteInfo(url) {
  try {
    const { res, finalUrl } = await remoteFetch(url, { method: 'HEAD' });
    if (res.ok) return infoFrom(res, finalUrl);
  } catch (e) {
    if (e instanceof NeedsHelper) throw e;
  }
  const ctl = new AbortController();
  const { res, finalUrl } = await remoteFetch(url, { signal: ctl.signal });
  const info = infoFrom(res, finalUrl);
  ctl.abort();
  return info;
}

/**
 * Has this file changed since we saved it? Uses the site's version tag (ETag) and date when it gives them,
 * otherwise the file size. Returns { changed: true|false|null (can't tell), info }.
 */
export async function remoteChanged(url, known = {}) {
  const headers = {};
  if (known.etag) headers['If-None-Match'] = known.etag;
  if (known.lastModified) headers['If-Modified-Since'] = known.lastModified;
  let info;
  try {
    const { res, finalUrl } = await remoteFetch(url, { method: 'HEAD', headers });
    if (res.status === 304) return { changed: false, info: { ...known, status: 304 } };
    if (!res.ok) return { changed: null, info: infoFrom(res, finalUrl), error: `the site answered ${res.status}` };
    info = infoFrom(res, finalUrl);
  } catch (e) {
    if (e instanceof NeedsHelper) throw e;
    info = await remoteInfo(url);
  }
  if (known.etag && info.etag) return { changed: known.etag !== info.etag, info };
  if (known.lastModified && info.lastModified) return { changed: known.lastModified !== info.lastModified, info };
  if (known.size && info.size) return { changed: known.size !== info.size, info };
  return { changed: null, info }; // nothing to compare: download to be sure
}

/** Download the whole file. onProgress(fraction) when the size is known. */
export async function download(url, onProgress) {
  const { res, finalUrl } = await remoteFetch(url);
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  const info = infoFrom(res, finalUrl);
  let bytes;
  if (res.body && info.size && onProgress) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(1, got / info.size));
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    bytes = out.buffer;
  } else {
    bytes = await res.arrayBuffer();
  }
  info.size = bytes.byteLength;
  return { bytes, info, name: fileNameFor(finalUrl || url, info.type) };
}

const TYPE_EXT = { 'application/pdf': 'pdf', 'text/html': 'html', 'text/plain': 'txt', 'text/markdown': 'md', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/rtf': 'rtf', 'text/csv': 'csv' };

export function fileNameFor(url, type) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch {}
  if (!name) { try { name = new URL(url).hostname; } catch { name = 'download'; } }
  if (!kindOf(name)) {
    const ext = TYPE_EXT[type];
    if (ext) name += '.' + ext;
  }
  return name;
}

/** Is this URL (or response type) a document we can read, rather than a web page listing documents? */
export function looksLikeDocument(url, type) {
  if (type && type !== 'text/html' && TYPE_EXT[type]) return true;
  try { const k = kindOf(new URL(url).pathname); return !!k && k !== 'html'; } catch { return false; }
}

/** All links to readable documents on a web page, with their link text. */
export function documentLinks(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set();
  const out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(a.getAttribute('href'), baseUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const k = kindOf(url.pathname);
    if (!k || k === 'html') continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    // the size the page itself shows next to the link, if any ("22 MB")
    const around = (a.parentElement?.textContent || '').replace(/\s+/g, ' ');
    const m = around.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB)\b/i);
    const shownSize = m ? Math.round(Number(m[1]) * { KB: 1024, MB: 1048576, GB: 1073741824 }[m[2].toUpperCase()]) : 0;
    out.push({ url: href, text: text || fileNameFor(href), shownSize });
  }
  return { links: out, title: (doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim() };
}

/** "faa-h-8083-25c.pdf" and "FAA-H-8083-25D.pdf" are editions of the same thing. */
export function editionKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/\s*\(\d+\)$/, '')            // "file (1)"
    .replace(/[\s_-]*(19|20)\d{2}$/, '')    // trailing year
    .replace(/(\d)[a-z]$/, '$1')            // trailing edition letter after a number
    .replace(/[^a-z0-9]+/g, '');
}

/** Link text without anything that looks like a size or date, for matching a renamed file. */
export function linkKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\(?\d+(\.\d+)?\s*(kb|mb|gb)\)?/g, '')
    .replace(/\(pdf\)|pdf/g, '')
    .replace(/[^a-z0-9]+/g, '');
}
