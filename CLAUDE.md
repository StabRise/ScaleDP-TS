# scaledp-ts — repo conventions

`@stabrise/scaledp` processes documents in the browser. It mirrors the Python
[ScaleDP](https://github.com/StabRise/ScaleDP) library at
`/Users/mykola/PycharmProjects/ScaleDP`, which is the reference for stage
names, parameter names, defaults and schemas.

A second reference exists: `@stabrise/pdftools` at
`/Users/mykola/PycharmProjects/pdf-redaction/frontend/packages/pdftools`. It is
a working browser implementation of GLiNER, PaddleOCR, Tesseract and YOLO whose
inline comments document several non-obvious traps. It is a source to port
*from*, never a dependency, and `pdf-redaction` will eventually consume this
library instead.

## Layout

```
src/core/      pipeline, params, config, model cache, geometry, image, text
src/schemas/   Box, Image, Document, Entity, DetectorOutput
src/stages/    engine-free stages
src/pdf/       pdfjs-dist              (subpath export)
src/ocr/       PaddleOCR, DBNet, Tesseract (subpath export)
src/ner/       GLiNER1 + GLiNER2       (subpath export)
src/detect/    YOLO                    (subpath export)
src/worker/    worker host and client  (subpath export)
test/unit/     node-environment tests
test/browser/  tests needing real ORT/WASM/WebGPU/OffscreenCanvas
test/fixtures/ Python golden generators and their output
```

## Rules

**Stages never throw by default.** Every output schema carries `exception:
string`; a failure is recorded there and the pipeline completes. Implement
`onError` to return a well-formed empty instance of the output schema.
`propagateError: true` opts into throwing. This is load-bearing — one bad page
must not lose the other forty.

**Engines are optional peer dependencies, imported lazily.** Importing the core
must pull in no ML runtime. Every engine import is a dynamic `import()` inside
a function, wrapped with a message naming the package to install.

**No DOM.** `OffscreenCanvas` and `ImageBitmap` only — never
`document.createElement`, `HTMLImageElement` or `toDataURL`. This is what lets
the whole pipeline run in a worker.

**No app-owned paths.** Asset URLs, model hosts and auth all come from
`configure()`. A hardcoded `/pdf.worker.min.mjs` or `/api/hf-token` is a bug.

**Pin one onnxruntime-web.** The `.mjs` loader and the `.wasm` binary must match
build variant *and* version. `wasmPaths` is derived from the resolved package
version — never hardcode a CDN URL.

**Add a subpath entry when the engine lands.** `tsdown.config.ts` lists only
entries that exist, so a green build means every declared export resolves.
Update `package.json` `exports` in the same change.

## Parity testing

Anything ported from Python is verified against Python, not against itself.
`test/fixtures/generate-*.py` run the real ScaleDP code and write goldens;
`test/unit/*-parity.test.ts` diff against them.

```bash
SCALEDP_PYTHON=/path/to/venv/bin/python test/fixtures/generate-box-goldens.sh
```

The venv needs opencv. Currently
`~/Library/Caches/pypoetry/virtualenvs/scaledp-DbEJkcaR-py3.12/bin/python`.

Two tolerances are legitimate and already encoded; do not tighten them blindly:

- cv2 computes in float32 while JS is float64, so a value on a `.5` rounding
  boundary can round the other way. 1px on integer fields.
- A rectangle is invariant under a 180° rotation (90° when square), so `angle`
  is compared within the shape's own symmetry group. cv2 itself returns `-0.0`
  or `90` for axis-aligned input depending on which hull edge its scan hits.

## Documentation

The docs are a Fumadocs site living inside the demo app, which is also the
project's public site: `/` landing, `/docs/*` documentation, `/demo` the
pipeline builder. Prose is at `examples/vite-demo/content/docs/`.

**Never hand-edit between the `{/* generated:params */}` markers.** Every stage
page's parameter table is written from `src/registry/catalog.ts` by
`examples/vite-demo/scripts/generate-stage-docs.mjs`; `npm run docs:check` (part
of the demo's `typecheck`) fails when the two disagree, and it also fails when a
stage in the catalogue has no page. Adding a stage therefore means adding
`content/docs/stages/<group>/<slug>.mdx` with the marker pair in it.

The site deploys to GitHub Pages via `.github/workflows/deploy.yml` on a push
to `main`. Pages cannot set response headers, so **the deployed site is not
cross-origin isolated** and onnxruntime-web runs single-threaded there; WebGPU
is unaffected. The dev server still sets COOP/COEP (a plugin in
`vite.config.ts`, because `server.headers` does not reach React Router's SSR
handler) so the threaded path stays testable. Do not "fix" that asymmetry by
removing the dev headers -- it is deliberate, and documented in the app's
README.

`examples/vite-demo/package-lock.json` is committed on purpose, against the
repo's usual rule about example lockfiles: it is what the published site builds
from.

## Commands

```bash
pnpm test              # unit tests
pnpm test:browser      # needs Playwright/Chromium
pnpm typecheck
pnpm lint / lint:fix
pnpm build
pnpm check:pkg         # publint + attw, esm-only profile
```

```bash
cd examples/vite-demo
npm run dev            # the site: landing, /docs, /demo
npm run build          # static bundle in build/client
npm run typecheck      # includes docs:check and react-router typegen
```

## Publishing

`@stabrise` on npm, via GitHub Actions OIDC trusted publishing. npm CLI ≥ 11.5.1
and `permissions: { id-token: write }`; `--provenance` is no longer needed.

## Git & Commit Rules
- Always use the system default git config for commit author.
- Ensure commits use the configured user.email (`git config user.email`).
