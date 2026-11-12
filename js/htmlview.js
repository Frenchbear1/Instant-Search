// Shows an uploaded HTML file as it really looks, inside a locked-down frame:
// no scripts run (sandbox without allow-scripts), nothing is fetched except images/styles/fonts,
// links and forms do nothing. Search words are highlighted inside it.
import { store } from './store.js';

const raws = new Map(); // docId -> Promise<string|null>

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline' https: http:; font-src data: https: http:; media-src data: https: http:">`;
const STYLE = `<style id="__is_style">
mark.__is{color:inherit;border-radius:2px;padding:0 1px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
mark.__is.c0{background:#ffe37a}mark.__is.c1{background:#b5dcff}mark.__is.c2{background:#bdf0c4}
mark.__is.c3{background:#ffc7da}mark.__is.c4{background:#dcccff}mark.__is.c5{background:#ffd6a8}
mark.__is.cur{background:#ff6a13;color:#fff;box-shadow:0 0 0 2px #ff6a13}
</style>`;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'TITLE']);

export function forgetHtml(docId) {
  raws.delete(docId);
}

/**
 * Renders the document into `host`, scrolled to the `ordinal`-th highlighted match
 * (or proportionally to page n when there's nothing to point at). Returns a cleanup function.
 */
export async function renderHtmlPage({ docId, n, pageCount, host, matcher, ordinal, zoom }) {
  if (!raws.has(docId)) raws.set(docId, store.file(docId).then((r) => (r == null ? null : typeof r === 'string' ? r : new TextDecoder().decode(r))));
  const html = await raws.get(docId);
  if (html == null) throw new Error('the original file wasn’t stored');

  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = 'Original HTML';
  // keep any <!doctype> first so the page renders in the same mode it was written for
  frame.srcdoc = html.replace(/^(\s*<!doctype[^>]*>)?/i, (m) => m + CSP + STYLE);
  // If something is already showing, load the new frame invisibly on top and swap when it's ready.
  const swapping = host.childElementCount > 0;
  if (swapping) frame.classList.add('pending');
  host.append(frame);
  await new Promise((r) => frame.addEventListener('load', r, { once: true }));
  const d = frame.contentDocument;
  if (!d || !d.body) return () => frame.remove();
  if (zoom && zoom !== 1) d.documentElement.style.zoom = String(zoom);

  // links would navigate the frame away; forms are already blocked by the sandbox
  d.addEventListener('click', (e) => { if (e.target.closest?.('a')) e.preventDefault(); }, true);

  const marks = [];
  if (matcher) {
    const nodes = [];
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.data.trim() && !SKIP.has(t.parentNode?.nodeName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const ranges = matcher.soft(node.data);
      if (!ranges.length) continue;
      const frag = d.createDocumentFragment();
      let pos = 0;
      for (const [s, e, c] of ranges) {
        if (s < pos) continue;
        if (s > pos) frag.append(node.data.slice(pos, s));
        const m = d.createElement('mark');
        m.className = `__is c${c}`;
        m.textContent = node.data.slice(s, e);
        frag.append(m);
        marks.push(m);
        pos = e;
      }
      if (pos < node.data.length) frag.append(node.data.slice(pos));
      node.replaceWith(frag);
    }
  }

  const se = d.scrollingElement || d.documentElement;
  const target = marks.length ? marks[Math.max(0, Math.min(ordinal || 0, marks.length - 1))] : null;
  if (target) {
    target.classList.add('cur');
    const r = target.getBoundingClientRect();
    se.scrollTop = r.top + se.scrollTop - frame.clientHeight / 3;
  } else if (pageCount > 1) {
    se.scrollTop = (n / pageCount) * Math.max(0, se.scrollHeight - frame.clientHeight);
  }
  if (swapping) {
    for (const c of [...host.children]) if (c !== frame) c.remove();
    frame.classList.remove('pending');
  }
  return () => frame.remove();
}
