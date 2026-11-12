import { compile, MODES } from './search.js';
import { store } from './store.js';
import { readFile, kindOf, ACCEPT } from './ingest.js';
import { getPdf, closePdf, renderPdfPage, EXTRACTOR_VERSION } from './pdf.js';

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
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
};

// ---------- preferences ----------
const PREF_KEY = 'instant-search:prefs';
const prefs = Object.assign(
  { mode: 'all', matchCase: false, wholeWord: false, near: 8, sort: 'library', view: 'text', theme: 'auto', q: '' },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })()
);
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

// ---------- state ----------
const S = {
  docs: [],            // metadata, library order
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

  assign(results, computeHits(S.docs.filter((d) => d.enabled && searchable(d))));
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
function pageMode(doc, n) {
  if (doc.kind !== 'pdf') return 'text';
  const o = override.get(pkey(doc.id, n));
  if (o) return o;
  // a page with no extractable text (a scan) is only useful as the original
  if (!(S.texts.get(doc.id)?.[n] || '').trim()) return 'original';
  return prefs.view;
}

function estimate(doc, n) {
  const w = results.root.clientWidth || reader.root.clientWidth || 720;
  if (pageMode(doc, n) === 'original') return Math.round(Math.min(w, 860) * S.pageAspect) + 56;
  const chars = (S.texts.get(doc.id)?.[n] || '').length;
  return Math.max(150, Math.round(chars * S.pxPerChar) + 80);
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
  const toggle = doc.kind === 'pdf'
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
    if (pageMode(doc, n) === 'original') {
      body.classList.add('loading');
      try {
        const pdf = await getPdf(doc.id, () => store.file(doc.id));
        if (token !== art._token) return;
        const cleanup = await renderPdfPage(pdf, n, body, ranges);
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
      const ratio = (body.offsetHeight - 40) / text.length;
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
  return `<span class="ftype ${doc.kind}">${KIND_LABEL[doc.kind] || 'TXT'}</span><h2 title="${esc(doc.name)}">${esc(doc.name)}</h2><span class="dstat">${stat}</span><span class="grow"></span>${btn}`;
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
  const ready = S.docs.filter(searchable);
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
  return ($('.topbar')?.offsetHeight || 0) + 8;
}

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

async function goTo(v, k) {
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
  v.navY = scrollToEl(target, 'center');
  target.classList.remove('pulse');
  void target.offsetWidth;
  target.classList.add('pulse');
  await settle(v, k, target, Math.abs(v.navY - startY) > innerHeight * 2.5);
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
  } else if (S.matcher && v.list.length) {
    const pages = v.list.reduce((a, R) => a + R.pages.length, 0);
    const docCount = new Set(v.list.map((R) => R.doc.id)).size;
    const scope = S.docs.filter((d) => d.enabled && searchable(d)).length;
    html += `<span class="stat"><b>${fmt(v.total)}</b> ${v.total === 1 ? 'hit' : 'hits'} on <b>${fmt(pages)}</b> ${pages === 1 ? 'page' : 'pages'} in <b>${fmt(docCount)}</b> of ${plural(scope, 'document')}</span>`;
  }
  if (S.matcher && S.terms.length) {
    const counts = termCounts(v);
    const chips = S.terms.map((t) => t.neg
      ? `<span class="term neg" title="Pages with this are excluded">−${esc(t.label)}</span>`
      : `<button class="term c${t.color}" data-color="${t.color}" title="Jump to next “${esc(t.label)}”"><i></i>${esc(t.label)}<span>${fmt(counts.get(t.color) || 0)}</span></button>`);
    html += `<span class="terms">${chips.join('')}</span>`;
  }
  box.innerHTML = html;
  box.hidden = !html;
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

function renderLibrary() {
  const ul = $('#lib');
  const hits = new Map();
  for (const R of results.list) hits.set(R.doc.id, (hits.get(R.doc.id) || 0) + R.hits);
  const ready = S.docs.filter(searchable);
  $('#libCount').textContent = S.docs.length ? `${ready.filter((d) => d.enabled).length}/${ready.length}` : '';
  $('#toggleAll').hidden = ready.length < 2;
  $('#toggleAll').textContent = ready.every((d) => d.enabled) ? 'None' : 'All';
  ul.innerHTML = S.docs.map((d) => {
    const count = S.texts.get(d.id)?.length || d.pages || 0;
    const meta = d.status === 'indexing'
      ? `Reading… ${d.progress ? Math.round(d.progress * 100) + '%' : ''}`
      : `${plural(count, 'page')}${d.noText ? ' · <span class="warn">no text found</span>' : ''}`;
    const h = S.matcher && d.enabled && !d.status ? `<span class="lhits${hits.get(d.id) ? '' : ' zero'}">${fmt(hits.get(d.id) || 0)}</span>` : '';
    return `<li class="lib-item${d.enabled ? ' on' : ''}${d.status ? ' busy' : ''}${reader.docId === d.id && active === reader ? ' reading' : ''}" data-id="${d.id}">
      <label class="chk" title="Include in search"><input type="checkbox" ${d.enabled ? 'checked' : ''} ${d.status ? 'disabled' : ''}><span></span></label>
      <button class="lib-main" data-act="read" title="${esc(d.name)}"><span class="lname">${esc(d.name)}</span><span class="lmeta"><span class="ftype ${d.kind}">${KIND_LABEL[d.kind]}</span>${meta}</span></button>
      ${h}
      <span class="lib-acts"><button class="mini" data-act="solo" title="Search only this document">${I.target}</button><button class="mini" data-act="remove" title="Remove">${I.x}</button></span>
      ${d.status === 'indexing' ? `<div class="prog"><i style="width:${Math.round((d.progress || 0) * 100)}%"></i></div>` : ''}
    </li>`;
  }).join('');
  $('#libEmpty').hidden = !!S.docs.length;
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
  $('#viewSeg').hidden = !S.docs.some((d) => d.kind === 'pdf');
  $('#sortSel').parentElement.hidden = active === reader;
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

// ---------- adding files ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
let queue = Promise.resolve();

function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const bad = files.filter((f) => !kindOf(f.name));
  if (bad.length) toast(`Skipped ${bad.length === 1 ? `“${bad[0].name}”` : plural(bad.length, 'file')} — use PDF, Word (.docx), text, Markdown or HTML`);
  let order = S.docs.reduce((m, d) => Math.max(m, d.order || 0), 0);
  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) continue;
    if (S.docs.some((d) => d.name === file.name && d.size === file.size)) {
      toast(`“${file.name}” is already in your library`);
      continue;
    }
    const meta = { id: uid(), name: file.name, kind, size: file.size, addedAt: Date.now(), order: ++order, enabled: true, status: 'indexing', progress: 0, v: EXTRACTOR_VERSION };
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
    if (!S.docs.includes(meta)) return; // removed while reading
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
  $('#toasts').append(t);
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
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#addBtn').addEventListener('click', () => $('#fileInput').click());

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
    if (!b || prefs.view === b.dataset.view) return;
    prefs.view = b.dataset.view;
    savePrefs();
    override.clear();
    syncControls();
    refreshInPlace(active);
    if (active === reader) results.dirty = true;
  });
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
    const li = e.target.closest('.lib-item');
    if (li && e.target.type === 'checkbox') setEnabled(li.dataset.id, e.target.checked);
  });
  $('#lib').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const li = e.target.closest('.lib-item');
    if (!b || !li) return;
    const id = li.dataset.id;
    if (b.dataset.act === 'read') { if (!docById(id)?.status) { openReader(id); closeDrawer(); } }
    else if (b.dataset.act === 'solo') solo(id);
    else if (b.dataset.act === 'remove') removeDoc(id);
  });
  $('#toggleAll').addEventListener('click', toggleAll);
  $('#clearLib').addEventListener('click', async () => {
    if (!S.docs.length) return;
    if (!confirm(`Remove all ${plural(S.docs.length, 'document')} from this device?`)) return;
    finalizeRemoval();
    S.docs.forEach((d) => closePdf(d.id));
    S.docs = [];
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
    const mod = e.metaKey || e.ctrlKey;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((mod && (e.key === 'f' || e.key === 'k')) || (!typing && e.key === '/')) {
      e.preventDefault();
      q.focus();
      q.select();
    } else if (e.key === 'F3' || (mod && e.key.toLowerCase() === 'g')) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.altKey && /^Digit[1-6]$/.test(e.code)) {
      e.preventDefault();
      setMode(Object.keys(MODES)[Number(e.code.slice(5)) - 1]);
    } else if (!typing && e.key === 'Escape' && active === reader && !$('#help').open) {
      closeReader();
    } else if (!typing && !mod && (e.key === 'n' || e.key === 'N')) {
      step(e.shiftKey ? -1 : 1);
    }
  });

  // drag & drop anywhere
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  // mobile drawer
  $('#menuBtn').addEventListener('click', () => document.body.classList.toggle('drawer'));
  $('#scrim').addEventListener('click', closeDrawer);

  // keep the sticky offset accurate
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--top-h', $('.topbar').offsetHeight + 'px');
  }).observe($('.topbar'));
}
const closeDrawer = () => document.body.classList.remove('drawer');

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
  bind();
  q.value = prefs.q || '';
  syncControls();
  try {
    const [docs, texts] = await Promise.all([store.allDocs(), store.allTexts()]);
    for (const t of texts) S.texts.set(t.id, t.pages);
    S.docs = docs.filter((d) => S.texts.has(d.id)).sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (e) {
    toast('This browser is blocking local storage, so documents won’t be kept after you close the page.');
  }
  runSearch();
  updateStorage();
  document.body.classList.add('ready');
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!matchMedia('(pointer: coarse)').matches && S.docs.length) q.focus();
}

start();
