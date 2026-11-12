import { compile, MODES } from './search.js';
import { store } from './store.js';
import { readFile, kindOf, ACCEPT } from './ingest.js';
import { getPdf, closePdf, renderPdfPage, EXTRACTOR_VERSION } from './pdf.js';
import { renderHtmlPage, forgetHtml } from './htmlview.js';
import { comboFromEvent, comboLabel, worksWhileTyping, isMac } from './keys.js';

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const fmt = (n) => n.toLocaleString();
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const KIND_LABEL = { pdf: 'PDF', docx: 'DOC', txt: 'TXT', md: 'MD', html: 'HTML', rtf: 'RTF' };
const I = {
  arrowLeft: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 21.5v0A2.5 2.5 0 0 1 6.5 19H19"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 10h14M5 14h14M5 18h9"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  fitW: '<svg viewBox="0 0 24 24"><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg>',
  fitP: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="1.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M15 12H4M8 8l-4 4 4 4M14 5h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-5"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
};

// ---------- preferences ----------
const PREF_KEY = 'instant-search:prefs';
const prefs = Object.assign(
  { mode: 'all', matchCase: false, wholeWord: false, near: 8, sort: 'library', view: 'text', theme: 'auto', q: '', zoom: 1, compact: false, sideHidden: false, keys: {} },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })()
);
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

// ---------- state ----------
const S = {
  docs: [],            // metadata, library order
  folders: [],         // { id, name, order, collapsed }
  texts: new Map(),    // docId -> page texts
  matcher: null,
  error: null,
  terms: [],
  pxPerChar: 0.3,
  pageAspect: 1.294,
};

// A view is one scrolling list of documents/pages: the compiled results, or one whole document.
function makeView(root, kind) {
  return { root, kind, docId: null, list: [], info: new Map(), total: 0, cur: -1, navY: null, scrollY: 0, revealed: new Map(), pageEls: new Map(), dirty: true };
}
const results = makeView($('#results'), 'results');
const reader = makeView($('#reader'), 'reader');
let active = results;

const q = $('#q');
const docById = (id) => S.docs.find((d) => d.id === id);
const folderById = (id) => S.folders.find((f) => f.id === id);
const folderOf = (d) => (d.folderId && folderById(d.folderId)) || null;
// Library order: each folder's documents in folder order, then documents not in a folder.
function orderedDocs() {
  const by = new Map(S.folders.map((f) => [f.id, []]));
  const loose = [];
  for (const d of S.docs) (by.get(d.folderId) || loose).push(d);
  return [...S.folders.flatMap((f) => by.get(f.id)), ...loose];
}
const pkey = (docId, n) => `${docId}:${n}`;
// A group is one section: a whole document, or (when ranking pages) a single hit page and the pages opened around it.
const groupKey = (R, doc) => (R?.flat ? pkey(doc.id, R.pages[0].n) : doc.id);
const searchable = (d) => !d.status;

// ---------- searching ----------
function computeHits(docs) {
  const list = [];
  if (S.matcher) {
    for (const doc of docs) {
      const pages = S.texts.get(doc.id);
      if (!pages) continue;
      const hp = [];
      for (let n = 0; n < pages.length; n++) {
        const r = S.matcher.match(pages[n]);
        if (r) hp.push({ n, ranges: r });
      }
      if (hp.length) list.push({ doc, pages: hp, hits: hp.reduce((a, p) => a + p.ranges.length, 0) });
    }
  }
  return list;
}

function assign(v, list) {
  if (v.kind === 'results' && prefs.sort === 'hits') list.sort((a, b) => b.hits - a.hits);
  if (v.kind === 'results' && prefs.sort === 'pages') {
    // every hit page from every document, ranked by how many hits it has
    const flat = [];
    list.forEach((R, di) => R.pages.forEach((p) => flat.push({ doc: R.doc, pages: [p], hits: p.ranges.length, flat: true, di })));
    flat.sort((a, b) => b.hits - a.hits || a.di - b.di || a.pages[0].n - b.pages[0].n);
    list = flat;
  }
  v.list = list;
  v.byKey = new Map(list.map((R) => [groupKey(R, R.doc), R]));
  v.info.clear();
  let h = 0;
  for (const R of list) {
    R.hitStart = h;
    for (const p of R.pages) { p.h0 = h; h += p.ranges.length; v.info.set(pkey(R.doc.id, p.n), p); }
  }
  v.total = h;
  v.cur = -1;
  v.navY = null;
}

function runSearch({ keepScroll = false } = {}) {
  prefs.q = q.value;
  savePrefs();
  const m = compile(q.value, prefs);
  S.error = m?.error || null;
  S.matcher = m && !m.error ? m : null;
  S.terms = S.matcher ? S.matcher.terms : [];

  assign(results, computeHits(orderedDocs().filter((d) => d.enabled && searchable(d))));
  results.revealed.clear();
  results.dirty = true;
  if (active === results) renderView(results, { keepScroll });

  if (reader.docId) {
    const doc = docById(reader.docId);
    assign(reader, doc ? computeHits([doc]) : []);
    if (active === reader) refreshInPlace(reader);
    else reader.dirty = true;
  }
  updateChrome();
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  let chars = 0;
  for (const p of S.texts.values()) chars += p.length * 3000;
  searchTimer = setTimeout(runSearch, chars > 6e6 ? 260 : 110);
}

// ---------- text rendering ----------
// PDF lines are joined back into paragraphs for reading. Same-length substitution keeps offsets valid.
function reflow(text) {
  const lines = text.split('\n');
  let max = 0;
  for (const l of lines) if (l.length > max) max = l.length;
  const min = Math.max(30, max * 0.6);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out += line;
    if (i === lines.length - 1) break;
    const next = lines[i + 1];
    const t = line.trimEnd();
    const join =
      t && next.trim() && line.length >= min && !/[:;]$/.test(t) &&
      !/^\s*([•●▪◦‣\-–—*]|\(?\d{1,3}[.)]|\(?[a-z][.)]\s)/i.test(next);
    out += join ? (/\p{L}-$/u.test(t) && /^\p{Ll}/u.test(next) ? '​' : ' ') : '\n';
  }
  return out;
}

function markup(text, ranges) {
  let html = '';
  let pos = 0;
  for (const [s, e, c, h] of ranges) {
    if (s < pos) continue;
    html += esc(text.slice(pos, s));
    html += h != null
      ? `<mark class="m c${c}" data-h="${h}">${esc(text.slice(s, e))}</mark>`
      : `<mark class="s c${c}">${esc(text.slice(s, e))}</mark>`;
    pos = e;
  }
  return html + esc(text.slice(pos));
}

function pageRanges(v, docId, n, text, ctx) {
  const info = ctx ? null : v.info.get(pkey(docId, n));
  if (info) return info.ranges.map((r, i) => [r[0], r[1], r[2], info.h0 + i]);
  return S.matcher ? S.matcher.soft(text).map((r) => [r[0], r[1], r[2], null]) : [];
}

// ---------- page cards ----------
const override = new Map(); // per-page Text/Original choice
// PDFs keep their file; HTML files added from now on keep their source too
const hasOriginal = (doc) => doc.kind === 'pdf' || (doc.kind === 'html' && !!doc.hasOriginal);
function pageMode(doc, n) {
  if (!hasOriginal(doc)) return 'text';
  const o = override.get(pkey(doc.id, n));
  if (o) return o;
  // a PDF page with no extractable text (a scan) is only useful as the original
  if (doc.kind === 'pdf' && !(S.texts.get(doc.id)?.[n] || '').trim()) return 'original';
  return prefs.view;
}
const HTML_FRAME_H = () => Math.round(Math.min(innerHeight * 0.78, 1000));

// Which highlighted match (counting through the whole document) a page's first hit is, for the HTML view.
function htmlOrdinal(doc, n, ranges) {
  if (!S.matcher) return 0;
  const pages = S.texts.get(doc.id) || [];
  let before = 0;
  for (let m = 0; m < n; m++) before += S.matcher.soft(pages[m]).length;
  if (!ranges.length) return before;
  const within = S.matcher.soft(pages[n] || '').findIndex((r) => r[0] === ranges[0][0]);
  return before + Math.max(0, within);
}

function estimate(doc, n) {
  const z = zoomValue();
  if (pageMode(doc, n) === 'original') return doc.kind === 'html' ? HTML_FRAME_H() + 44 : Math.round(BASE_W * z * S.pageAspect) + 56;
  const chars = (S.texts.get(doc.id)?.[n] || '').length;
  return Math.max(150, Math.round(chars * S.pxPerChar * z) + 80);
}

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const art = e.target;
      if (e.isIntersecting) fill(art);
      else if (art._cleanup && Math.abs(e.boundingClientRect.top) > innerHeight * 4) unfill(art);
    }
  },
  { rootMargin: '1400px 0px' }
);
const ioFar = new IntersectionObserver(
  (entries) => { for (const e of entries) if (!e.isIntersecting && e.target._cleanup) unfill(e.target); },
  { rootMargin: '5000px 0px' }
);

function headHtml(v, doc, n, ctx) {
  const info = v.info.get(pkey(doc.id, n));
  const count = S.texts.get(doc.id)?.length || 0;
  let badge = '';
  if (info && ctx) badge = `<span class="phits none">${plural(info.ranges.length, 'hit')} · ranked on its own</span>`;
  else if (info) badge = `<span class="phits">${plural(info.ranges.length, 'hit')}</span>`;
  else if (v.kind === 'results') badge = '<span class="phits none">No hits</span>';
  const mode = pageMode(doc, n);
  const toggle = hasOriginal(doc)
    ? `<button class="chip-btn" data-act="pmode" title="Switch between extracted text and the original page">${mode === 'original' ? I.text + 'Text' : I.image + 'Original'}</button>`
    : '';
  const open = v.kind === 'results'
    ? `<button class="chip-btn" data-act="open" title="Read the whole document from this page">${I.book}Open</button>`
    : '';
  return `<span class="pno">Page ${n + 1}<span class="of"> / ${count}</span></span>${badge}<span class="grow"></span>${toggle}${open}`;
}

function pageEl(v, doc, n, R) {
  const ctx = !!(R?.flat && n !== R.pages[0].n); // a neighbouring page opened for context
  const info = ctx ? null : v.info.get(pkey(doc.id, n));
  const art = el('article', `page${info ? ' hit' : ''}${!info && v.kind === 'results' ? ' extra' : ''}`);
  art.dataset.doc = doc.id;
  art.dataset.n = n;
  art._v = v;
  art._ctx = ctx;
  const head = el('header', 'page-head', headHtml(v, doc, n, ctx));
  const body = el('div', 'page-body');
  body.style.height = estimate(doc, n) + 'px';
  art.append(head, body);
  v.pageEls.set(ctx ? `${pkey(doc.id, n)}@${groupKey(R, doc)}` : pkey(doc.id, n), art);
  io.observe(art);
  ioFar.observe(art);
  return art;
}

