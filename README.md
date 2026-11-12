# Instant Search

Search across all your documents at once and read the actual pages that match, like Ctrl+F across a whole library.

Open `index.html` from any static host (it's a plain static site, no build step). Everything runs in the browser and documents are stored only on your device (IndexedDB). Works offline once loaded.

## What it does

- **Add any number of documents**: PDF, Word (.docx), text, Markdown, HTML, RTF, CSV and similar. Drag them anywhere onto the page.
- **Results are the pages themselves**, not snippets. Only pages with hits are shown; the pages in between are folded away with buttons to open the page right after a hit, the page right before the next one, or the whole gap.
- **Six search types**: Any word, All words, Exact phrase, Near (within N words), Boolean (`AND` `OR` `NOT` `( )`) and Regex.
- **Works in every type**: `"quoted phrases"`, `-exclude`, `wild*cards`, match case, whole words only.
- **Hit navigation**: Enter / Shift+Enter (or N, F3) steps through every hit across every document. Click a coloured term above the results to step through just that word.
- **Text or Original** for PDFs: read clean reflowed text, or the real PDF page with highlights drawn on it. Switch globally or per page. Scanned pages with no text show the original automatically.
- **Read whole** opens one document in full, still highlighted, with a page jump box.
- **Folders**: tick a folder to search everything in it (or untick it to leave it out); the target button searches only that folder. Drag documents between folders, drop files from your computer straight onto a folder, add a whole folder from your computer (it becomes a library folder), or use the ▾ next to Add documents to import a batch into an existing or new folder. Deleting a folder keeps its documents.
- Library checkboxes choose which documents are searched; the target button searches only one.
- **Sort** results by library order, documents with most hits, or pages with most hits (every hit page across all documents, ranked).
- Light and dark themes, phone layout, keyboard shortcuts (see the ? button in the app).

## Files

```
index.html          page shell
css/app.css         styles
js/app.js           UI: library, results, reader, navigation
js/search.js        search engine (all modes) — pure functions
js/ingest.js        file reading and pagination
js/pdf.js           PDF text extraction + original page rendering
js/store.js         IndexedDB storage
sw.js               offline cache
vendor/             pdf.js 3.11.174 and mammoth 1.13.0 (bundled so it works offline)
```

## Limits

- Scanned PDFs have no text layer, so their words can't be searched (no OCR). They can still be read in Original view.
- Old `.doc` (pre-2007 Word) files aren't supported; save them as `.docx` or PDF.
