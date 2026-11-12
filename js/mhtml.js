// "Webpage, Single File" saves (.mhtml / .mht): a MIME bundle of the page plus every image, style sheet
// and font it used. This turns one into a single self-contained HTML file (resources become data: URLs),
// so the Original view shows the page exactly as it was saved, even offline.

function qpDecode(s) {
  const out = [];
  s = s.replace(/=\r?\n/g, ''); // soft line breaks
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}
function b64Decode(s) {
  const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function headersOf(block) {
  const h = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) h[m[1].toLowerCase()] = m[2].trim();
  }
  return h;
}
const param = (value, name) => (String(value || '').match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i')) || [])[1] || '';

export function isMhtml(text) {
  return /^\s*(From:|Snapshot-Content-Location:|Subject:|Date:|MIME-Version:)/im.test(text.slice(0, 2000)) && /multipart\/related/i.test(text.slice(0, 4000));
}

/** Returns { html, url } — the page as one HTML string, and the address it was saved from. */
export function mhtmlToHtml(text) {
  const split = text.search(/\r?\n\r?\n/);
  const top = headersOf(text.slice(0, split));
  const boundary = param(top['content-type'], 'boundary');
  if (!boundary) throw new Error('this .mhtml file has no parts');
  const parts = [];
  for (const chunk of text.split('--' + boundary).slice(1)) {
    if (/^--/.test(chunk)) break; // closing boundary
    const at = chunk.search(/\r?\n\r?\n/);
    if (at < 0) continue;
    const h = headersOf(chunk.slice(0, at));
    const body = chunk.slice(at).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    const enc = (h['content-transfer-encoding'] || '').toLowerCase();
    const bytes = enc === 'base64' ? b64Decode(body) : enc === 'quoted-printable' ? qpDecode(body) : Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
    const type = (h['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    parts.push({ type, charset: param(h['content-type'], 'charset') || 'utf-8', loc: h['content-location'] || '', cid: (h['content-id'] || '').replace(/^<|>$/g, ''), bytes });
  }
  const main = parts.find((p) => p.type === 'text/html') || parts[0];
  if (!main) throw new Error('this .mhtml file has no page in it');
  const decode = (p) => { try { return new TextDecoder(p.charset).decode(p.bytes); } catch { return new TextDecoder().decode(p.bytes); } };

  // every saved resource, by the address the page used for it
  const map = new Map();
  const others = parts.filter((p) => p !== main);
  const swap = (s) => {
    for (const [from, to] of map) {
      if (!from) continue;
      if (s.includes(from)) s = s.split(from).join(to);
      const amp = from.replace(/&/g, '&amp;');
      if (amp !== from && s.includes(amp)) s = s.split(amp).join(to);
    }
    return s;
  };
  // images, fonts and the like first, then style sheets (which point at them), then frames
  const rank = (p) => (p.type === 'text/css' ? 1 : p.type === 'text/html' ? 2 : 0);
  for (const p of others.sort((a, b) => rank(a) - rank(b))) {
    let uri;
    if (p.type === 'text/css' || p.type === 'text/html') {
      const t = swap(decode(p));
      uri = `data:${p.type};charset=utf-8;base64,${b64Encode(new TextEncoder().encode(t))}`;
    } else {
      uri = `data:${p.type};base64,${b64Encode(p.bytes)}`;
    }
    if (p.loc) map.set(p.loc, uri);
    if (p.cid) map.set('cid:' + p.cid, uri);
  }
  let html = swap(decode(main));
  // the saved page keeps its original address for anything that wasn't saved
  const url = main.loc || top['snapshot-content-location'] || '';
  return { html, url };
}
