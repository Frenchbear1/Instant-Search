// Shows an HTML document as the real web page, inside a sealed frame.
//
// The page's own scripts run, so sites that build themselves with JavaScript appear properly, but the frame
// is sandboxed without "same origin": it can't see this app, its storage or your other documents, can't open
// pop-ups, downloads or dialogs, and can't navigate this tab. Links inside it do nothing.
// Because the app can't reach into such a frame, a tiny script is put inside it that collects the page's
// text, applies the highlights the app sends back, and scrolls to the current match.
import { store } from './store.js';
import { savedFrom } from './ingest.js';

const raws = new Map(); // docId -> Promise<string|null>

const BRIDGE = `<script data-instant-search>(function(){
var P=parent,ID=null,nodes=[],marks=[],SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,TEMPLATE:1,TITLE:1};
function css(){if(document.getElementById('__is_style'))return;var s=document.createElement('style');s.id='__is_style';
s.textContent='mark.__is{color:#1d1a16!important;border-radius:2px;padding:0 1px;-webkit-box-decoration-break:clone;box-decoration-break:clone}mark.__is.c0{background:#ffe37a}mark.__is.c1{background:#b5dcff}mark.__is.c2{background:#bdf0c4}mark.__is.c3{background:#ffc7da}mark.__is.c4{background:#dcccff}mark.__is.c5{background:#ffd6a8}mark.__is.cur{background:#ff6a13!important;color:#fff!important;box-shadow:0 0 0 2px #ff6a13}';
(document.head||document.documentElement).appendChild(s);}
function collect(){nodes=[];if(!document.body)return[];var w=document.createTreeWalker(document.body,4,{acceptNode:function(t){var p=t.parentNode;return t.data.trim()&&p&&!SKIP[p.nodeName]&&!(p.closest&&p.closest('mark.__is'))?1:2}});
while(w.nextNode())nodes.push(w.currentNode);return nodes.map(function(n){return n.data})}
function unmark(){for(var i=0;i<marks.length;i++){var m=marks[i];if(m.parentNode)m.replaceWith(document.createTextNode(m.textContent))}marks=[];if(document.body)document.body.normalize()}
function apply(list){unmark();css();for(var k=0;k<list.length;k++){var n=nodes[list[k][0]],rs=list[k][1];if(!n||!n.parentNode)continue;
var f=document.createDocumentFragment(),pos=0,d=n.data;for(var j=0;j<rs.length;j++){var s=rs[j][0],e=rs[j][1];if(s<pos)continue;if(s>pos)f.appendChild(document.createTextNode(d.slice(pos,s)));
var m=document.createElement('mark');m.className='__is c'+rs[j][2];m.textContent=d.slice(s,e);f.appendChild(m);marks.push(m);pos=e}
if(pos<d.length)f.appendChild(document.createTextNode(d.slice(pos)));n.parentNode.replaceChild(f,n)}}
function go(o,frac){var se=document.scrollingElement||document.documentElement,t=marks.length?marks[Math.max(0,Math.min(o,marks.length-1))]:null;
for(var i=0;i<marks.length;i++)marks[i].classList.remove('cur');
if(t){t.classList.add('cur');var r=t.getBoundingClientRect();se.scrollTop=r.top+se.scrollTop-innerHeight/3;var x=r.left+se.scrollLeft-innerWidth/2;if(r.right>innerWidth||r.left<0)se.scrollLeft=Math.max(0,x)}
else if(frac>0)se.scrollTop=frac*Math.max(0,se.scrollHeight-innerHeight)}
addEventListener('message',function(e){if(e.source!==P||!e.data||e.data.__is!==1)return;var m=e.data;
if(m.type==='hello'){ID=m.id;unmark();if(m.zoom&&m.zoom!==1)document.documentElement.style.zoom=String(m.zoom);P.postMessage({__is:1,type:'texts',id:ID,texts:collect()},'*')}
else if(m.type==='marks'){apply(m.list);go(m.ordinal||0,m.frac||0);P.postMessage({__is:1,type:'done',id:ID,count:marks.length},'*')}
else if(m.type==='fulltext'){P.postMessage({__is:1,type:'fulltext',id:m.id,text:document.body?document.body.innerText:''},'*')}
else if(m.type==='zoom'){document.documentElement.style.zoom=String(m.zoom||1)}});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(a){e.preventDefault()}},true);
document.addEventListener('submit',function(e){e.preventDefault()},true);
window.open=function(){return null};
function ready(){P.postMessage({__is:1,type:'ready'},'*')}
if(document.readyState==='complete')setTimeout(ready,0);else addEventListener('load',function(){setTimeout(ready,250)});
})();</script>`;

