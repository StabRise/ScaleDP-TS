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

The NER checkbox is off by default: the first run downloads about 333 MB, which
is then cached in IndexedDB.