function fill(art) {
  if (art._filled) return art._filled;
  const v = art._v;
  const doc = docById(art.dataset.doc);
  const n = Number(art.dataset.n);
  const body = art.lastElementChild;
  if (!doc) return Promise.resolve();
  const text = S.texts.get(doc.id)?.[n] || '';
  const ranges = pageRanges(v, doc.id, n, text, art._ctx);
  const token = (art._token = (art._token || 0) + 1);

  art._filled = (async () => {
    if (pageMode(doc, n) === 'original' && doc.kind === 'html') {
      body.classList.add('loading');
      try {
        const cleanup = await renderHtmlPage({
          docId: doc.id, n, pageCount: S.texts.get(doc.id)?.length || 1, host: body,
          matcher: S.matcher, ordinal: htmlOrdinal(doc, n, ranges), zoom: zoomValue(),
        });
        if (token !== art._token) { cleanup(); return; }
        art._cleanup = cleanup;
      } catch (err) {
        body.innerHTML = `<p class="empty-page">${I.warn}<span>Couldn’t show the original (${esc(err.message)}).</span></p>`;
      }
      body.classList.remove('loading');
    } else if (pageMode(doc, n) === 'original') {
      body.classList.add('loading');
      try {
        const pdf = await getPdf(doc.id, () => store.file(doc.id));
        if (token !== art._token) return;
        const cleanup = await renderPdfPage(pdf, n, body, ranges, BASE_W * zoomValue());
        if (token !== art._token) { cleanup(); return; }
        art._cleanup = cleanup;
        const fr = body.querySelector('.pdf-frame');
        if (fr) S.pageAspect = fr.offsetHeight / fr.offsetWidth || S.pageAspect;
      } catch (err) {
        body.innerHTML = `<p class="empty-page">${I.warn}<span>Couldn’t show the original page (${esc(err.message)}).</span></p>`;
      }
      body.classList.remove('loading');
    } else {
      const display = doc.kind === 'pdf' ? reflow(text) : text;
      body.innerHTML = text.trim()
        ? `<div class="page-text">${markup(display, ranges)}</div>`
        : `<p class="empty-page">No text on this page${doc.kind === 'pdf' ? ' — it may be a scan or picture. Switch to <b>Original</b> to see it.' : '.'}</p>`;
    }
    body.style.height = '';
    if (pageMode(doc, n) === 'text' && text.length > 600) {
      const ratio = (body.offsetHeight - 40) / text.length / zoomValue();
      if (ratio > 0.05 && ratio < 2) S.pxPerChar = S.pxPerChar * 0.8 + ratio * 0.2;
    }
    if (v.cur >= 0) markCurrent(v);
  })();
  return art._filled;
}

function unfill(art) {
  const body = art.lastElementChild;
  body.style.height = body.offsetHeight + 'px';
  art._cleanup?.();
  art._cleanup = null;
  art._filled = null;
  art._token = (art._token || 0) + 1;
  body.replaceChildren();
}

function refill(art) {
  const v = art._v;
  const doc = docById(art.dataset.doc);
  if (!doc) return;
  const n = Number(art.dataset.n);
  const info = art._ctx ? null : v.info.get(pkey(doc.id, n));
  art.classList.toggle('hit', !!info);
  art.firstElementChild.innerHTML = headHtml(v, doc, n, art._ctx);
  const wasFilled = !!art._filled;
  const body = art.lastElementChild;
  const h = body.offsetHeight;
  art._cleanup?.();
  art._cleanup = null;
  art._filled = null;
  art._token = (art._token || 0) + 1;
  if (wasFilled) {
    body.style.height = h + 'px'; // hold the space while redrawing
    fill(art);
  } else {
    body.style.height = estimate(doc, n) + 'px';
  }
}

// ---------- gaps between hit pages ----------
function visiblePages(v, doc, R) {
  const count = S.texts.get(doc.id)?.length || 0;
  if (v.kind === 'reader') return Array.from({ length: count }, (_, i) => i);
  const set = new Set(R ? R.pages.map((p) => p.n) : []);
  for (const n of v.revealed.get(groupKey(R, doc)) || []) set.add(n);
  return [...set].sort((a, b) => a - b);
}

function gapEl(doc, a, b, count, R) {
  const hidden = b - a - 1;
  const g = el('div', 'gap');
  g.dataset.doc = doc.id;
  g.dataset.key = groupKey(R, doc);
  g._R = R;
  g.dataset.a = a;
  g.dataset.b = b;
  const label = a < 0 ? `${plural(hidden, 'page')} before` : b >= count ? `${plural(hidden, 'more page')}` : R?.flat ? plural(hidden, 'page') : `${plural(hidden, 'page')} without hits`;
  let html = '';
  if (hidden === 1) {
    html = `<span class="gap-label">${label}</span><button class="gap-btn" data-act="all">Show page ${a + 2}</button>`;
  } else {
    if (a >= 0) html += `<button class="gap-btn" data-act="after" title="Show the page right after">${I.down}Page ${a + 2}</button>`;
    html += `<span class="gap-label">${label}</span>`;
    if (b < count) html += `<button class="gap-btn" data-act="before" title="Show the page right before">${I.up}Page ${b}</button>`;
    html += `<button class="gap-btn subtle" data-act="all">Show all ${fmt(hidden)}</button>`;
  }
  g.innerHTML = `<div class="gap-inner">${html}</div>`;
  return g;
}

function nodesBetween(v, doc, vis, a, b, R) {
  const count = S.texts.get(doc.id)?.length || 0;
  const nodes = [];
  let prev = a;
  for (const n of vis) {
    if (n <= a || n >= b) continue;
    if (n > prev + 1) nodes.push(gapEl(doc, prev, n, count, R));
    nodes.push(pageEl(v, doc, n, R));
    prev = n;
  }
  if (b > prev + 1) nodes.push(gapEl(doc, prev, b, count, R));
  return nodes;
}

function onGap(g, act) {
  const v = active;
  const doc = docById(g.dataset.doc);
  if (!doc) return;
  const a = Number(g.dataset.a);
  const b = Number(g.dataset.b);
  const R = g._R;
  const key = g.dataset.key;
  if (!v.revealed.has(key)) v.revealed.set(key, new Set());
  const set = v.revealed.get(key);
  if (act === 'after') set.add(a + 1);
  else if (act === 'before') set.add(b - 1);
  else for (let n = a + 1; n < b; n++) set.add(n);
  const nodes = nodesBetween(v, doc, visiblePages(v, doc, R), a, b, R);
  g.replaceWith(...nodes);
  const pages = nodes.filter((x) => x.classList.contains('page'));
  (act === 'before' ? pages[pages.length - 1] : pages[0])?.classList.add('fresh');
}

// ---------- rendering views ----------
function docHeadHtml(v, doc, R) {
  const count = S.texts.get(doc.id)?.length || 0;
  if (R?.flat) {
    const rank = v.list.indexOf(R) + 1;
    return `<span class="rank">${fmt(rank)}</span><span class="ftype ${doc.kind}">${KIND_LABEL[doc.kind] || 'TXT'}</span><h2 title="${esc(doc.name)}">${esc(doc.name)}</h2><span class="dstat"><b>${plural(R.hits, 'hit')}</b> on page ${fmt(R.pages[0].n + 1)} of ${fmt(count)}</span><span class="grow"></span>`;
  }
  const stat = R
    ? `<b>${plural(R.hits, 'hit')}</b> on ${plural(R.pages.length, 'page')} of ${fmt(count)}`
    : S.matcher ? `No hits · ${plural(count, 'page')}` : plural(count, 'page');
  const btn = v.kind === 'results'
    ? `<button class="chip-btn" data-act="read" title="Read the whole document">${I.book}Read whole</button>`
    : '';
  const f = folderOf(doc);
  const where = f ? `<span class="dfolder" title="Folder">${I.folder}${esc(f.name)}</span>` : '';
  return `<span class="ftype ${doc.kind}">${KIND_LABEL[doc.kind] || 'TXT'}</span><h2 title="${esc(doc.name)}">${esc(doc.name)}</h2>${where}<span class="dstat">${stat}</span><span class="grow"></span>${btn}`;
}

function sectionEl(v, doc, R) {
  const sec = el('section', 'doc-sec');
  sec.dataset.doc = doc.id;
  sec.dataset.key = groupKey(R, doc);
  if (R?.flat) sec.classList.add('ranked');
  sec.append(el('div', 'doc-head', docHeadHtml(v, doc, R)));
  const pages = el('div', 'doc-pages');
  const count = S.texts.get(doc.id)?.length || 0;
  pages.append(...nodesBetween(v, doc, visiblePages(v, doc, R), -1, count, R));
  sec.append(pages);
  return sec;
}

function clearView(v) {
  for (const art of v.pageEls.values()) {
    io.unobserve(art);
    ioFar.unobserve(art);
    art._cleanup?.();
  }
  v.pageEls.clear();
  v.root.replaceChildren();
}

function renderView(v, { keepScroll = true } = {}) {
  clearView(v);
  v.dirty = false;
  if (v.kind === 'reader') {
    const doc = docById(v.docId);
    if (doc) v.root.append(sectionEl(v, doc, v.list[0]));
    return;
  }
  if (!S.docs.length) { v.root.append(emptyLibrary()); return; }
  if (S.error) { v.root.append(stateBox('error', 'That search can’t run', esc(S.error))); return; }
  if (!S.matcher) { v.root.append(idleState()); return; }
  const scope = S.docs.filter((d) => d.enabled && searchable(d));
  if (!scope.length) {
    v.root.append(stateBox('none', 'No documents selected', 'Tick at least one document in the library to search it.'));
    return;
  }
  if (!v.list.length) { v.root.append(noResults(scope.length)); return; }
  const frag = document.createDocumentFragment();
  for (const R of v.list) frag.append(sectionEl(v, R.doc, R));
  v.root.append(frag);
  if (!keepScroll) window.scrollTo({ top: 0, behavior: 'instant' });
}

// Re-highlight without rebuilding the page list (keeps the reader where it is).
function refreshInPlace(v) {
  if (v.dirty && v.kind === 'results') { renderView(v); return; }
  if (!v.root.childElementCount) { renderView(v); return; }
  for (const sec of $$('.doc-sec', v.root)) {
    const doc = docById(sec.dataset.doc);
    if (!doc) continue;
    const R = v.byKey?.get(sec.dataset.key);
    sec.firstElementChild.innerHTML = docHeadHtml(v, doc, R);
  }
  for (const art of v.pageEls.values()) refill(art);
  v.dirty = false;
}

function stateBox(kind, title, body, extra = '') {
  return el('div', `state ${kind}`, `<h3>${title}</h3><p>${body}</p>${extra}`);
}

function emptyLibrary() {
  const box = el('div', 'hero');
  box.innerHTML = `
    <div class="hero-drop" data-act="pick">
      <div class="hero-icon">${I.upload}</div>
      <h3>Drop documents here</h3>
      <p>PDF, Word, text, Markdown and HTML. Everything stays on this device.</p>
      <button class="btn primary" data-act="pick">Choose files</button>
    </div>
    <div class="hero-steps">
      <div><b>1</b><span>Add as many references as you like</span></div>
      <div><b>2</b><span>Search them all at once, six different ways</span></div>
      <div><b>3</b><span>Read only the pages that hit, and open the pages around them</span></div>
    </div>`;
  return box;
}

function idleState() {
  const ready = orderedDocs().filter(searchable);
  const scope = ready.filter((d) => d.enabled);
  const pages = scope.reduce((a, d) => a + (S.texts.get(d.id)?.length || 0), 0);
  const busy = S.docs.filter((d) => d.status).length;
  const box = el('div', 'idle');
  const title = !scope.length && busy
    ? `Reading ${plural(busy, 'document')}…`
    : `Search ${plural(scope.length, 'document')} · ${plural(pages, 'page')}${busy ? ` <span class="muted">(${fmt(busy)} still reading)</span>` : ''}`;
  box.innerHTML = `
    <h3>${title}</h3>
    <p class="muted">Results show the actual pages, not snippets. Pages without hits are folded away — open them whenever you want to keep reading.</p>
    <div class="tips">
      <div><code>engine failure</code><span>All words mode finds pages with both words</span></div>
      <div><code>"fuel pump"</code><span>Quotes keep words together</span></div>
      <div><code>-checklist</code><span>A minus excludes pages with that word</span></div>
      <div><code>hydraul*</code><span>A star matches any ending</span></div>
      <div><code>(stall OR spin) NOT training</code><span>Boolean mode for full logic</span></div>
      <div><span class="keys"><kbd>Enter</kbd> <kbd>⇧ Enter</kbd></span><span>Jump between hits</span></div>
    </div>
    <div class="idle-docs">${ready.map((d) => `<button class="doc-card" data-act="read" data-doc="${d.id}"><span class="ftype ${d.kind}">${KIND_LABEL[d.kind]}</span><span class="dc-name">${esc(d.name)}</span><span class="dc-meta">${plural(S.texts.get(d.id)?.length || 0, 'page')}</span></button>`).join('')}</div>`;
  return box;
}

