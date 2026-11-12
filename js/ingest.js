// Turns uploaded files into an array of page texts.
import { extractPdf } from './pdf.js';

const PAGE_CHARS = 3000;

export const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.log,.html,.htm,.xml,.rtf,.srt,.vtt,.yaml,.yml,.ini';

export function kindOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'rtf') return 'rtf';
  if (ACCEPT.split(',').includes('.' + ext)) return 'txt';
  return null;
}

function clean(text) {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

// Split flowing text into page-sized chunks, preferring paragraph breaks.
export function paginate(text) {
  text = clean(text).trim();
  if (!text) return [''];
  const lines = text.split('\n');
  const pages = [];
  let cur = [];
  let len = 0;
  const flush = () => {
    if (cur.length) pages.push(cur.join('\n').replace(/^\n+|\n+$/g, ''));
    cur = [];
    len = 0;
  };
  for (let line of lines) {
    while (line.length > PAGE_CHARS * 1.3) {
      // giant single paragraph: cut at a sentence or space near the target size
      const room = Math.max(PAGE_CHARS - len, 400);
      let cut = line.lastIndexOf('. ', room);
      if (cut < room * 0.5) cut = line.lastIndexOf(' ', room);
      if (cut < room * 0.3) cut = room;
      cur.push(line.slice(0, cut + 1));
      line = line.slice(cut + 1).replace(/^ +/, '');
      flush();
    }
    const blank = !line.trim();
    if (len >= PAGE_CHARS * 0.85 && blank) { flush(); continue; }
    if (len + line.length > PAGE_CHARS * 1.25 && len > PAGE_CHARS * 0.4) flush();
    if (blank && !cur.length) continue;
    cur.push(line);
    len += line.length + 1;
  }
  flush();
  return pages.length ? pages : [''];
}

let mammothLoading;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  mammothLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mammoth.browser.min.js';
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => { mammothLoading = null; reject(new Error('Could not load the Word reader')); };
    document.head.append(s);
  });
  return mammothLoading;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,template').forEach((n) => n.remove());
  const blocks = 'p,div,section,article,header,footer,li,tr,h1,h2,h3,h4,h5,h6,pre,blockquote,br,hr,table,ul,ol,dt,dd';
  doc.querySelectorAll(blocks).forEach((n) => n.after(doc.createTextNode('\n')));
  doc.querySelectorAll('td,th').forEach((n) => n.after(doc.createTextNode('\t')));
  return (doc.body?.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

/** Returns { pages, kind, bytes? } — bytes kept for PDFs and HTML so the original can be shown. */
export async function readFile(file, onProgress) {
  const kind = kindOf(file.name);
  if (!kind) throw new Error('Unsupported file type');
  if (kind === 'pdf') {
    const bytes = await file.arrayBuffer();
    const pages = await extractPdf(bytes, onProgress);
    return { kind, pages, bytes };
  }
  if (kind === 'docx') {
    const mammoth = await loadMammoth();
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { kind, pages: paginate(value) };
  }
  const raw = await file.text();
  if (kind === 'html') return { kind, pages: paginate(htmlToText(raw)), bytes: raw }; // raw kept for the Original view
  if (kind === 'rtf') return { kind, pages: paginate(rtfToText(raw)) };
  return { kind, pages: paginate(raw) };
}
