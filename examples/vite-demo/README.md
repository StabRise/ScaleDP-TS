# scaledp-ts demo

Drop in a PDF or image and watch the pipeline run, with per-stage timings, the
detected boxes drawn on the page, and NER entities highlighted.

```bash
npm install
npm run dev
```

`predev` copies pdf.js's worker and data files into `public/` — they must be
served from the app's own origin.

The dev server sets COOP/COEP so `SharedArrayBuffer` is available and
onnxruntime-web can use multi-threaded WASM. Watch the header line: it reports
whether WebGPU is available and whether the page is cross-origin isolated. On
WebGPU neither header is needed.

The NER checkbox is off by default: the first run downloads about 333 MB, which
is then cached in IndexedDB.