function noResults(n) {
  const tips = [];
  if (prefs.mode === 'all' && S.terms.filter((t) => !t.neg).length > 1) tips.push('<button class="link" data-mode="any">Try Any word</button>');
  if (prefs.mode === 'near') tips.push('<button class="link" data-mode="all">Try All words (any distance)</button>');
  if (prefs.mode === 'phrase') tips.push('<button class="link" data-mode="all">Try All words</button>');
  if (prefs.wholeWord) tips.push('<button class="link" data-fix="word">Turn off whole word</button>');
  if (prefs.matchCase) tips.push('<button class="link" data-fix="case">Turn off match case</button>');
  const off = S.docs.filter((d) => !d.enabled && searchable(d)).length;
  if (off) tips.push(`<button class="link" data-fix="all">Include the other ${plural(off, 'document')}</button>`);
  return stateBox('none', 'No matches', `Nothing found in ${plural(n, 'document')}.`, tips.length ? `<div class="fixes">${tips.join('')}</div>` : '');
}

// ---------- hit navigation ----------
function locate(v, k) {
  for (const R of v.list) {
    if (k < R.hitStart || k >= R.hitStart + R.hits) continue;
    for (const p of R.pages) if (k >= p.h0 && k < p.h0 + p.ranges.length) return { R, p };
  }
  return null;
}

function markCurrent(v) {
  $$('.cur', v.root).forEach((x) => x.classList.remove('cur'));
  if (v.cur < 0) return null;
  const els = $$(`[data-h="${v.cur}"]`, v.root);
  els.forEach((x) => x.classList.add('cur'));
  return els[0] || null;
}

function topOffset() {
  if (document.body.classList.contains('bar-hidden')) return 8;
  return ($('.topbar')?.offsetHeight || 0) + 8;
}
const isPhone = () => matchMedia('(max-width: 900px)').matches;

