# Instant Search

Search across all your documents at once and read the actual pages that match, like Ctrl+F across a whole library.

Open `index.html` from any static host (it's a plain static site, no build step). Everything runs in the browser and documents are stored only on your device (IndexedDB). Works offline once loaded.

## What it does

- **Add any number of documents**: PDF, Word (.docx), text, Markdown, HTML, RTF, CSV and similar. Drag them anywhere onto the page.
- **Results are the pages themselves**, not snippets. Only pages with hits are shown; the pages in between are folded away with buttons to open the page right after a hit, the page right before the next one, or the whole gap.
- **Six search types**: Any word, All words, Exact phrase, Near (within N words), Boolean (`AND` `OR` `NOT` `( )`) and Regex.
- **Works in every type**: `"quoted phrases"`, `-exclude`, `wild*cards`, match case, whole words only.
- **Hit navigation**: Enter / Shift+Enter (or N, F3) steps through every hit across every document. Click a coloured term above the results to step through just that word.
- **Text or Original** for PDFs and HTML: read clean reflowed text, or the real thing with highlights on it. PDFs show the actual page; HTML files show the real web page in a locked-down frame (no scripts, links and forms disabled), scrolled to that page's match. Switch globally or per page. Scanned PDF pages with no text show the original automatically.
- **Read whole** opens one document in full, still highlighted, with a page jump box.
- **Folders**: tick a folder to search everything in it (or untick it to leave it out); the target button searches only that folder. Drag documents between folders, drop files from your computer straight onto a folder, add a whole folder from your computer (it becomes a library folder), or use the ▾ next to Add documents to import a batch into an existing or new folder. Deleting a folder keeps its documents.
- **Rearrange** from a document's or folder's ⋯ menu: a list of your library opens (folders open their own files); tap any document or folder and the item moves right above it. **Move to folder ›** lists your folders the same way. Dragging a document by its name onto a folder also moves it in.
- **Clear** lets you pick whole folders, single documents or the whole app, then asks you to confirm.
- Library checkboxes choose which documents are searched; the target button searches only one.
- **Resize the library**: drag its right edge to make it wider or narrower (double-click the edge to reset). Drag it most of the way closed to hide it.
- **Sort** results by library order, documents with most hits, or pages with most hits (every hit page across all documents, ranked).
- **Keyboard shortcuts you can change** (keyboard button or `?`): next/previous hit (N), next/previous page with hits (] [ or J K), next/previous document (Shift+] Shift+[), first/last hit, pan, zoom, fit, switch search type and more. Click + to add a key, click a key to remove it.
- **Minimize the toolbar** (chevron button or H) so only the search box is left. The search type becomes a pill inside the box: tap it for options, or press and drag sideways to slide between types. The full toolbar's type buttons can be dragged across the same way. The library can be hidden too (L).
- **Zoom** with the floating controls: − / + / 100%, fit width, fit page. Text pages get bigger type; PDF pages in Original view get sharper and pan sideways when wider than the screen.
- **On phones**: the top bar slides away while you read and comes back when you scroll up. A bottom bar holds the reading controls: search type (tap, or hold and slide sideways), previous/next page with hits, previous/next hit, the hit counter (tap for next, or hold and slide along it to scrub through hits), and a view menu (tap, or hold, slide to an option and let go) for Text/Original, zoom, fit, match case, whole words and sort.
- Light and dark themes.

## Linking documents from websites

You can add a document straight from a link, or link a whole page that lists documents (like an FAA handbook page), and later check for updates.

- **▾ next to Add documents → Add from a web link…** Paste a link to a PDF (or other document) to add it. Paste a link to a page that lists documents and you get a checklist of everything on it. Pages like the FAA's list the whole handbook *and* each chapter; the whole-book file is unticked automatically so you don't get every hit twice.
- Choose **Keep them up to date** to have the app keep watching that page (or **Just this once** to download and forget it). If you didn't pick a folder, the documents go straight into your library — no folder is made; move them wherever you like and they stay watched. **Check for updates** (the ↻ button next to *Library*, or a folder's ⋯ menu) then:
  - re-downloads anything the site changed (it asks the site first, so unchanged files aren't downloaded again),
  - recognises a document the site re-published under a new file name and title (e.g. `aim_basic_w_chg1_chg2_and_chg3_dtd_7_9_26….pdf` → `aim_basic_w_chg1_dtd_2_18_27.pdf`) by comparing link titles, file names without their dates, and sizes, then shows you the pairing before replacing,
  - offers documents newly added to the page (untick ones you don't want and they won't be suggested again),
  - lists documents that disappeared from the page (they stay in your library).
- **Sanity checks:** before replacing anything it compares page counts and file sizes. A new version with far fewer pages or a much smaller file (an error page, a single chapter instead of a book…) is flagged and left unticked for you to decide.
- **Keep the old versions too** keeps the previous copy as “(previous)”, unticked so it isn't searched unless you want it.
- **Dropping in a newer copy yourself** works too: add a file with the same name as one in your library, or the same name with a different edition letter or year, and you're shown both page counts and sizes and asked whether to replace it.
- Optional: *Check linked sources for updates once a day when I open the app* (in the Download helper section of the link dialog).

### Setting up the download helper (one time, free, about 5 minutes)

Browsers don't let one website read files from another unless that site allows it, and faa.gov doesn't. The helper is a tiny program on Cloudflare's free plan that fetches the files for the app. It only fetches from the sites you list in it.

1. Go to **https://dash.cloudflare.com** and create a free account (or sign in).
2. In the left menu open **Workers & Pages** (it may be under **Compute**).
3. Click **Create application**, then **Start with Hello World!**. Name it `instant-search-helper` and click **Deploy**.
4. On the next screen click **Edit code**.
5. Delete everything in the editor. Open [`helper/cloudflare-worker.js`](helper/cloudflare-worker.js) in this repo, copy all of it, and paste it in.
6. Click **Deploy** (top right).
7. Copy the worker's address. It looks like `https://instant-search-helper.YOUR-NAME.workers.dev`. Opening it in a browser should show *Instant Search download helper is running.*
8. In Instant Search: **▾ next to Add documents → Add from a web link… → Download helper**, paste the address, and click **Save & test**. It should say **working ✓**.

To link documents from other sites, add them to `ALLOWED_SITES` at the top of the worker code and deploy again. To make sure only your own site can use the helper, put your site's address in `ALLOWED_PAGES`, e.g. `'https://frenchbear1.github.io'`.

Cloudflare's button names change now and then; if one doesn't match exactly, look for the closest equivalent.

## Files

```
index.html          page shell
css/app.css         styles
js/app.js           UI: library, results, reader, navigation
js/search.js        search engine (all modes) — pure functions
js/ingest.js        file reading and pagination
js/pdf.js           PDF text extraction + original page rendering
js/keys.js          keyboard combo helpers
js/htmlview.js      original view for HTML files
js/remote.js        downloading from links, update checks
helper/             the Cloudflare download helper (not part of the website)
js/store.js         IndexedDB storage
sw.js               offline cache
vendor/             pdf.js 3.11.174 and mammoth 1.13.0 (bundled so it works offline)
```

## Limits

- Scanned PDFs have no text layer, so their words can't be searched (no OCR). They can still be read in Original view.
- Old `.doc` (pre-2007 Word) files aren't supported; save them as `.docx` or PDF.
