// Search engine: turns a query + options into a matcher that runs page by page.
// Pure functions, no DOM, so it can be tested on its own.

const W = '[\\p{L}\\p{N}_]';
const MAX_PER_TERM = 4000;

export const MODES = {
  any: { label: 'Any word', hint: 'Pages containing any of the words' },
  all: { label: 'All words', hint: 'Pages containing every word, in any order' },
  phrase: { label: 'Exact phrase', hint: 'The words together, in this order' },
  near: { label: 'Near', hint: 'All words within a few words of each other' },
  boolean: { label: 'Boolean', hint: 'AND, OR, NOT and (parentheses)' },
  regex: { label: 'Regex', hint: 'A JavaScript regular expression' },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeQuery(q) {
  return q.replace(/[“”„]/g, '"').replace(/ /g, ' ');
}

// One literal piece of a term -> regex source, tolerant of curly quotes and dash styles.
function pieceSource(p) {
  return escapeRe(p).replace(/['’‘]/g, "['’‘]").replace(/[–—]/g, '[-–—]');
}

function termSource(raw, wholeWord) {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const src = words
    .map((w) => w.split('*').map(pieceSource).join(`${W}*`))
    .join('\\s+');
  if (!src) return null;
  return wholeWord ? `(?<!${W})(?:${src})(?!${W})` : src;
}

function makeTerm(label, source, opts, neg = false) {
  return { label, re: new RegExp(source, 'g' + 'u' + (opts.matchCase ? '' : 'i')), neg };
}

// "quoted phrases", plain words and -exclusions
function splitTerms(q) {
  const out = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) {
      if (m[2].trim()) out.push({ text: m[2].trim(), neg: m[1] === '-' });
    } else {
      let t = m[3];
      let neg = false;
      if (t.length > 1 && t[0] === '-') { neg = true; t = t.slice(1); }
      if (t.replace(/\*/g, '')) out.push({ text: t, neg });
    }
  }
  // de-duplicate
  const seen = new Set();
  return out.filter((t) => {
    const k = (t.neg ? '-' : '') + t.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Boolean parser ----------
function tokenizeBoolean(q) {
  const toks = [];
  const re = /\s*(\(|\)|-?"[^"]*"?|[^\s()]+)/g;
  let m;
  while ((m = re.exec(q))) {
    const t = m[1];
    const up = t.toUpperCase();
    if (t === '(' || t === ')') toks.push({ k: t });
    else if (up === 'AND' || t === '&&' || t === '&') toks.push({ k: 'AND' });
    else if (up === 'OR' || t === '||' || t === '|') toks.push({ k: 'OR' });
    else if (up === 'NOT' || t === '!') toks.push({ k: 'NOT' });
    else {
      let neg = false;
      let s = t;
      if (s.length > 1 && s[0] === '-') { neg = true; s = s.slice(1); }
      if (s[0] === '"') s = s.replace(/^"|"$/g, '');
      if (!s.trim()) continue;
      if (neg) toks.push({ k: 'NOT' });
      toks.push({ k: 'TERM', text: s.trim() });
    }
  }
  return toks;
}

function parseBoolean(q) {
  const toks = tokenizeBoolean(q);
  const terms = [];
  const termIndex = new Map();
  let i = 0;
  const peek = () => toks[i];
  const termNode = (text, polarity) => {
    const key = text.toLowerCase();
    if (!termIndex.has(key)) { termIndex.set(key, terms.length); terms.push({ text, pos: false }); }
    const idx = termIndex.get(key);
    if (polarity) terms[idx].pos = true;
    return { type: 'term', idx };
  };
  function parseOr(pol) {
    const kids = [parseAnd(pol)];
    while (peek() && peek().k === 'OR') { i++; kids.push(parseAnd(pol)); }
    return kids.length === 1 ? kids[0] : { type: 'or', kids };
  }
  function parseAnd(pol) {
    const kids = [parseNot(pol)];
    while (peek() && peek().k !== 'OR' && peek().k !== ')') {
      if (peek().k === 'AND') i++;
      if (!peek() || peek().k === 'OR' || peek().k === ')') break;
      kids.push(parseNot(pol));
    }
    return kids.length === 1 ? kids[0] : { type: 'and', kids };
  }
  function parseNot(pol) {
    if (peek() && peek().k === 'NOT') { i++; return { type: 'not', kid: parseNot(!pol) }; }
    return parseAtom(pol);
  }
  function parseAtom(pol) {
    const t = peek();
    if (!t) throw new Error('Query ends too early');
    if (t.k === '(') {
      i++;
      const n = parseOr(pol);
      if (peek() && peek().k === ')') i++;
      return n;
    }
    if (t.k === 'TERM') { i++; return termNode(t.text, pol); }
    throw new Error(`Unexpected “${t.k === ')' ? ')' : t.k}”`);
  }
  if (!toks.length) return null;
  const ast = parseOr(true);
  while (i < toks.length) {
    // stray tokens such as unmatched ')' — tolerate by AND-ing what follows
    if (peek().k === ')') { i++; continue; }
    const rest = parseOr(true);
    return { ast: { type: 'and', kids: [ast, rest] }, terms };
  }
  return { ast, terms };
}

function evalAst(n, present) {
  switch (n.type) {
    case 'term': return present[n.idx];
    case 'and': return n.kids.every((k) => evalAst(k, present));
    case 'or': return n.kids.some((k) => evalAst(k, present));
    case 'not': return !evalAst(n.kid, present);
  }
  return false;
}

// ---------- matching helpers ----------
function findAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
    if (out.length >= MAX_PER_TERM) break;
  }
  return out;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;
function wordStarts(text) {
  const starts = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) starts.push(m.index);
  return starts;
}
function wordAt(starts, off) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function hasWithin(sortedWords, w, dist) {
  let lo = 0, hi = sortedWords.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sortedWords[mid];
    if (v < w - dist) lo = mid + 1;
    else if (v > w + dist) hi = mid - 1;
    else return true;
  }
  return false;
}

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  let end = -1;
  for (const r of ranges) {
    if (r[0] >= end) { out.push(r); end = r[1]; }
  }
  return out;
}