function scrollToEl(target, block = 'center', force) {
  const r = target.getBoundingClientRect();
  const top = topOffset();
  const y = block === 'center'
    ? scrollY + r.top - (top + (innerHeight - top) / 2) + r.height / 2
    : scrollY + r.top - top - ($('.doc-head')?.offsetHeight || 0) - 6;
  const far = Math.abs(y - scrollY) > innerHeight * 2.5;
  window.scrollTo({ top: Math.max(0, y), behavior: force || (far || reduceMotion() ? 'instant' : 'smooth') });
  return Math.max(0, y);
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

async function goTo(v, k, { instant = false } = {}) {
  if (!v.total) return;
  k = ((k % v.total) + v.total) % v.total;
  v.cur = k;
  updateCounter();
  const loc = locate(v, k);
  if (!loc) return;
  const art = v.pageEls.get(pkey(loc.R.doc.id, loc.p.n));
  if (!art) return;
  await fill(art);
  if (v.cur !== k) return;
  const target = markCurrent(v) || art;
  const startY = scrollY;
  v.navY = scrollToEl(target, 'center', instant ? 'instant' : undefined);
  target.classList.remove('pulse');
  void target.offsetWidth;
  target.classList.add('pulse');
  await settle(v, k, target, instant || Math.abs(v.navY - startY) > innerHeight * 2.5);
}

// Pages around the target fill in after a jump and push it around; keep re-centering until it holds still.
async function settle(v, k, target, wasInstant) {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!wasInstant) {
    await Promise.race([new Promise((r) => addEventListener('scrollend', r, { once: true })), new Promise((r) => setTimeout(r, 700))]);
  }
  for (let i = 0; i < 6; i++) {
    await frames();
    if (v.cur !== k || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    const top = topOffset();
    const mid = top + (innerHeight - top) / 2;
    if (Math.abs(r.top + r.height / 2 - mid) < 48) return;
    v.navY = scrollToEl(target, 'center', 'instant');
  }
}

// If the reader scrolled away since the last jump, continue from what's on screen.
function startFromViewport(v, dir) {
  const arts = [];
  for (const R of v.list) for (const p of R.pages) arts.push(p);
  const top = topOffset();
  let lo = 0, hi = arts.length - 1, idx = arts.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = arts[mid];
    const R = v.list.find((r) => r.pages.includes(p));
    const a = v.pageEls.get(pkey(R.doc.id, p.n));
    const rect = a ? a.getBoundingClientRect() : { bottom: 0 };
    if (rect.bottom > top + 40) { idx = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (idx >= arts.length) return dir > 0 ? 0 : v.total - 1;
  return dir > 0 ? arts[idx].h0 : arts[idx].h0 - 1;
}

function step(dir) {
  const v = active;
  if (!v.total) return;
  const moved = v.navY == null || Math.abs(scrollY - v.navY) > innerHeight * 0.8;
  if (v.cur < 0 || moved) goTo(v, startFromViewport(v, dir));
  else goTo(v, v.cur + dir);
}

function stepColor(color) {
  const v = active;
  if (!v.total) return;
  const start = v.cur + 1;
  let best = null, first = null;
  for (const R of v.list) for (const p of R.pages) p.ranges.forEach((r, i) => {
    if (r[2] !== color) return;
    const h = p.h0 + i;
    if (first == null) first = h;
    if (best == null && h >= start) best = h;
  });
  const k = best ?? first;
  if (k != null) goTo(v, k);
}

async function scrollToPage(v, docId, n) {
  let art = v.pageEls.get(pkey(docId, n));
  if (!art && v.kind === 'results') {
    const doc = docById(docId);
    const g = $$('.gap', v.root).find((x) => x.dataset.doc === docId && Number(x.dataset.a) < n && Number(x.dataset.b) > n);
    if (doc && g) {
      const key = g.dataset.key;
      if (!v.revealed.has(key)) v.revealed.set(key, new Set());
      v.revealed.get(key).add(n);
      g.replaceWith(...nodesBetween(v, doc, visiblePages(v, doc, g._R), Number(g.dataset.a), Number(g.dataset.b), g._R));
      art = v.pageEls.get(pkey(docId, n));
    }
  }
  if (!art) return;
  scrollToEl(art, 'start', 'instant');
  await fill(art);
  scrollToEl(art, 'start', 'instant');
  trackPosition();
}

// ---------- reader ----------
async function openReader(docId, n) {
  const doc = docById(docId);
  if (!doc || doc.status) return;
  if (active === results) results.scrollY = scrollY;
  reader.docId = docId;
  assign(reader, computeHits([doc]));
  active = reader;
  document.body.dataset.view = 'reader';
  renderView(reader);
  updateChrome();
  if (n == null) n = reader.list[0]?.pages[0]?.n ?? 0;
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (n > 0) await scrollToPage(reader, docId, n);
}

function closeReader() {
  if (active !== reader) return;
  clearView(reader);
  reader.docId = null;
  active = results;
  document.body.dataset.view = 'results';
  if (results.dirty) renderView(results);
  updateChrome();
  requestAnimationFrame(() => window.scrollTo({ top: results.scrollY, behavior: 'instant' }));
}

// ---------- chrome: counter, summary, outline, library ----------
function updateCounter() {
  const v = active;
  const c = $('#counter');
  const has = !!S.matcher;
  c.hidden = !has;
  c.textContent = !v.total ? 'No hits' : v.cur < 0 ? plural(v.total, 'hit') : `${fmt(v.cur + 1)} of ${fmt(v.total)}`;
  c.classList.toggle('zero', has && !v.total);
  $('#prevBtn').disabled = $('#nextBtn').disabled = !v.total;
  $('#mCountText').textContent = !v.total ? '0' : v.cur < 0 ? fmt(v.total) : `${fmt(v.cur + 1)}/${fmt(v.total)}`;
  ['mPrev', 'mNext', 'mPrevPage', 'mNextPage', 'mCount'].forEach((id) => ($('#' + id).disabled = !v.total));
  $('#clearBtn').hidden = !q.value;
}

function termCounts(v) {
  const counts = new Map();
  for (const R of v.list) for (const p of R.pages) for (const r of p.ranges) counts.set(r[2], (counts.get(r[2]) || 0) + 1);
  return counts;
}

function updateSummary() {
  const box = $('#summary');
  const v = active;
  let html = '';
  if (v.kind === 'reader') {
    const doc = docById(v.docId);
    const count = S.texts.get(v.docId)?.length || 0;
    html += `<button class="back-btn" data-act="back">${I.arrowLeft}<span>Results</span></button>
      <span class="reader-title"><span class="ftype ${doc?.kind}">${KIND_LABEL[doc?.kind] || ''}</span><b>${esc(doc?.name || '')}</b></span>
      <label class="jump">Page <input id="jumpInput" type="number" min="1" max="${count}" value="1" inputmode="numeric"> <span>of ${fmt(count)}</span></label>`;
  }
  let terms = '';
  if (S.matcher && S.terms.length) {
    const counts = termCounts(v);
    const chips = S.terms.map((t) => t.neg
      ? `<span class="term neg" title="Pages with this are excluded">−${esc(t.label)}</span>`
      : `<button class="term c${t.color}" data-color="${t.color}" title="Jump to next “${esc(t.label)}”"><i></i>${esc(t.label)}<span>${fmt(counts.get(t.color) || 0)}</span></button>`);
    terms = `<span class="terms">${chips.join('')}</span>`;
  }
  // when the toolbar is minimized, the word chips ride along above the results instead
  const termsUp = !(prefs.compact && v.kind === 'results');
  if (termsUp) html += terms;
  box.innerHTML = html;
  box.hidden = !html;

  const head = $('#resultsHead');
  const showHead = v.kind === 'results' && S.matcher && v.list.length;
  head.hidden = !showHead;
  if (showHead) {
    const pages = v.list.reduce((a, R) => a + R.pages.length, 0);
    const docCount = new Set(v.list.map((R) => R.doc.id)).size;
    const scope = S.docs.filter((d) => d.enabled && searchable(d)).length;
    $('#stat').innerHTML = `<span><b>${fmt(v.total)}</b> ${v.total === 1 ? 'hit' : 'hits'} on <b>${fmt(pages)}</b> ${pages === 1 ? 'page' : 'pages'} in <b>${fmt(docCount)}</b> of ${plural(scope, 'document')}</span>${termsUp ? '' : terms}`;
  }
  const dock = $('#dock');
  dock.hidden = !(v.kind === 'reader' || showHead);
  $('#mbar').hidden = dock.hidden;
  document.body.classList.toggle('has-dock', !dock.hidden);
}

function updateOutline() {
  const box = $('#outline');
  const v = active;
  if (!S.matcher || !v.list.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  if (v.list[0]?.flat) {
    const rows = v.list.slice(0, 400).map((R, i) => {
      const p = R.pages[0];
      return `<button class="ol-row" data-doc="${R.doc.id}" data-n="${p.n}" title="${esc(R.doc.name)} · page ${p.n + 1}"><span class="ol-rank">${i + 1}</span><span class="ol-where"><b>p. ${p.n + 1}</b><span>${esc(R.doc.name)}</span></span><em>${fmt(R.hits)}</em></button>`;
    }).join('');
    const more = v.list.length > 400 ? `<span class="ol-more">+${fmt(v.list.length - 400)} more pages</span>` : '';
    box.innerHTML = `<div class="ol-title">Pages by hits</div><div class="ol-rows">${rows}${more}</div>`;
    trackPosition();
    return;
  }
  box.innerHTML = `<div class="ol-title">${v.kind === 'reader' ? 'Pages with hits' : 'Jump to'}</div>` + v.list.map((R) => {
    const chips = R.pages.slice(0, 500).map((p) => `<button class="ol-p" data-doc="${R.doc.id}" data-n="${p.n}" title="Page ${p.n + 1} · ${plural(p.ranges.length, 'hit')}">${p.n + 1}${p.ranges.length > 1 ? `<sup>${p.ranges.length}</sup>` : ''}</button>`).join('');
    const more = R.pages.length > 500 ? `<span class="ol-more">+${fmt(R.pages.length - 500)}</span>` : '';
    const name = v.kind === 'reader' ? '' : `<button class="ol-doc" data-doc="${R.doc.id}" data-n="${R.pages[0].n}"><span>${esc(R.doc.name)}</span><em>${fmt(R.hits)}</em></button>`;
    return `<div class="ol-group">${name}<div class="ol-pages">${chips}${more}</div></div>`;
  }).join('');
  trackPosition();
}

function docItemHtml(d, hits) {
  const count = S.texts.get(d.id)?.length || d.pages || 0;
  const meta = d.status === 'indexing'
    ? `Reading… ${d.progress ? Math.round(d.progress * 100) + '%' : ''}`
    : `${plural(count, 'page')}${d.noText ? ' · <span class="warn">no text found</span>' : ''}`;
  const h = S.matcher && d.enabled && !d.status ? `<span class="lhits${hits.get(d.id) ? '' : ' zero'}">${fmt(hits.get(d.id) || 0)}</span>` : '';
  return `<li class="lib-item${d.enabled ? ' on' : ''}${d.status ? ' busy' : ''}${reader.docId === d.id && active === reader ? ' reading' : ''}" data-id="${d.id}" draggable="${d.status ? 'false' : 'true'}">
    <label class="chk" title="Include in search"><input type="checkbox" ${d.enabled ? 'checked' : ''} ${d.status ? 'disabled' : ''}><span></span></label>
    <button class="lib-main" data-act="read" title="${esc(d.name)}"><span class="lname">${esc(d.name)}</span><span class="lmeta"><span class="ftype ${d.kind}">${KIND_LABEL[d.kind]}</span>${meta}</span></button>
    ${h}
    <span class="lib-acts"><button class="mini" data-act="solo" title="Search only this document">${I.target}</button><button class="mini" data-act="dmenu" title="More">${I.more}</button></span>
    ${d.status === 'indexing' ? `<div class="prog"><i style="width:${Math.round((d.progress || 0) * 100)}%"></i></div>` : ''}
  </li>`;
}

let renaming = null; // { fid, input } while a folder name is being edited
function renderLibrary() {
  const ul = $('#lib');
  const hadFocus = renaming && document.activeElement === renaming.input;
  const hits = new Map();
  for (const R of results.list) hits.set(R.doc.id, (hits.get(R.doc.id) || 0) + R.hits);
  const ready = S.docs.filter(searchable);
  $('#libCount').textContent = S.docs.length ? `${ready.filter((d) => d.enabled).length}/${ready.length}` : '';
  $('#toggleAll').hidden = ready.length < 2;
  $('#toggleAll').textContent = ready.every((d) => d.enabled) ? 'None' : 'All';
  const by = new Map(S.folders.map((f) => [f.id, []]));
  const loose = [];
  for (const d of S.docs) (by.get(d.folderId) || loose).push(d);
  const folderHtml = S.folders.map((f) => {
    const docs = by.get(f.id);
    const rd = docs.filter(searchable);
    const on = rd.filter((d) => d.enabled).length;
    const fh = docs.reduce((a, d) => a + (d.enabled ? hits.get(d.id) || 0 : 0), 0);
    const badge = S.matcher && on ? `<span class="lhits${fh ? '' : ' zero'}">${fmt(fh)}</span>` : '';
    return `<li class="folder${f.collapsed ? ' collapsed' : ''}${rd.length && !on ? ' off' : ''}" data-fid="${f.id}">
      <div class="folder-row">
        <label class="chk" title="Search this whole folder"><input type="checkbox" data-fchk ${rd.length && on === rd.length ? 'checked' : ''} ${on && on < rd.length ? 'data-indet' : ''} ${rd.length ? '' : 'disabled'}><span></span></label>
        <button class="folder-main" data-act="fold" title="${esc(f.name)}"><span class="chev">${I.chevron}</span><span class="ficon">${I.folder}</span><span class="fname">${esc(f.name)}</span><span class="fcount">${fmt(docs.length)}</span></button>
        ${badge}
        <span class="lib-acts"><button class="mini" data-act="fsolo" title="Search only this folder">${I.target}</button><button class="mini" data-act="fadd" title="Add documents to this folder">${I.plus}</button><button class="mini" data-act="fmenu" title="More">${I.more}</button></span>
      </div>
      <ul class="folder-docs">${docs.length ? docs.map((d) => docItemHtml(d, hits)).join('') : '<li class="folder-empty">Drag documents here, or use + to add files</li>'}</ul>
    </li>`;
  }).join('');
  ul.innerHTML = folderHtml + loose.map((d) => docItemHtml(d, hits)).join('');
  $$('[data-indet]', ul).forEach((i) => (i.indeterminate = true));
  if (renaming) {
    const span = $(`.folder[data-fid="${renaming.fid}"] .fname`, ul);
    if (span) {
      span.replaceWith(renaming.input);
      if (hadFocus) renaming.input.focus({ preventScroll: true });
    }
  }
  $('#libEmpty').hidden = !!(S.docs.length || S.folders.length);
}

function syncControls() {
  $$('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.mode)));
  $('#nearBox').hidden = prefs.mode !== 'near';
  $('#nearN').value = prefs.near;
  $('#caseBtn').setAttribute('aria-pressed', String(prefs.matchCase));
  $('#wordBtn').setAttribute('aria-pressed', String(prefs.wholeWord));
  $('#wordBtn').disabled = prefs.mode === 'regex';
  $('#sortSel').value = prefs.sort;
  $$('#viewSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view)));
  $('#viewSeg').hidden = !S.docs.some(hasOriginal);
  document.body.classList.toggle('compact', !!prefs.compact);
  document.body.classList.toggle('side-hidden', !!prefs.sideHidden);
  $('#compactBtn').title = prefs.compact ? `Show the full toolbar (${keyHint('toggleCompact')})` : `Minimize the toolbar (${keyHint('toggleCompact')})`;
  const flags = [prefs.matchCase ? 'Aa' : '', prefs.wholeWord && prefs.mode !== 'regex' ? '<u>ab</u>' : '', prefs.mode === 'near' ? `≤${prefs.near}` : ''].filter(Boolean);
  $('#modePill').innerHTML = `<span class="full">${MODE_SHORT[prefs.mode]}</span><span class="short">${MODE_TINY[prefs.mode]}</span>${flags.map((f) => `<em>${f}</em>`).join('')}<svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg>`;
  $('#mMode').innerHTML = $('#modePill').innerHTML;
  $('#zoomVal').textContent = Math.round(zoomValue() * 100) + '%';
  $('#fitWidth').setAttribute('aria-pressed', String(prefs.zoom === 'width'));
  $('#fitPage').setAttribute('aria-pressed', String(prefs.zoom === 'page'));
  q.placeholder = {
    any: 'Pages with any of these words…',
    all: 'Pages with all of these words…',
    phrase: 'An exact phrase…',
    near: 'Words close together…',
    boolean: 'e.g. (stall OR spin) AND recovery NOT training',
    regex: 'A regular expression, e.g. \\b[A-Z]{3}\\d+\\b',
  }[prefs.mode];
  q.classList.toggle('mono', prefs.mode === 'regex');
  $('#themeBtn').dataset.theme = prefs.theme;
}

function updateChrome() {
  updateCounter();
  updateSummary();
  updateOutline();
  renderLibrary();
  syncControls();
}

// Highlight where the reader currently is (outline chip + reader page box).
let trackRaf = 0;
function trackPosition() {
  if (trackRaf) return;
  trackRaf = requestAnimationFrame(() => {
    trackRaf = 0;
    const v = active;
    const x = v.root.getBoundingClientRect().left + 30;
    const hit = document.elementFromPoint(x, topOffset() + ($('.doc-head')?.offsetHeight || 0) + 24);
    const art = hit?.closest?.('.page') || null;
    $$('#outline .on').forEach((b) => b.classList.remove('on'));
    if (!art) return;
    const chip = $(`#outline :is(.ol-p, .ol-row)[data-doc="${art.dataset.doc}"][data-n="${art.dataset.n}"]`);
    if (chip) {
      chip.classList.add('on');
      const box = $('#outline');
      const cr = chip.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (cr.top < br.top + 30 || cr.bottom > br.bottom - 10) box.scrollTop += cr.top - br.top - br.height / 2;
    }
    const jump = $('#jumpInput');
    if (jump && document.activeElement !== jump && active === reader) jump.value = Number(art.dataset.n) + 1;
  });
}

// ---------- library actions ----------
let pendingRemoval = null;
function removeDoc(id) {
  const idx = S.docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  finalizeRemoval();
  const doc = S.docs[idx];
  const pages = S.texts.get(id);
  S.docs.splice(idx, 1);
  S.texts.delete(id);
  if (reader.docId === id) closeReader();
  runSearch();
  pendingRemoval = { doc, pages, idx, timer: setTimeout(finalizeRemoval, 6000) };
  toast(`Removed “${doc.name}”`, { action: 'Undo', onAction: undoRemoval, ms: 6000 });
}
function finalizeRemoval() {
  if (!pendingRemoval) return;
  clearTimeout(pendingRemoval.timer);
  const { doc } = pendingRemoval;
  pendingRemoval = null;
  closePdf(doc.id);
  forgetHtml(doc.id);
  store.deleteDoc(doc.id).catch(() => {});
}
function undoRemoval() {
  if (!pendingRemoval) return;
  clearTimeout(pendingRemoval.timer);
  const { doc, pages, idx } = pendingRemoval;
  pendingRemoval = null;
  S.docs.splice(idx, 0, doc);
  S.texts.set(doc.id, pages);
  runSearch();
}

function setEnabled(id, on) {
  const d = docById(id);
  if (!d) return;
  d.enabled = on;
  store.updateDoc(stripMeta(d)).catch(() => {});
  runSearch();
}
function solo(id) {
  const ready = S.docs.filter(searchable);
  const already = ready.every((d) => d.enabled === (d.id === id));
  for (const d of ready) d.enabled = already ? true : d.id === id;
  store.updateDocs(ready.map(stripMeta)).catch(() => {});
  runSearch();
  if (!already) toast(`Searching only “${docById(id).name}”`);
}
function toggleAll() {
  const ready = S.docs.filter(searchable);
  const all = ready.every((d) => d.enabled);
  for (const d of ready) d.enabled = !all;
  store.updateDocs(ready.map(stripMeta)).catch(() => {});
  runSearch();
}
const stripMeta = ({ status, progress, ...m }) => m;

// ---------- folders ----------
const saveFolders = () => store.putFolders(S.folders).catch(() => {});

function createFolder(name) {
  let base = (name || 'New folder').trim() || 'New folder';
  let n = base;
  for (let i = 2; S.folders.some((f) => f.name.toLowerCase() === n.toLowerCase()); i++) n = `${base} ${i}`;
  const f = { id: uid(), name: n, order: S.folders.reduce((m, x) => Math.max(m, x.order || 0), 0) + 1, collapsed: false };
  S.folders.push(f);
  saveFolders();
  renderLibrary();
  return f;
}

function folderNamed(name) {
  return S.folders.find((f) => f.name.toLowerCase() === name.toLowerCase()) || createFolder(name);
}

function startRename(fid) {
  const f = folderById(fid);
  const li = $(`#lib .folder[data-fid="${fid}"]`);
  if (!f || !li) return;
  li.classList.remove('collapsed');
  const span = $('.fname', li);
  const input = el('input', 'frename');
  renaming = { fid, input };
  input.value = f.name;
  input.setAttribute('aria-label', 'Folder name');
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = null;
    const v = input.value.trim();
    if (save && v && v !== f.name) {
      f.name = v;
      saveFolders();
      refreshInPlace(results);
    }
    renderLibrary();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!input.isConnected || document.activeElement !== input) finish(true); }, 0));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function toggleFolder(fid) {
  const f = folderById(fid);
  if (!f) return;
  f.collapsed = !f.collapsed;
  saveFolders();
  $(`#lib .folder[data-fid="${fid}"]`)?.classList.toggle('collapsed', f.collapsed);
}

function setFolderEnabled(fid, on) {
  const docs = S.docs.filter((d) => d.folderId === fid && searchable(d));
  for (const d of docs) d.enabled = on;
  store.updateDocs(docs.map(stripMeta)).catch(() => {});
  runSearch();
}

function soloFolder(fid) {
  const ready = S.docs.filter(searchable);
  const inside = (d) => d.folderId === fid;
  if (!ready.some(inside)) { toast('This folder is empty'); return; }
  const already = ready.every((d) => d.enabled === inside(d));
  for (const d of ready) d.enabled = already ? true : inside(d);
  store.updateDocs(ready.map(stripMeta)).catch(() => {});
  runSearch();
  if (!already) toast(`Searching only the “${folderById(fid).name}” folder`);
}

function moveDocs(ids, fid) {
  const docs = ids.map(docById).filter(Boolean).filter((d) => (d.folderId || null) !== (fid || null));
  if (!docs.length) return;
  for (const d of docs) d.folderId = fid || null;
  store.updateDocs(docs.filter(searchable).map(stripMeta)).catch(() => {});
  const f = fid && folderById(fid);
  if (f?.collapsed) { f.collapsed = false; saveFolders(); }
  runSearch({ keepScroll: true });
  toast(`${docs.length === 1 ? `“${docs[0].name}”` : plural(docs.length, 'document')} moved ${f ? `to “${f.name}”` : 'out of the folder'}`, { ms: 2200 });
}

let pendingFolderDelete = null;
function deleteFolder(fid) {
  const f = folderById(fid);
  if (!f) return;
  const docs = S.docs.filter((d) => d.folderId === fid);
  const idx = S.folders.indexOf(f);
  S.folders.splice(idx, 1);
  for (const d of docs) d.folderId = null;
  store.deleteFolder(fid).catch(() => {});
  store.updateDocs(docs.filter(searchable).map(stripMeta)).catch(() => {});
  runSearch({ keepScroll: true });
  pendingFolderDelete = { f, idx, ids: docs.map((d) => d.id) };
  toast(`Deleted folder “${f.name}”${docs.length ? ` — its ${plural(docs.length, 'document')} ${docs.length === 1 ? 'is' : 'are'} kept` : ''}`, {
    action: 'Undo',
    ms: 6000,
    onAction: () => {
      const p = pendingFolderDelete;
      if (!p) return;
      pendingFolderDelete = null;
      S.folders.splice(p.idx, 0, p.f);
      saveFolders();
      const back = p.ids.map(docById).filter(Boolean);
      for (const d of back) d.folderId = p.f.id;
      store.updateDocs(back.filter(searchable).map(stripMeta)).catch(() => {});
      runSearch({ keepScroll: true });
    },
  });
}

// ---------- popover menu ----------
function closeMenu() {
  $('.pop-menu')?.remove();
  $$('.menu-open').forEach((x) => x.classList.remove('menu-open'));
}
function openMenu(anchor, items) {
  const wasOpen = anchor.classList.contains('menu-open');
  closeMenu();
  if (wasOpen) return;
  const m = el('div', 'pop-menu');
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { m.append(el('div', 'menu-sep')); continue; }
    if (it.header) { m.append(el('div', 'menu-head', esc(it.header))); continue; }
    const b = el('button', `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`, `${it.icon || '<span class="menu-gap"></span>'}<span>${esc(it.label)}</span>${it.checked ? I.check : ''}`);
    b.setAttribute('role', 'menuitem');
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.run(); });
    m.append(b);
  }
  document.body.append(m);
  anchor.classList.add('menu-open');
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  let left = Math.min(r.left, innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = Math.max(8, left) + 'px';
  m.style.top = top + 'px';
  m.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
}

