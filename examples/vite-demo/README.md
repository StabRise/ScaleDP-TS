# scaledp-ts demo

Drop in a PDF or image and watch the pipeline run, with per-stage timings, the
detected boxes drawn on the page, and NER entities highlighted.

```bash
cd examples/vite-demo
npm install && npm run dev     # or: pnpm / bun / yarn
```

`predev` builds the library and copies pdf.js's worker and data files into
`public/` -- pdf.js needs them served from the app's own origin, and without
the worker every PDF fails.

## How the library is resolved

The demo does **not** install `@stabrise/scaledp`. `vite.config.ts` aliases it
straight at `../../dist`, so it always runs the current build under any package
manager.

Every linking protocol has a catch here, which is why aliasing won:

| Protocol | Problem |
|---|---|
| `link:../..` | pnpm/yarn only. bun reads `link:` as a *global* link name and produces a dangling symlink. |
| `workspace:*` | Cannot address the repository root, which is the package. bun and npm only look at the workspace globs. |
| `file:../..` | Works, but bun hardlink-clones the package, so it goes stale as soon as `tsdown` cleans `dist` and writes new inodes. |

The trade-off is that aliasing bypasses the package's `exports` map, so the
demo does not prove that map is correct. `pnpm check:pkg` (publint +
are-the-types-wrong) covers that instead.

Editing library source? Re-run `npm run predev`, or keep `pnpm dev` running at
the repository root to rebuild on change.

## Notes

The dev server sets COOP/COEP so `SharedArrayBuffer` is available and
onnxruntime-web can use multi-threaded WASM. Watch the header line: it reports
whether WebGPU is available and whether the page is cross-origin isolated. On
WebGPU neither header is needed.

## Choosing models

Both engines have a picker.

**OCR** offers all 14 PaddleOCR presets. No single model covers every script, so
this is a real choice: `v6-small` handles Latin and CJK, `v5-eslav-mobile` adds
Cyrillic, `v5-en-mobile` is English-only and the fastest. Each preset caches
separately, so switching back to one you have used is instant.

**NER** lists the model registry with each entry's size, languages and
architecture. Two of them live in private StabRise repos and are shown disabled:
they need `configure({ auth })` to supply a token, which this demo does not.

Selections are remembered across reloads, and a remembered id that has since
become private or been removed falls back to the default rather than failing
mid-pipeline.

The label field defaults to the set the selected model was tuned on. GLiNER is
zero-shot -- the labels *are* the prompt -- so renaming one asks a different
question, and the GLiNER2 model in particular scores lower against any other
wording.

The NER checkbox is off by default: the first run downloads 183-349 MB depending
on the model, which is then cached in IndexedDB. The indicator beside each
picker says whether that download is still needed.

The header line reports whether the OCR models are already cached, and at which
origin. That matters because IndexedDB is scoped per origin -- **including the
port** -- so a dev server that moved from 5173 to 5174 has an empty cache and
looks exactly like caching being broken. This dev server pins 5173 and fails if
it is taken, rather than moving and silently losing the cache.

onnxruntime-web's WASM runtime (~5 MB) is separate from the models. It comes
from a version-matched CDN and lives in the browser's HTTP cache, so it appears
in the network panel on every load even when served from disk.

## Design notes

The interface is built as a **lightbox**: a dark instrument housing with the
scanned page as the only bright thing on screen, for the same reason photo and
film tools are dark -- a neutral surround raises the perceived contrast of the
thing you are inspecting.

The two accents are the false-colour language OCR tools already use. Cyan is
what the machine *found*, magenta is what it *understood*, and the page uses
the same two colours as the chrome, so the overlay and the interface agree.
Boxes are drawn by two chained `ImageDrawBoxes` stages -- one per colour --
rather than one, because a single stage takes one colour for all its sources.

The drop target carries registration marks at its corners, the crop marks on a
press sheet, and a scan beam sweeps it while stages run. The beam is tied to
real work: it starts when the pipeline starts and stops when it finishes, so it
reports rather than decorates. It holds still under `prefers-reduced-motion`.

The pipeline trace is bars of measured time, not illustration -- each bar is
that stage's share of the total, which is usually a lesson in itself (OCR is
~99% of the run; drawing the boxes is 20 ms).

Type is Space Grotesk for the interface and JetBrains Mono for anything the
machine produced: recognized text, timings, box tables, capability chips. That
split is load-bearing rather than stylistic -- the recognized text needs a
monospace face for its preserved layout to line up at all.