/**
 * compile(query, opts) -> matcher | {error} | null
 * opts: { mode, matchCase, wholeWord, near }
 * matcher.match(text) -> ranges [[start, end, termIdx], ...] if the page is a hit, else null
 * matcher.soft(text)  -> every positive-term range (for pages shown that aren't hits)
 */
export function compile(rawQuery, opts) {
  const query = normalizeQuery(rawQuery || '').trim();
  if (!query) return null;
  const mode = opts.mode || 'all';
  let terms = [];
  let ast = null;

  try {
    if (mode === 'regex') {
      const re = new RegExp(query, 'gu' + (opts.matchCase ? '' : 'i'));
      terms = [{ label: query, re, neg: false }];
    } else if (mode === 'phrase') {
      const src = termSource(query.replace(/"/g, ''), opts.wholeWord);
      if (!src) return null;
      terms = [makeTerm(query.replace(/"/g, ''), src, opts)];
    } else if (mode === 'boolean') {
      const parsed = parseBoolean(query);
      if (!parsed) return null;
      ast = parsed.ast;
      terms = parsed.terms.map((t) => {
        const src = termSource(t.text, opts.wholeWord);
        return makeTerm(t.text, src, opts, !t.pos);
      });
    } else {
      const parts = splitTerms(query);
      for (const p of parts) {
        const src = termSource(p.text, opts.wholeWord);
        if (src) terms.push(makeTerm(p.text, src, opts, p.neg));
      }
    }
  } catch (e) {
    return { error: e.message.replace(/^Invalid regular expression: /, '').replace(/^\/.*\/[a-z]*: /, '') };
  }

  if (!terms.length) return null;
  const posIdx = terms.map((t, i) => (t.neg ? -1 : i)).filter((i) => i >= 0);
  const negIdx = terms.map((t, i) => (t.neg ? i : -1)).filter((i) => i >= 0);
  if (!posIdx.length && mode !== 'boolean') return { error: 'Add at least one word to look for' };

  const dist = Math.max(1, Number(opts.near) || 8);
  // colour slots only for positive terms
  let slot = 0;
  for (const t of terms) t.color = t.neg ? -1 : slot++ % 6;

  function match(text) {
    if (!text) return null;
    const hits = new Array(terms.length);
    const get = (i) => (hits[i] ??= findAll(terms[i].re, text));

    if (mode === 'boolean') {
      const present = terms.map((_, i) => get(i).length > 0);
      if (!evalAst(ast, present)) return null;
    } else {
      for (const i of negIdx) if (get(i).length) return null;
      if (mode === 'any' || mode === 'phrase' || mode === 'regex') {
        if (!posIdx.some((i) => get(i).length)) return null;
      } else {
        for (const i of posIdx) if (!get(i).length) return null; // all + near
      }
    }

    let ranges = [];
    if (mode === 'near' && posIdx.length > 1) {
      const starts = wordStarts(text);
      const words = posIdx.map((i) => get(i).map((r) => wordAt(starts, r[0])));
      posIdx.forEach((ti, k) => {
        get(ti).forEach((r, j) => {
          const w = words[k][j];
          const ok = words.every((ws, k2) => k2 === k || hasWithin(ws, w, dist));
          if (ok) ranges.push([r[0], r[1], terms[ti].color]);
        });
      });
      if (!ranges.length) return null;
    } else {
      for (const i of posIdx) for (const r of get(i)) ranges.push([r[0], r[1], terms[i].color]);
      if (!ranges.length) {
        // boolean query satisfied purely by NOT — page counts, nothing to highlight
        return mode === 'boolean' ? [] : null;
      }
    }
    return mergeRanges(ranges);
  }

  function soft(text) {
    if (!text) return [];
    const ranges = [];
    for (const i of posIdx) for (const r of findAll(terms[i].re, text)) ranges.push([r[0], r[1], terms[i].color]);
    return mergeRanges(ranges);
  }

  return {
    mode,
    terms: terms.map((t) => ({ label: t.label, neg: t.neg, color: t.color })),
    match,
    soft,
  };
}