function moveItems(d) {
  const items = [{ header: 'Move to' }];
  for (const f of S.folders) items.push({ label: f.name, icon: I.folder, checked: d.folderId === f.id, run: () => moveDocs([d.id], f.id) });
  if (folderOf(d)) items.push({ label: 'No folder', icon: I.out, run: () => moveDocs([d.id], null) });
  items.push({ label: 'New folder…', icon: I.folderPlus, run: () => { const f = createFolder(); moveDocs([d.id], f.id); startRename(f.id); } });
  return items;
}

function docMenu(anchor, id) {
  const d = docById(id);
  if (!d) return;
  openMenu(anchor, [
    { label: 'Read whole document', icon: I.book, disabled: !!d.status, run: () => { openReader(id); closeDrawer(); } },
    { label: 'Search only this', icon: I.target, disabled: !!d.status, run: () => solo(id) },
    { sep: true },
    ...moveItems(d),
    { sep: true },
    { label: 'Remove from library', icon: I.trash, danger: true, run: () => removeDoc(id) },
  ]);
}

function folderMenu(anchor, fid) {
  openMenu(anchor, [
    { label: 'Add documents here…', icon: I.plus, run: () => pickFiles(fid) },
    { label: 'Search only this folder', icon: I.target, run: () => soloFolder(fid) },
    { label: 'Rename', icon: I.pencil, run: () => startRename(fid) },
    { sep: true },
    { label: 'Delete folder (keeps documents)', icon: I.trash, danger: true, run: () => deleteFolder(fid) },
  ]);
}

function addMenu(anchor) {
  const items = [
    { label: 'Add files…', icon: I.plus, run: () => pickFiles(null) },
    { label: 'Add a folder from your computer…', icon: I.folderPlus, run: () => $('#dirInput').click() },
    { label: 'Add files into a new folder…', icon: I.folderPlus, run: () => pickFiles('new') },
  ];
  if (S.folders.length) {
    items.push({ sep: true }, { header: 'Add files into' });
    for (const f of S.folders) items.push({ label: f.name, icon: I.folder, run: () => pickFiles(f.id) });
  }
  openMenu(anchor, items);
}

const byName = (a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: 'base' });

// where the next file-picker selection goes: null (no folder), a folder id, or 'new'
let pickTarget = null;
function pickFiles(target) {
  pickTarget = target;
  $('#fileInput').click();
}

// Dropped items can include whole folders; read them recursively.
function droppedEntries(dt) {
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  return entries.length ? entries : null;
}
async function readEntries(entries) {
  const groups = [];
  const loose = [];
  const walk = async (entry, out) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, out);
      }
    }
  };
  for (const e of entries) {
    if (e.isDirectory) {
      const files = [];
      await walk(e, files);
      groups.push({ name: e.name, files });
    } else await walk(e, loose);
  }
  return { groups, loose };
}

// target: folder id, null, or undefined (= no folder; dropped folders become library folders)
async function importDrop(dt, target) {
  const entries = droppedEntries(dt);
  if (!entries) { addFiles(dt.files, target || null); return; }
  const { groups, loose } = await readEntries(entries);
  if (loose.length) addFiles(loose, target || null);
  for (const g of groups) {
    const usable = g.files.filter((f) => kindOf(f.name)).sort(byName);
    if (!usable.length) { toast(`No supported documents in “${g.name}”`); continue; }
    const fid = target || folderNamed(g.name).id;
    addFiles(usable, fid, { quietSkip: true });
    if (usable.length < g.files.length) toast(`Skipped ${plural(g.files.length - usable.length, 'file')} in “${g.name}” that aren’t documents`);
  }
}

// ---------- adding files ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
let queue = Promise.resolve();

function addFiles(fileList, folderId = null, { quietSkip = false } = {}) {
  const files = [...fileList];
  if (!files.length) return;
  const bad = files.filter((f) => !kindOf(f.name));
  if (bad.length && !quietSkip) toast(`Skipped ${bad.length === 1 ? `“${bad[0].name}”` : plural(bad.length, 'file')} — use PDF, Word (.docx), text, Markdown or HTML`);
  let order = S.docs.reduce((m, d) => Math.max(m, d.order || 0), 0);
  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) continue;
    const dup = S.docs.find((d) => d.name === file.name && d.size === file.size);
    if (dup) {
      if (folderId && dup.folderId !== folderId) moveDocs([dup.id], folderId);
      else toast(`“${file.name}” is already in your library`);
      continue;
    }
    const meta = { id: uid(), name: file.name, kind, size: file.size, addedAt: Date.now(), order: ++order, enabled: true, status: 'indexing', progress: 0, v: EXTRACTOR_VERSION, folderId: folderId || null };
    S.docs.push(meta);
    queue = queue.then(() => ingest(file, meta));
  }
  renderLibrary();
  syncControls();
  if (active === results && !S.matcher) renderView(results);
}

async function ingest(file, meta) {
  let last = 0;
  try {
    const { pages, bytes } = await readFile(file, (n, total) => {
      meta.progress = n / total;
      const now = performance.now();
      if (now - last > 120) { last = now; renderLibrary(); }
    });
    const chars = pages.reduce((a, p) => a + p.trim().length, 0);
    meta.pages = pages.length;
    meta.noText = meta.kind === 'pdf' && chars < pages.length * 25;
    if (meta.kind === 'html' && bytes) meta.hasOriginal = true;
    if (!S.docs.includes(meta)) return; // removed while reading
    if (meta.folderId && !folderById(meta.folderId)) meta.folderId = null;
    delete meta.status;
    delete meta.progress;
    S.texts.set(meta.id, pages);
    try {
      await store.addDoc(stripMeta(meta), pages, bytes);
    } catch (e) {
      toast(`“${meta.name}” is searchable now but couldn’t be saved on this device (${e.message || 'storage full'})`);
    }
    if (meta.noText) toast(`“${meta.name}” has little or no text — it may be scanned. Use Original view to read it.`);
  } catch (err) {
    S.docs = S.docs.filter((d) => d !== meta);
    toast(`Couldn’t read “${meta.name}”: ${err.message || err}`);
  }
  runSearch({ keepScroll: true });
  updateStorage();
}

async function updateStorage() {
  const box = $('#storage');
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return;
    const mb = (est.usage || 0) / 1048576;
    box.textContent = S.docs.length ? `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB stored on this device` : 'Stored only on this device';
  } catch {}
}

