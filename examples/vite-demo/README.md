# scaledp-ts demo

Drop in a PDF or image and watch the pipeline run, with per-stage timings, the
detected boxes drawn on the page, and NER entities highlighted.

The demo is a **workspace member** of this repository, so it resolves
`@stabrise/scaledp` from the source tree rather than the npm registry. Install
from the repository root, not from this directory:

```bash
# at the repository root
pnpm install          # or: bun install

cd examples/vite-demo
pnpm dev              # or: bun run dev
```

`predev` builds the library and copies pdf.js's worker and data files into
`public/` — pdf.js needs them served from the app's own origin.

> Editing library source? Re-run `pnpm build` at the root, or keep
> `pnpm dev` running there to rebuild on change. The demo imports the built
> `dist/`, which is what the package's `exports` map points at.

The dev server sets COOP/COEP so `SharedArrayBuffer` is available and
onnxruntime-web can use multi-threaded WASM. Watch the header line: it reports
whether WebGPU is available and whether the page is cross-origin isolated. On
WebGPU neither header is needed.

The NER checkbox is off by default: the first run downloads about 333 MB, which
is then cached in IndexedDB.