export function forgetHtml(docId) {
  raws.delete(docId);
}

let seq = 0;
const waiting = new Map(); // frame window -> handler
addEventListener('message', (e) => {
  const h = waiting.get(e.source);
  if (h && e.data && e.data.__is === 1) h(e.data);
});

function prepare(html, base) {
  if (!/<base\s/i.test(html.slice(0, 20000))) {
    const url = base || savedFrom(html);
    if (url) html = html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${url.replace(/"/g, '&quot;')}">`);
  }
  // the helper goes first, before anything on the page can lock scripts down
  const m = html.match(/^\s*<!doctype[^>]*>/i);
  return m ? m[0] + BRIDGE + html.slice(m[0].length) : BRIDGE + html;
}

/**
 * Renders the document into `host`, scrolled to the `ordinal`-th highlighted match
 * (or proportionally to page n when there's nothing to point at). Returns a cleanup function.
 */
export async function renderHtmlPage({ docId, n, pageCount, host, matcher, ordinal, zoom, base = '' }) {
  if (!raws.has(docId)) raws.set(docId, store.file(docId).then((r) => (r == null ? null : typeof r === 'string' ? r : new TextDecoder().decode(r))));
  const html = await raws.get(docId);
  if (html == null) throw new Error('the original file wasn’t stored');

  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  frame.title = 'Original web page';
  frame.srcdoc = prepare(html, base);
  // If something is already showing, load the new frame invisibly on top and swap when it's ready.
  const swapping = host.childElementCount > 0;
  if (swapping) frame.classList.add('pending');
  host.append(frame);
  const id = ++seq;
  const show = () => {
    if (swapping) {
      for (const c of [...host.children]) if (c !== frame) c.remove();
      frame.classList.remove('pending');
    }
  };
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; waiting.delete(frame.contentWindow); resolve(); } };
    const post = (msg) => frame.contentWindow?.postMessage({ __is: 1, id, ...msg }, '*');
    let greeted = false;
    const hello = () => { if (!greeted) { greeted = true; post({ type: 'hello', zoom }); } };
    waiting.set(frame.contentWindow, (m) => {
      if (m.type === 'ready') hello();
      else if (m.type === 'texts' && m.id === id) {
        const list = [];
        if (matcher) m.texts.forEach((t, i) => { const r = matcher.soft(t); if (r.length) list.push([i, r.map((x) => [x[0], x[1], x[2]])]); });
        post({ type: 'marks', list, ordinal: ordinal || 0, frac: list.length ? 0 : pageCount > 1 ? n / pageCount : 0 });
      } else if (m.type === 'done' && m.id === id) finish();
    });
    // slow pages (or ones whose scripts break the helper) still show up
    setTimeout(finish, 6000);
    frame.addEventListener('load', () => setTimeout(hello, 400), { once: true });
  });
  show();
  return () => { waiting.delete(frame.contentWindow); frame.remove(); };
}

/**
 * The text a page shows once its scripts have run (pages that build themselves with JavaScript have
 * little text in the file itself). Renders it in a hidden sealed frame; '' if that doesn't work.
 */
export function renderedText(html, base = '') {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1100px;height:900px;border:0;visibility:hidden;pointer-events:none';
    frame.srcdoc = prepare(html, base);
    const id = ++seq;
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      waiting.delete(frame.contentWindow);
      frame.remove();
      resolve(text || '');
    };
    document.body.append(frame);
    let asked = false;
    const ask = () => { if (!asked) { asked = true; setTimeout(() => frame.contentWindow?.postMessage({ __is: 1, id, type: 'fulltext' }, '*'), 700); } };
    waiting.set(frame.contentWindow, (m) => {
      if (m.type === 'ready') ask();
      else if (m.type === 'fulltext' && m.id === id) finish(m.text);
    });
    frame.addEventListener('load', ask, { once: true });
    setTimeout(() => finish(''), 8000);
  });
}