// ---------- toasts ----------
function toast(msg, { action, onAction, ms = 4200 } = {}) {
  const t = el('div', 'toast', `<span>${esc(msg)}</span>`);
  if (action) {
    const b = el('button', 'toast-btn', esc(action));
    b.onclick = () => { onAction(); t.remove(); };
    t.append(b);
  }
  const box = $('#toasts');
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- theme ----------
function applyTheme() {
  const r = document.documentElement;
  if (prefs.theme === 'auto') r.removeAttribute('data-theme');
  else r.dataset.theme = prefs.theme;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').content = dark ? '#16171a' : '#f5f4f1';
}

// ---------- events ----------
function bind() {
  $('#fileInput').accept = ACCEPT;
  $('#fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    let target = pickTarget;
    pickTarget = null;
    if (target === 'new') { target = createFolder().id; addFiles(files, target); startRename(target); }
    else addFiles(files, target && folderById(target) ? target : null);
  });
  $('#dirInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const groups = new Map();
    for (const f of files) {
      const top = (f.webkitRelativePath || '').split('/')[0] || 'Imported';
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(f);
    }
    for (const [name, list] of groups) {
      const usable = list.filter((f) => kindOf(f.name)).sort(byName);
      if (!usable.length) { toast(`No supported documents in “${name}”`); continue; }
      addFiles(usable, folderNamed(name).id, { quietSkip: true });
      if (usable.length < list.length) toast(`Added ${plural(usable.length, 'document')} from “${name}” · skipped ${plural(list.length - usable.length, 'other file')}`);
    }
  });
  $('#addBtn').addEventListener('click', () => pickFiles(null));
  $('#addMoreBtn').addEventListener('click', (e) => { e.stopPropagation(); addMenu(e.currentTarget); });
  $('#newFolderBtn').addEventListener('click', () => { const f = createFolder(); startRename(f.id); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.pop-menu')) closeMenu(); });
  addEventListener('resize', closeMenu);
  $('.sidebar').addEventListener('scroll', closeMenu, true);

  q.addEventListener('input', () => { $('#clearBtn').hidden = !q.value; scheduleSearch(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchTimer && prefs.q !== q.value) { clearTimeout(searchTimer); runSearch(); }
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      if (q.value) { q.value = ''; runSearch(); } else q.blur();
    }
  });
  $('#clearBtn').addEventListener('click', () => { q.value = ''; runSearch(); q.focus(); });
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));

  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('#nearN').addEventListener('input', (e) => { prefs.near = Math.max(1, Math.min(200, Number(e.target.value) || 8)); scheduleSearch(); });
  $('#caseBtn').addEventListener('click', () => { prefs.matchCase = !prefs.matchCase; runSearch(); });
  $('#wordBtn').addEventListener('click', () => { prefs.wholeWord = !prefs.wholeWord; runSearch(); });
  $('#sortSel').addEventListener('change', (e) => { prefs.sort = e.target.value; runSearch(); });
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });
  $('#zoomIn').addEventListener('click', () => zoomBy(1));
  $('#zoomOut').addEventListener('click', () => zoomBy(-1));
  $('#zoomVal').addEventListener('click', () => setZoom(1));
  $('#fitWidth').addEventListener('click', () => setZoom(prefs.zoom === 'width' ? 1 : 'width'));
  $('#fitPage').addEventListener('click', () => setZoom(prefs.zoom === 'page' ? 1 : 'page'));
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (typeof prefs.zoom === 'string') applyZoom(); }, 150); });
  $('#compactBtn').addEventListener('click', toggleCompact);
  bindSideResize();
  // phone reading bar
  bindModeScrub($('#mMode'), { startIndex: () => Object.keys(MODES).indexOf(prefs.mode), onTap: () => modeMenu($('#mMode')) });
  bindHoldMenu($('#mMore'), moreItems);
  bindJog($('#mCount'));
  $('#mPrev').addEventListener('click', () => step(-1));
  $('#mNext').addEventListener('click', () => step(1));
  $('#mPrevPage').addEventListener('click', () => stepPage(-1));
  $('#mNextPage').addEventListener('click', () => stepPage(1));
  addEventListener('scroll', onScrollBars, { passive: true });
  q.addEventListener('focus', () => setBarHidden(false));
  $('#keysBtn').addEventListener('click', openKeys);

  // search type pill (compact toolbar) and the full segmented control both support press-and-drag
  bindModeScrub($('#modePill'), {
    startIndex: () => Object.keys(MODES).indexOf(prefs.mode),
    onTap: () => modeMenu($('#modePill')),
  });
  bindModeScrub($('#modes'), {
    startIndex: (e) => { const b = e.target.closest?.('button[data-mode]'); return b ? Object.keys(MODES).indexOf(b.dataset.mode) : -1; },
    onTap: (s) => setMode(Object.keys(MODES)[s.idx]),
  });
  let wheelAt = 0;
  $('#modePill').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Date.now() - wheelAt < 180) return;
    wheelAt = Date.now();
    const modes = Object.keys(MODES);
    const i = modes.indexOf(prefs.mode) + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
    setMode(modes[(i + modes.length) % modes.length]);
  }, { passive: false });

  // shortcut editor
  $('#keys').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-close]')) { recording = null; $('#keys').close(); return; }
    const chip = e.target.closest('.kchip');
    const add = e.target.closest('.kadd');
    const reset = e.target.closest('.kreset');
    if (chip) setBindings(chip.dataset.id, bindings(actionById(chip.dataset.id)).filter((k) => k !== chip.dataset.key));
    else if (add) { recording = add.dataset.id; renderKeys(); $('#keysList').focus({ preventScroll: true }); }
    else if (reset) setBindings(reset.dataset.id, actionById(reset.dataset.id).keys);
  });
  $('#keysReset').addEventListener('click', () => { prefs.keys = {}; savePrefs(); buildKeyMap(); renderKeys(); syncControls(); toast('Shortcuts reset to defaults', { ms: 1800 }); });
  $('#keys').addEventListener('cancel', (e) => { if (recording) { e.preventDefault(); recording = null; renderKeys(); } });
  addEventListener('keydown', (e) => {
    if (!recording || !$('#keys').open) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { recording = null; renderKeys(); return; }
    const combo = comboFromEvent(e);
    if (!combo) return;
    const id = recording;
    recording = null;
    setTimeout(() => $(`.kadd[data-id="${id}"]`)?.focus({ preventScroll: true }), 0);
    const other = ACTIONS.find((a) => a.id && a.id !== id && bindings(a).includes(combo));
    if (other) {
      setBindings(other.id, bindings(other).filter((k) => k !== combo));
      toast(`${comboLabel(combo)} moved from “${other.label}”`, { ms: 2600 });
    }
    const mine = bindings(actionById(id));
    setBindings(id, mine.includes(combo) ? mine : [...mine, combo]);
  }, true);
  $('#themeBtn').addEventListener('click', () => {
    prefs.theme = { auto: 'light', light: 'dark', dark: 'auto' }[prefs.theme] || 'auto';
    savePrefs();
    applyTheme();
    syncControls();
    toast(`Theme: ${prefs.theme === 'auto' ? 'match system' : prefs.theme}`, { ms: 1600 });
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  $('#helpBtn').addEventListener('click', () => $('#help').showModal());
  $('#help').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) $('#help').close(); });

  // library
  $('#lib').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.hasAttribute('data-fchk')) { setFolderEnabled(e.target.closest('.folder').dataset.fid, e.target.checked); return; }
    const li = e.target.closest('.lib-item');
    if (li) setEnabled(li.dataset.id, e.target.checked);
  });
  $('#lib').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    e.stopPropagation();
    const act = b.dataset.act;
    const fid = b.closest('.folder')?.dataset.fid;
    const id = b.closest('.lib-item')?.dataset.id;
    if (id) {
      if (act === 'read') { if (!docById(id)?.status) { openReader(id); closeDrawer(); } }
      else if (act === 'solo') solo(id);
      else if (act === 'dmenu') docMenu(b, id);
      return;
    }
    if (!fid) return;
    if (act === 'fold') toggleFolder(fid);
    else if (act === 'fsolo') soloFolder(fid);
    else if (act === 'fadd') pickFiles(fid);
    else if (act === 'fmenu') folderMenu(b, fid);
  });
  $('#lib').addEventListener('dblclick', (e) => {
    const f = e.target.closest('.folder-main');
    if (f) { e.preventDefault(); startRename(f.closest('.folder').dataset.fid); }
  });

  // drag documents between folders; drop files from the computer onto a folder
  const DOC_TYPE = 'application/x-instant-doc';
  let dragIds = null;
  $('#lib').addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.lib-item');
    if (!li) return;
    dragIds = [li.dataset.id];
    e.dataTransfer.setData(DOC_TYPE, li.dataset.id);
    e.dataTransfer.setData('text/plain', docById(li.dataset.id)?.name || '');
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragged');
    document.body.classList.add('moving-doc');
  });
  $('#lib').addEventListener('dragend', () => {
    dragIds = null;
    $$('.dragged').forEach((x) => x.classList.remove('dragged'));
    document.body.classList.remove('moving-doc');
    clearDropMarks();
  });
  const clearDropMarks = () => $$('.drop-on').forEach((x) => x.classList.remove('drop-on'));
  const dropTarget = (e) => e.target.closest?.('.folder') || $('.lib-zone');
  $('.lib-zone').addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes(DOC_TYPE) && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes(DOC_TYPE) ? 'move' : 'copy';
    const t = dropTarget(e);
    if (!t.classList.contains('drop-on')) { clearDropMarks(); t.classList.add('drop-on'); }
    const f = t.classList.contains('folder') && folderById(t.dataset.fid);
    if (f?.collapsed && !t._openTimer) t._openTimer = setTimeout(() => { if (t.classList.contains('drop-on')) toggleFolder(f.id); t._openTimer = null; }, 700);
  });
  $('.lib-zone').addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !$('.lib-zone').contains(e.relatedTarget)) clearDropMarks();
  });
  $('.lib-zone').addEventListener('drop', (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes(DOC_TYPE) && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    const t = dropTarget(e);
    const fid = t.classList.contains('folder') ? t.dataset.fid : null;
    clearDropMarks();
    document.body.classList.remove('dragging', 'moving-doc');
    resetDrag();
    if (types.includes(DOC_TYPE)) moveDocs(dragIds || [e.dataTransfer.getData(DOC_TYPE)], fid);
    else importDrop(e.dataTransfer, fid || undefined);
  });
  $('#toggleAll').addEventListener('click', toggleAll);
  $('#clearLib').addEventListener('click', async () => {
    if (!S.docs.length && !S.folders.length) return;
    if (!confirm(`Remove all ${plural(S.docs.length, 'document')}${S.folders.length ? ` and ${plural(S.folders.length, 'folder')}` : ''} from this device?`)) return;
    finalizeRemoval();
    S.docs.forEach((d) => closePdf(d.id));
    S.docs = [];
    S.folders = [];
    S.texts.clear();
    await store.clear().catch(() => {});
    if (active === reader) closeReader();
    runSearch();
    updateStorage();
  });

  // results + reader (delegated)
  const onMain = (e) => {
    const t = e.target;
    const mark = t.closest('[data-h]');
    if (mark && active.root.contains(mark)) {
      active.cur = Number(mark.dataset.h);
      active.navY = scrollY;
      markCurrent(active);
      updateCounter();
    }
    const gapBtn = t.closest('.gap [data-act]');
    if (gapBtn) { onGap(gapBtn.closest('.gap'), gapBtn.dataset.act); return; }
    const b = t.closest('[data-act]');
    if (!b) {
      const m = t.closest('[data-mode]');
      if (m) setMode(m.dataset.mode);
      const f = t.closest('[data-fix]');
      if (f) {
        if (f.dataset.fix === 'word') prefs.wholeWord = false;
        if (f.dataset.fix === 'case') prefs.matchCase = false;
        if (f.dataset.fix === 'all') { S.docs.forEach((d) => (d.enabled = true)); store.updateDocs(S.docs.filter(searchable).map(stripMeta)).catch(() => {}); }
        runSearch();
      }
      return;
    }
    const act = b.dataset.act;
    const art = b.closest('.page');
    const sec = b.closest('.doc-sec');
    if (act === 'pick') $('#fileInput').click();
    else if (act === 'read') openReader(b.dataset.doc || sec?.dataset.doc);
    else if (act === 'open' && art) openReader(art.dataset.doc, Number(art.dataset.n));
    else if (act === 'pmode' && art) {
      const doc = docById(art.dataset.doc);
      const n = Number(art.dataset.n);
      override.set(pkey(doc.id, n), pageMode(doc, n) === 'original' ? 'text' : 'original');
      refill(art);
    }
  };
  $('#results').addEventListener('click', onMain);
  $('#reader').addEventListener('click', onMain);

  $('#summary').addEventListener('click', (e) => {
    const t = e.target.closest('[data-color]');
    if (t) stepColor(Number(t.dataset.color));
    if (e.target.closest('[data-act="back"]')) closeReader();
  });
  $('#summary').addEventListener('change', (e) => {
    if (e.target.id !== 'jumpInput') return;
    const count = S.texts.get(reader.docId)?.length || 1;
    const n = Math.max(1, Math.min(count, Number(e.target.value) || 1));
    e.target.value = n;
    scrollToPage(reader, reader.docId, n - 1);
  });
  $('#summary').addEventListener('keydown', (e) => { if (e.target.id === 'jumpInput' && e.key === 'Enter') e.target.blur(); });
  $('#outline').addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    const v = active;
    const info = v.info.get(pkey(b.dataset.doc, Number(b.dataset.n)));
    if (!info || !info.ranges.length) { scrollToPage(v, b.dataset.doc, Number(b.dataset.n)); return; }
    // First click lands on the page's first hit; clicking the same page again steps through its hits.
    const onPage = v.cur >= info.h0 && v.cur < info.h0 + info.ranges.length;
    const k = onPage && b.matches('.ol-p, .ol-row') ? info.h0 + ((v.cur - info.h0 + 1) % info.ranges.length) : info.h0;
    goTo(v, k);
  });

  addEventListener('scroll', trackPosition, { passive: true });

  // keyboard
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('.pop-menu')) { closeMenu(); return; }
    if ($('dialog[open]') || e.isComposing) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const a = keyMap.get(combo);
    if (!a) return;
    const el = document.activeElement;
    const typing = /INPUT|TEXTAREA|SELECT/.test(el?.tagName) || el?.isContentEditable;
    if (typing && !worksWhileTyping(combo)) return;
    if (a.id === 'back' && active !== reader) return;
    e.preventDefault();
    a.run();
  });

  // drag & drop anywhere
  let dragDepth = 0;
  resetDrag = () => { dragDepth = 0; };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    importDrop(e.dataTransfer);
  });

  // mobile drawer
  $('#menuBtn').addEventListener('click', toggleLibrary);
  $('#scrim').addEventListener('click', closeDrawer);

  // keep the sticky offset accurate
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--top-h', $('.topbar').offsetHeight + 'px');
  }).observe($('.topbar'));
}
const closeDrawer = () => document.body.classList.remove('drawer');
let resetDrag = () => {};

