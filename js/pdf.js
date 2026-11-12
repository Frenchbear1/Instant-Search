// PDF helpers shared by ingest (text extraction) and the original-page view (canvas + highlight boxes).
// The same textFromItems() runs in both places, so stored character offsets line up with the page's text items.

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

export const EXTRACTOR_VERSION = 1;

export function textFromItems(items) {
  let text = '';
  const map = []; // [textStart, itemIndex, length]
  let prev = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!('str' in it)) continue;
    const s = it.str.normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    const tr = it.transform;
    const x = tr[4];
    const y = tr[5];
    const h = Math.hypot(tr[2], tr[3]) || it.height || 10;
    if (prev) {
      const lh = Math.max(h, prev.h);
      const dy = Math.abs(y - prev.y);
      if (prev.eol || dy > lh * 0.55) {
        if (s || !prev.eol) {
          const para = dy > lh * 1.75;
          if (!text.endsWith('\n')) text += para ? '\n\n' : '\n';
          else if (para && !text.endsWith('\n\n')) text += '\n';
        }
      } else if (s) {
        const gap = x - prev.xEnd;
        if (gap > lh * 0.15 && !/\s$/.test(text) && !/^\s/.test(s)) text += ' ';
      }
    }
    if (s) {
      map.push([text.length, i, s.length]);
      text += s;
    }
    if (s || it.hasEOL) prev = { y, h: s ? h : prev ? prev.h : h, xEnd: x + (it.width || 0), eol: !!it.hasEOL };
  }
  return { text, map };
}

export async function extractPdf(bytes, onProgress) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(textFromItems(content.items).text);
      page.cleanup();
      onProgress?.(n, doc.numPages);
    }
  } finally {
    doc.destroy();
  }
  return pages;
}

// ---------- original page view ----------
// Where character i falls inside a text run, using real glyph widths rather than equal-width characters.
const measureCtx = document.createElement('canvas').getContext('2d');
function fraction(str, i, family) {
  if (i <= 0) return 0;
  if (i >= str.length) return 1;
  measureCtx.font = `100px ${family}`;
  const total = measureCtx.measureText(str).width;
  return total > 0 ? measureCtx.measureText(str.slice(0, i)).width / total : i / str.length;
}

const openDocs = new Map(); // docId -> Promise<PDFDocumentProxy>

export function getPdf(docId, loadBytes) {
  if (!openDocs.has(docId)) {
    openDocs.set(
      docId,
      loadBytes().then((bytes) => {
        if (!bytes) throw new Error('Original file not stored');
        return pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
      })
    );
    openDocs.get(docId).catch(() => openDocs.delete(docId));
  }
  return openDocs.get(docId);
}

export function closePdf(docId) {
  const p = openDocs.get(docId);
  if (p) { p.then((d) => d.destroy()).catch(() => {}); openDocs.delete(docId); }
}

/**
 * Render page n (0-based) into `host`. ranges: [[start,end,color,hitIndex|null]]
 * Returns a cleanup function.
 */
export async function renderPdfPage(pdf, n, host, ranges) {
  const page = await pdf.getPage(n + 1);
  const base = page.getViewport({ scale: 1 });
  const cssWidth = host.clientWidth || 700;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const scale = Math.min((cssWidth * dpr) / base.width, 4);
  const vp = page.getViewport({ scale });

  const frame = document.createElement('div');
  frame.className = 'pdf-frame';
  frame.style.aspectRatio = `${base.width} / ${base.height}`;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const layer = document.createElement('div');
  layer.className = 'pdf-hits';
  frame.append(canvas, layer);
  host.replaceChildren(frame);

  const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });

  if (ranges.length) {
    const content = await page.getTextContent();
    const { map } = textFromItems(content.items);
    const items = content.items;
    const starts = map.map((m) => m[0]);
    const frag = document.createDocumentFragment();
    for (const [s, e, color, h] of ranges) {
      let lo = 0, hi = starts.length - 1, k = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= s) { k = mid; lo = mid + 1; } else hi = mid - 1;
      }
      let first = true;
      for (; k < map.length && map[k][0] < e; k++) {
        const [ts, idx, len] = map[k];
        const te = ts + len;
        if (te <= s) continue;
        const it = items[idx];
        const tx = pdfjsLib.Util.transform(base.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]) || 10;
        const w = (it.width || 0) * base.scale;
        const cs = Math.max(s, ts) - ts;
        const ce = Math.min(e, te) - ts;
        const str = it.str.normalize('NFKC');
        const family = content.styles?.[it.fontName]?.fontFamily || 'sans-serif';
        const left = tx[4] + w * fraction(str, cs, family);
        const right = tx[4] + w * fraction(str, ce, family);
        const top = tx[5] - fh * 0.92;
        const box = document.createElement('div');
        box.className = `box ${h != null ? 'm' : 's'} c${color}`;
        if (h != null) box.dataset.h = h;
        if (!first) box.dataset.cont = '1';
        first = false;
        box.style.left = `${(left / base.width) * 100}%`;
        box.style.top = `${(top / base.height) * 100}%`;
        box.style.width = `${(Math.max(right - left, 2) / base.width) * 100}%`;
        box.style.height = `${((fh * 1.12) / base.height) * 100}%`;
        frag.append(box);
      }
    }
    layer.append(frag);
  }
  try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') throw e; }
  page.cleanup();
  return () => { task.cancel(); canvas.width = canvas.height = 0; };
}