const MODE_SHORT = { any: 'Any word', all: 'All words', phrase: 'Phrase', near: 'Near', boolean: 'Boolean', regex: 'Regex' };
const MODE_TINY = { any: 'Any', all: 'All', phrase: '“ ”', near: 'Near', boolean: 'Bool', regex: '.*' };

// ---------- zoom ----------
const BASE_W = 840; // page width at 100%
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function zoomValue() {
  const z = prefs.zoom;
  if (z === 'width') {
    const w = $('.col')?.clientWidth || BASE_W;
    return Math.min(3, Math.max(0.4, w / BASE_W));
  }
  if (z === 'page') {
    const avail = innerHeight - ($('.topbar')?.offsetHeight || 0) - 48 - 44 - 24;
    const w = Math.min(avail / S.pageAspect, $('.col')?.clientWidth || BASE_W);
    return Math.min(3, Math.max(0.3, w / BASE_W));
  }
  return Math.min(3, Math.max(0.4, Number(z) || 1));
}

// keep the page you're looking at in place while sizes change
function captureAnchor() {
  const y = topOffset() + ($('.doc-head')?.offsetHeight || 0) + 24;
  const x = active.root.getBoundingClientRect().left + active.root.clientWidth / 2;
  const art = document.elementFromPoint(x, y)?.closest?.('.page');
  if (!art) return null;
  const r = art.getBoundingClientRect();
  return { art, y, ratio: (y - r.top) / Math.max(1, r.height) };
}
function restoreAnchor(a) {
  if (!a || !a.art.isConnected) return;
  const r = a.art.getBoundingClientRect();
  window.scrollBy({ top: r.top + a.ratio * r.height - a.y, behavior: 'instant' });
}

let zoomTimer;
function applyZoom() {
  const anchor = captureAnchor();
  document.documentElement.style.setProperty('--z', zoomValue().toFixed(4));
  syncControls();
  restoreAnchor(anchor);
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    // redraw original pages at the new size so they stay sharp
    const a = captureAnchor();
    for (const art of active.pageEls.values()) if (art._cleanup) refill(art);
    requestAnimationFrame(() => restoreAnchor(a));
  }, 260);
}
function setZoom(z) {
  prefs.zoom = z;
  savePrefs();
  applyZoom();
}
function zoomBy(dir) {
  const cur = zoomValue();
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.01);
  setZoom(next ?? (dir > 0 ? 3 : 0.5));
}

// ---------- smart navigation ----------
function hitPages(v) {
  const arr = [];
  for (const R of v.list) for (const p of R.pages) if (p.ranges.length) arr.push({ R, p });
  return arr;
}
// Which hit page is "current": the one holding the current hit, or the one on screen if you've scrolled away.
function pageCursor(v, arr) {
  const moved = v.navY == null || Math.abs(scrollY - v.navY) > innerHeight * 0.8;
  if (v.cur >= 0 && !moved) {
    return { i: arr.findIndex((x) => v.cur >= x.p.h0 && v.cur < x.p.h0 + x.p.ranges.length), inside: true };
  }
  const top = topOffset() + ($('.doc-head')?.offsetHeight || 0);
  let lo = 0, hi = arr.length - 1, idx = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = v.pageEls.get(pkey(arr[mid].R.doc.id, arr[mid].p.n));
    const r = a ? a.getBoundingClientRect() : { bottom: 0 };
    if (r.bottom > top + 40) { idx = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (idx >= arr.length) return { i: arr.length - 1, inside: true };
  const a = v.pageEls.get(pkey(arr[idx].R.doc.id, arr[idx].p.n));
  return { i: idx, inside: a ? a.getBoundingClientRect().top < top + 60 : true };
}
function stepPage(dir) {
  const v = active;
  const arr = hitPages(v);
  if (!arr.length) return;
  const { i, inside } = pageCursor(v, arr);
  let t = dir > 0 ? (inside ? i + 1 : i) : i - 1;
  t = ((t % arr.length) + arr.length) % arr.length;
  goTo(v, arr[t].p.h0);
}
function stepDoc(dir) {
  const v = active;
  const arr = hitPages(v);
  if (!arr.length) return;
  const { i, inside } = pageCursor(v, arr);
  const docId = arr[i].R.doc.id;
  if (dir > 0) {
    let t = arr.findIndex((x, k) => k > i && x.R.doc.id !== docId);
    if (!inside && t < 0) t = i;
    goTo(v, arr[t < 0 ? 0 : t].p.h0);
  } else {
    // start of this document if we're past its first hit, otherwise the previous document
    let start = i;
    while (start > 0 && arr[start - 1].R.doc.id === docId) start--;
    const atStart = v.cur === arr[start].p.h0 && !(v.navY == null || Math.abs(scrollY - v.navY) > innerHeight * 0.8);
    if (!atStart) { goTo(v, arr[start].p.h0); return; }
    let t = start - 1;
    if (t < 0) t = arr.length - 1;
    const prevDoc = arr[t].R.doc.id;
    while (t > 0 && arr[t - 1].R.doc.id === prevDoc) t--;
    goTo(v, arr[t].p.h0);
  }
}
function pan(dir) {
  window.scrollBy({ top: dir * (innerHeight - topOffset()) * 0.5, behavior: reduceMotion() ? 'instant' : 'smooth' });
}
function currentDocAndPage() {
  const y = topOffset() + ($('.doc-head')?.offsetHeight || 0) + 24;
  const art = document.elementFromPoint(active.root.getBoundingClientRect().left + 40, y)?.closest?.('.page');
  return art ? { docId: art.dataset.doc, n: Number(art.dataset.n) } : null;
}

// ---------- keyboard shortcuts ----------
const MOD = isMac ? 'Cmd' : 'Ctrl';
const ACTIONS = [
  { group: 'Move through results' },
  { id: 'nextHit', label: 'Next hit', keys: ['N', 'F3'], run: () => step(1) },
  { id: 'prevHit', label: 'Previous hit', keys: ['Shift+N', 'Shift+F3'], run: () => step(-1) },
  { id: 'nextPage', label: 'Next page with hits', keys: [']', 'J'], run: () => stepPage(1) },
  { id: 'prevPage', label: 'Previous page with hits', keys: ['[', 'K'], run: () => stepPage(-1) },
  { id: 'nextDoc', label: 'Next document with hits', keys: ['Shift+]'], run: () => stepDoc(1) },
  { id: 'prevDoc', label: 'Previous document with hits', keys: ['Shift+['], run: () => stepDoc(-1) },
  { id: 'firstHit', label: 'First hit', keys: ['G'], run: () => goTo(active, 0) },
  { id: 'lastHit', label: 'Last hit', keys: ['Shift+G'], run: () => goTo(active, active.total - 1) },
  { id: 'panDown', label: 'Pan down half a screen', keys: ['Shift+J'], run: () => pan(1) },
  { id: 'panUp', label: 'Pan up half a screen', keys: ['Shift+K'], run: () => pan(-1) },
  { group: 'Search' },
  { id: 'focusSearch', label: 'Go to the search box', keys: ['/', `${MOD}+K`, `${MOD}+F`], run: () => { q.focus(); q.select(); } },
  ...Object.keys(MODES).map((m, i) => ({ id: `mode_${m}`, label: `Search type: ${MODES[m].label}`, keys: [`Alt+${i + 1}`], run: () => setMode(m) })),
  { id: 'toggleCase', label: 'Match case on/off', keys: ['Alt+C'], run: () => { prefs.matchCase = !prefs.matchCase; runSearch(); } },
  { id: 'toggleWord', label: 'Whole words on/off', keys: ['Alt+W'], run: () => { prefs.wholeWord = !prefs.wholeWord; runSearch(); } },
  { group: 'View' },
  { id: 'zoomIn', label: 'Zoom in', keys: ['=', 'Shift+='], run: () => zoomBy(1) },
  { id: 'zoomOut', label: 'Zoom out', keys: ['-'], run: () => zoomBy(-1) },
  { id: 'zoomReset', label: 'Zoom 100%', keys: ['0'], run: () => setZoom(1) },
  { id: 'fitWidth', label: 'Fit width', keys: ['W'], run: () => setZoom('width') },
  { id: 'fitPage', label: 'Fit page', keys: ['F'], run: () => setZoom('page') },
  { id: 'toggleView', label: 'PDF pages: text / original', keys: ['O'], run: () => setView(prefs.view === 'text' ? 'original' : 'text') },
  { id: 'toggleCompact', label: 'Minimize / show the toolbar', keys: ['H'], run: () => toggleCompact() },
  { id: 'toggleLibrary', label: 'Hide / show the library', keys: ['L'], run: () => toggleLibrary() },
  { id: 'readDoc', label: 'Read the whole document you’re on', keys: ['R'], run: () => { const c = currentDocAndPage(); if (c && active === results) openReader(c.docId, c.n); } },
  { id: 'back', label: 'Back to results', keys: ['Escape', 'B'], run: () => closeReader() },
  { id: 'openKeys', label: 'Show these shortcuts', keys: ['Shift+/'], run: () => openKeys() },
];
const actionById = (id) => ACTIONS.find((a) => a.id === id);
const bindings = (a) => prefs.keys?.[a.id] ?? a.keys;
let keyMap = new Map();
function buildKeyMap() {
  keyMap = new Map();
  for (const a of ACTIONS) if (a.id) for (const k of bindings(a)) if (!keyMap.has(k)) keyMap.set(k, a);
}
function keyHint(id) {
  const k = bindings(actionById(id))[0];
  return k ? comboLabel(k) : 'no key';
}
function setBindings(id, keys) {
  const a = actionById(id);
  prefs.keys = { ...(prefs.keys || {}) };
  if (JSON.stringify(keys) === JSON.stringify(a.keys)) delete prefs.keys[id];
  else prefs.keys[id] = keys;
  savePrefs();
  buildKeyMap();
  renderKeys();
  syncControls();
}

let recording = null; // action id waiting for a key
function openKeys() {
  closeMenu();
  recording = null;
  renderKeys();
  $('#keys').showModal();
}
function renderKeys() {
  const list = $('#keysList');
  let html = '';
  for (const a of ACTIONS) {
    if (a.group) { html += `<h4>${esc(a.group)}</h4>`; continue; }
    const keys = bindings(a);
    const custom = !!prefs.keys?.[a.id];
    const chips = keys.map((k) => `<button class="kchip" data-id="${a.id}" data-key="${esc(k)}" title="Remove this key"><kbd>${esc(comboLabel(k))}</kbd>${I.x}</button>`).join('');
    const rec = recording === a.id;
    html += `<div class="krow${rec ? ' rec' : ''}"><span class="klabel">${esc(a.label)}</span><span class="kkeys">${chips}${rec ? '<span class="krec">Press a key… <em>Esc to cancel</em></span>' : `<button class="kadd" data-id="${a.id}" title="Add a key">${I.plus}</button>`}${custom ? `<button class="kreset" data-id="${a.id}" title="Back to default">Reset</button>` : ''}</span></div>`;
  }
  list.innerHTML = html;
}

function toggleCompact() {
  prefs.compact = !prefs.compact;
  savePrefs();
  const a = captureAnchor();
  updateChrome();
  requestAnimationFrame(() => { restoreAnchor(a); if (prefs.zoom === 'page') applyZoom(); });
}
// ---------- resizable library ----------
const SIDE_MIN = 200;
const SIDE_DEFAULT = 288;
const sideMax = () => Math.max(SIDE_MIN, Math.min(640, Math.round(innerWidth * 0.5)));
function applySideWidth(w) {
  if (w == null) document.documentElement.style.removeProperty('--side-w-user');
  else document.documentElement.style.setProperty('--side-w-user', Math.round(w) + 'px');
}
function bindSideResize() {
  const handle = $('#sideResize');
  let drag = null;
  let raf = 0;
  const finish = () => {
    if (prefs.zoom === 'width') applyZoom();
    savePrefs();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { left: $('.sidebar').getBoundingClientRect().left, w: prefs.sideW || SIDE_DEFAULT };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('side-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const raw = e.clientX - drag.left;
    // drag far enough left and letting go hides the library
    document.body.classList.toggle('side-collapsing', raw < 140);
    const w = Math.max(SIDE_MIN, Math.min(sideMax(), raw));
    drag.cur = raw;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { prefs.sideW = w; applySideWidth(w); });
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.body.classList.remove('side-resizing', 'side-collapsing');
    if (d.cur != null && d.cur < 140) {
      prefs.sideW = d.w;
      applySideWidth(d.w);
      toggleLibrary();
      toast(`Library hidden — press ${keyHint('toggleLibrary')} or ☰ to bring it back`, { ms: 2600 });
    }
    finish();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { delete prefs.sideW; applySideWidth(null); finish(); });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = Math.max(SIDE_MIN, Math.min(sideMax(), (prefs.sideW || SIDE_DEFAULT) + (e.key === 'ArrowRight' ? 24 : -24)));
    prefs.sideW = w;
    applySideWidth(w);
    finish();
  });
}

function toggleLibrary() {
  if (innerWidth <= 900) { document.body.classList.toggle('drawer'); return; }
  prefs.sideHidden = !prefs.sideHidden;
  savePrefs();
  syncControls();
  if (prefs.zoom === 'width') applyZoom();
}
function setView(view) {
  if (prefs.view === view) return;
  prefs.view = view;
  savePrefs();
  override.clear();
  syncControls();
  refreshInPlace(active);
  if (active === reader) results.dirty = true;
}

// ---------- search type pill: tap for options, press and drag sideways to switch ----------
function modeMenu(anchor) {
  const items = Object.keys(MODES).map((m, i) => ({ label: MODES[m].label, checked: prefs.mode === m, run: () => setMode(m) }));
  items.push({ sep: true });
  items.push({ label: 'Match case', checked: prefs.matchCase, run: () => { prefs.matchCase = !prefs.matchCase; runSearch(); } });
  items.push({ label: 'Whole words only', checked: prefs.wholeWord, disabled: prefs.mode === 'regex', run: () => { prefs.wholeWord = !prefs.wholeWord; runSearch(); } });
  if (prefs.mode === 'near') {
    items.push({ header: 'Near: words apart' });
    for (const n of [3, 5, 8, 12, 20, 40]) items.push({ label: `Within ${n} words`, checked: Number(prefs.near) === n, run: () => { prefs.near = n; runSearch(); } });
  }
  items.push({ sep: true }, { label: 'Show the full toolbar', run: () => toggleCompact() });
  openMenu(anchor, items);
}

function bindModeScrub(el, { onTap, startIndex }) {
  const modes = Object.keys(MODES);
  let st = null;
  const show = () => {
    st.scrub = true;
    clearTimeout(st.timer);
    closeMenu();
    const bar = el.ownerDocument.createElement('div');
    bar.className = 'scrubber';
    const names = innerWidth < 600 ? MODE_TINY : MODE_SHORT;
    bar.innerHTML = modes.map((m) => `<span data-mode="${m}">${names[m]}</span>`).join('');
    document.body.append(bar);
    const r = el.getBoundingClientRect();
    const item = bar.children[st.idx];
    const center = item.offsetLeft + item.offsetWidth / 2;
    let left = st.x - center;
    left = Math.max(8, Math.min(innerWidth - bar.offsetWidth - 8, left));
    bar.style.left = left + 'px';
    bar.style.top = (r.bottom + 8 + bar.offsetHeight > innerHeight - 8 ? r.top - bar.offsetHeight - 10 : r.bottom + 8) + 'px';
    st.bar = bar;
    mark();
    el.classList.add('scrubbing');
  };
  const mark = () => [...st.bar.children].forEach((c, i) => c.classList.toggle('on', i === st.idx));
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    st = { x: e.clientX, idx: startIndex(e), scrub: false, id: e.pointerId };
    if (st.idx < 0) { st = null; return; }
    el.setPointerCapture(e.pointerId);
    st.timer = setTimeout(show, 260);
  });
  el.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.scrub && Math.abs(e.clientX - st.x) > 8) show();
    if (!st.scrub) return;
    const kids = [...st.bar.children];
    let i = kids.findIndex((c) => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX < r.right; });
    if (i < 0) i = e.clientX < kids[0].getBoundingClientRect().left ? 0 : kids.length - 1;
    if (i !== st.idx) { st.idx = i; mark(); navigator.vibrate?.(4); }
  });
  const end = (apply) => {
    if (!st) return;
    clearTimeout(st.timer);
    const s = st;
    st = null;
    el.classList.remove('scrubbing');
    if (s.bar) { s.bar.classList.add('out'); setTimeout(() => s.bar.remove(), 150); }
    if (s.scrub) { if (apply) setMode(modes[s.idx]); }
    else if (apply) onTap(s);
  };
  el.addEventListener('pointerup', () => end(true));
  el.addEventListener('pointercancel', () => end(false));
  el.addEventListener('lostpointercapture', () => end(false));
  el.addEventListener('click', (e) => {
    e.stopPropagation(); // the pointer handlers already acted; don't let the page close a menu we just opened
    if (e.detail === 0) onTap({ idx: startIndex(e) }); // keyboard activation
  });
}

// Press and hold (or press and slide) opens the menu; slide onto an option and let go to pick it.
// A plain tap opens the same menu to tap through.
function bindHoldMenu(el, getItems) {
  let st = null;
  const hot = (x, y) => {
    let found = null;
    for (const it of $$('.pop-menu .menu-item')) {
      const r = it.getBoundingClientRect();
      const on = !it.disabled && y >= r.top && y < r.bottom && x > r.left - 60 && x < r.right + 60;
      it.classList.toggle('hot', on);
      if (on) found = it;
    }
    if (found && st && found !== st.last) { st.last = found; navigator.vibrate?.(4); }
    return found;
  };
  const open = () => {
    st.open = true;
    clearTimeout(st.timer);
    closeMenu();
    openMenu(el, getItems());
    el.classList.add('holding');
    navigator.vibrate?.(8);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const wasOpen = el.classList.contains('menu-open');
    st = { x: e.clientX, y: e.clientY, open: false, wasOpen };
    el.setPointerCapture(e.pointerId);
    st.timer = setTimeout(open, 240);
  });
  el.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.open && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 10) open();
    if (st.open) hot(e.clientX, e.clientY);
  });
  const end = (e, apply) => {
    if (!st) return;
    clearTimeout(st.timer);
    const s = st;
    st = null;
    el.classList.remove('holding');
    if (s.open) {
      const target = apply && e ? hot(e.clientX, e.clientY) : null;
      if (target) target.click();
      else if (apply && e && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) closeMenu(); // slid off: nothing picked
      // held still and let go: leave the menu open to tap
    } else if (apply) {
      if (s.wasOpen) closeMenu(); else openMenu(el, getItems());
    }
  };
  el.addEventListener('pointerup', (e) => end(e, true));
  el.addEventListener('pointercancel', () => end(null, false));
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.detail === 0) openMenu(el, getItems());
  });
}

function moreItems() {
  const items = [];
  if (S.docs.some(hasOriginal)) {
    items.push({ header: 'Pages' },
      { label: 'Text', icon: I.text, checked: prefs.view === 'text', run: () => setView('text') },
      { label: 'Original', icon: I.image, checked: prefs.view === 'original', run: () => setView('original') });
  }
  items.push({ header: `Zoom · ${Math.round(zoomValue() * 100)}%` },
    { label: 'Zoom in', icon: I.plus, run: () => zoomBy(1) },
    { label: 'Zoom out', icon: I.minus, run: () => zoomBy(-1) },
    { label: 'Fit width', icon: I.fitW, checked: prefs.zoom === 'width', run: () => setZoom(prefs.zoom === 'width' ? 1 : 'width') },
    { label: 'Fit page', icon: I.fitP, checked: prefs.zoom === 'page', run: () => setZoom(prefs.zoom === 'page' ? 1 : 'page') });
  items.push({ header: 'Search' },
    { label: 'Match case', checked: prefs.matchCase, run: () => { prefs.matchCase = !prefs.matchCase; runSearch(); } },
    { label: 'Whole words only', checked: prefs.wholeWord, disabled: prefs.mode === 'regex', run: () => { prefs.wholeWord = !prefs.wholeWord; runSearch(); } });
  if (active === results) {
    items.push({ header: 'Sort' },
      ...[['library', 'Library order'], ['hits', 'Documents with most hits'], ['pages', 'Pages with most hits']].map(([k, label]) => ({ label, checked: prefs.sort === k, run: () => { prefs.sort = k; runSearch(); } })));
  }
  items.push({ sep: true });
  if (active === reader) items.push({ label: 'Back to results', icon: I.arrowLeft, run: () => closeReader() });
  items.push({ label: 'Library', icon: I.folder, run: () => toggleLibrary() });
  return items;
}

// Slide along the hit counter to scrub through hits one by one; tap it for the next hit.
function bindJog(el) {
  let j = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !active.total) return;
    const v = active;
    const moved = v.navY == null || Math.abs(scrollY - v.navY) > innerHeight * 0.8;
    j = { x: e.clientX, start: v.cur >= 0 && !moved ? v.cur : Math.max(0, startFromViewport(v, 1)), moved: false, last: v.cur };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!j) return;
    const dx = e.clientX - j.x;
    if (!j.moved && Math.abs(dx) > 8) { j.moved = true; el.classList.add('jogging'); }
    if (!j.moved) return;
    const k = Math.max(0, Math.min(active.total - 1, j.start + Math.trunc(dx / 22)));
    if (k !== j.last) { j.last = k; navigator.vibrate?.(3); goTo(active, k, { instant: true }); }
  });
  const end = (apply) => {
    if (!j) return;
    const s = j;
    j = null;
    el.classList.remove('jogging');
    if (!s.moved && apply) step(1);
  };
  el.addEventListener('pointerup', () => end(true));
  el.addEventListener('pointercancel', () => end(false));
  el.addEventListener('click', (e) => { e.stopPropagation(); if (e.detail === 0) step(1); });
}

// On phones the top bar slides away while you read and comes back when you scroll up.
let lastScrollY = 0;
let scrollAcc = 0;
function setBarHidden(h) {
  if (document.body.classList.contains('bar-hidden') !== h) document.body.classList.toggle('bar-hidden', h);
}
function onScrollBars() {
  const y = scrollY;
  const dy = y - lastScrollY;
  lastScrollY = y;
  if (!isPhone() || y < 60 || document.activeElement === q || document.body.classList.contains('drawer') || $('.pop-menu')) {
    setBarHidden(false);
    scrollAcc = 0;
    return;
  }
  scrollAcc = Math.sign(dy) === Math.sign(scrollAcc) ? scrollAcc + dy : dy;
  if (scrollAcc > 30) setBarHidden(true);
  else if (scrollAcc < -30) setBarHidden(false);
}

function setMode(mode) {
  if (!MODES[mode] || prefs.mode === mode) return;
  prefs.mode = mode;
  syncControls();
  runSearch();
}

// ---------- start ----------
async function start() {
  applyTheme();
  $('#modes').innerHTML = Object.entries(MODES)
    .map(([k, m], i) => `<button data-mode="${k}" title="${m.hint} (Alt+${i + 1})">${m.label}</button>`)
    .join('');
  buildKeyMap();
  bind();
  q.value = prefs.q || '';
  document.documentElement.style.setProperty('--z', '1');
  if (prefs.sideW) applySideWidth(Math.min(prefs.sideW, sideMax()));
  syncControls();
  try {
    const [docs, texts, folders] = await Promise.all([store.allDocs(), store.allTexts(), store.allFolders()]);
    S.folders = folders.sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const t of texts) S.texts.set(t.id, t.pages);
    S.docs = docs.filter((d) => S.texts.has(d.id)).sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (e) {
    toast('This browser is blocking local storage, so documents won’t be kept after you close the page.');
  }
  runSearch();
  applyZoom();
  updateStorage();
  document.body.classList.add('ready');
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!matchMedia('(pointer: coarse)').matches && S.docs.length) q.focus();
}

start();
