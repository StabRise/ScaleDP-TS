# scaledp-ts — the site

This app is three things on one origin:

| Route | What it is |
|---|---|
| `/` | Landing page |
| `/docs/*` | The documentation, a [Fumadocs](https://fumadocs.dev) site over `content/docs/` |
| `/demo` | The pipeline builder |

They share an origin deliberately. The builder's model cache is IndexedDB, which
is scoped per origin, so a reader who follows an **Open in builder** link from a
stage page lands on a builder that already has the weights.

One header sits on all three, sticky. `/docs` uses Fumadocs' **notebook** layout
(`nav.mode: 'top'`) rather than its default, where the navigation lives inside
the sidebar and disappears on wide screens; `/` and `/demo` use `HomeLayout`,
which is that same navbar plus its children. The theme switch works everywhere,
the builder included: `style.css` defines its palette twice, keyed on the `.dark`
class Fumadocs toggles. Dark is the design -- a dark surround raises the
perceived contrast of the page being read, which is why photo and film tools look
that way -- and light is the same instrument on a bench rather than an
inversion.

```bash
cd examples/vite-demo
npm install && npm run dev     # or: pnpm / bun / yarn
```

`predev` builds the library, copies pdf.js's worker and data files into
`public/` -- pdf.js needs them served from the app's own origin, and without
the worker every PDF fails -- and regenerates the stage parameter tables.

React Router in SPA mode (`ssr: false`) with prerendering: every route becomes a
real `index.html` at build time, so a deep link into the docs resolves without
the SPA fallback and search is a static index the browser queries locally. There
is no server anywhere in this stack.

## The documentation

Prose lives in `content/docs/`, one MDX file per page, with `meta.json` for
sidebar order. Two things are **not** hand-written:

- **Stage parameter tables.** `scripts/generate-stage-docs.mjs` writes them from
  `src/registry/catalog.ts` -- the same catalogue the builder renders its
  controls from and `pipelineCode` decides what to emit from. Never edit between
  the `{/* generated:params */}` markers; run `npm run docs:generate`.
- **The stage catalogue table** on `/docs/stages`, between
  `{/* generated:catalogue */}`.

`npm run docs:check` (part of `typecheck`) fails when a table is stale, and also
when a stage in the catalogue has no page at all. Adding a stage means adding
`content/docs/stages/<group>/<slug>.mdx` with the marker pair in it.

### Open in builder

`<TryIt stages={[...]} />` takes the same `StageDescriptor[]` the snippet above
it constructs and links to `/demo?p=<base64url>`. The builder decodes it, seeds
the pipeline, and clears the parameter -- leaving it would re-seed over the
reader's own edits on the next reload. Encoding lives in `src/lib/deeplink.ts`
and is registry-free on purpose; validation is in `src/lib/deeplink-decode.ts`,
which only the builder loads.

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

The app is React, and `npm run typecheck` checks it -- Vite transpiles TSX
without typechecking it, so the build alone will not catch a type error.

## Notes

The dev server sets COOP/COEP, so `SharedArrayBuffer` is available and
onnxruntime-web can use its multi-threaded WASM build. Watch the runtime strip
under the header in `/demo`: it reports which execution provider this tab
actually got and whether the page is cross-origin isolated.

**The deployed site is not isolated.** GitHub Pages cannot set response headers,
so `crossOriginIsolated` is false there and ORT falls back to single-threaded
WASM. WebGPU needs none of it and is faster than threaded WASM anyway, so most
visitors are unaffected -- and the strip says which one they got rather than
implying either. Development keeps the headers so the threaded path stays
testable; that is the one place dev and production deliberately differ.

`server.headers` alone is not enough once React Router owns the dev server: it
reaches Vite's static and transform middleware but not the SSR handler that
renders the HTML document, which is the response the headers have to be on. A
small plugin in `vite.config.ts` does it instead.

Hosting anywhere that *can* set headers -- Netlify, Cloudflare Pages -- restores
threading with COOP/COEP applied site-wide. Nothing in the app needs to change.

Tailwind and the builder's own `src/style.css` coexist by cascade layer.
`style.css` is unlayered, and unlayered CSS beats anything in `@layer base`
regardless of specificity, so Tailwind's preflight cannot override a property the
builder sets. Its handful of bare element selectors are scoped to
`html[data-demo]`, an attribute the demo route sets while mounted, so the
builder's `body` background and form styling do not follow the reader onto the
documentation.

## Deploying

GitHub Pages, from `.github/workflows/deploy.yml` on a push to `main`. It
installs the root's pnpm dependencies (the site's `prebuild` builds the library
with them), then `npm ci && npm run build` here, and uploads `build/client` as
the Pages artifact.

```bash
npm run build
npm run preview     # http://localhost:3000 -- exactly what Pages will serve
```

Three details are Pages-specific:

- **`public/CNAME`** names the custom domain, `scaledp-ts.stabrise.com`. Point a
  DNS `CNAME` record for that host at `stabrise.github.io`, then set the same
  domain under the repository's Pages settings. Because the site sits at a
  domain root there is no `base` path to configure; serving it from the default
  `stabrise.github.io/scaledp-ts/` instead would mean setting Vite's `base`
  *and* React Router's `basename` to `/scaledp-ts/`.
- **`404.html`** is the only rewrite hook Pages offers. `postbuild` copies
  React Router's `__spa-fallback.html` to it, so a URL that was never
  prerendered becomes a client-side route instead of GitHub's 404 page. It runs
  at build time rather than in the workflow so `npm run preview` serves the same
  thing.
- **`public/.nojekyll`** is insurance. The Actions artifact path does not run
  Jekyll, but if it ever did, every `_`-prefixed file -- `__spa-fallback.html`
  included -- would be dropped.

`examples/vite-demo/package-lock.json` is committed, unlike the other example
lockfiles: this one is what the published site is built from, and an unpinned
install would let a minor release of fumadocs or React Router change the site
with no commit behind it.

## Building a pipeline

The pipeline is the interface. Every stage the library exposes is in the **Add a
stage** menu, grouped by what it does, and each card in the list edits one
stage's parameters.

Nothing here knows about any particular stage. The cards are rendered from
`@stabrise/scaledp/registry`, which describes each stage's parameters at run
time — the widget kind, the range the stage validates, the enum options. That is
why the OCR preset picker offers exactly the 14 `PADDLE_OCR_PRESETS` and the
private NER models come through disabled, without this app carrying a second
copy of either list.

A parameter left at its default renders muted; a changed one is marked and can
be reverted on its own. Only the changes are stored, so an exported pipeline
reads as the decisions someone made rather than a dump of every field.

Cards start closed — a ten-stage pipeline is a list you can read, not several
screens of forms. Click a stage's name to open it, or **Expand all**. Closed, a
card still shows what it writes, how many of its parameters were changed, and
any warning: the things you scan a pipeline for. A stage you have just added
opens by itself, since adding one is how you set about configuring it.

### Columns are the wiring

Stages do not connect to each other — they read and write named fields on the
row, and the order of the list is the order they run. Each card says which
columns it writes, and the column pickers suggest what is actually available at
that point in the pipeline.

Two things the runner does are modelled so the suggestions do not lie:

- A stage with **Keep input column** off *deletes* its input on the way through.
  `PdfToImage` does this by default, so `content` is gone by the second stage —
  and a `PdfToDocument` added after it would find nothing to read.
- An annotated page is still an image, but it is the end of the line. Adding a
  detector after a draw pass wires it to the page, not to the overlay, or it
  would read text through the boxes drawn on top of it.

The detectors are line-level -- one box per line of text, in Python ScaleDP as
here. `TesseractRecognizer`'s **Box level** is what turns those into word boxes:
it maps tesseract's own word rects back through the crop, rotation included, so
a word inside a skewed line comes back skewed the same way. `TesseractOcr`, which
reads the whole page itself, returns word boxes without needing a detector.

Point a stage at a column nothing produces and the card says so — but the run
still goes ahead. Stages record failures in their output rather than throwing,
so one bad column must not cost the other forty pages, and the interface should
not be stricter than the library. When it does fail, the message lands on that
stage's card and on its tab in the result, and every other column still renders.

### Saving

**Start from** loads one of three built-in pipelines. **Save** keeps the current
one under a name, in `localStorage`; the working copy comes back on reload too.
**Export / import** has two views. **JSON** is the same document in a textarea,
so a pipeline can be pasted into an issue and imported back:

```json
{
  "version": 1,
  "presets": [{ "id": "…", "name": "Rotated scans", "stages": [ … ] }],
  "stages": [
    { "id": "…", "type": "PdfToImage", "options": { "resolution": 200 } },
    { "id": "…", "type": "PaddleTextRecognizer", "options": { "keepFormatting": true } }
  ]
}
```

A stage is `{ type, options }` plus a local `id` — the same `StageDescriptor`
the worker protocol sends across the boundary. An import naming a stage this
build does not have is refused with the name, rather than failing mid-run.

**TypeScript** is the same pipeline written as the code that builds it —
`pipelineCode` from `@stabrise/scaledp/registry`, which groups the imports by
subpath and emits only the options that differ from each stage's defaults. It is
read-only: the pipeline is edited in the cards above, and parsing source back
into stages is not something this demo has any business doing.

### Models

Each card that needs weights reports whether they are already cached, and how
much the first run will download. The cache is IndexedDB, scoped per origin —
**including the port** — so a dev server that moved from 5173 to 5174 has an
empty cache and looks exactly like caching being broken. This dev server pins
5173 and fails if it is taken, rather than moving and silently losing several
hundred megabytes.

Two of the NER models live in private StabRise repos and are shown disabled:
they need `configure({ auth })` to supply a token, which this demo does not.
GLiNER is zero-shot — the labels *are* the prompt — so renaming one asks a
different question, and the GLiNER2 model in particular scores lower against any
other wording.

Changing anything marks the result on screen as out of date and highlights **Run
again**, rather than re-running by itself: a re-read is seconds of work and, for
a model not yet cached, hundreds of megabytes. The file stays in memory so you
do not have to pick it again. A run in flight can be cancelled — the pipeline
takes an `AbortSignal` and checks it between stages and between rows.

### Pages

A PDF becomes one row per page — `PdfToImage` and `PdfToDocument` both expand
one input row into several — so the results carry a pager when a run produced
more than one. `ImageCropBoxes` expands too, a row per crop, and those have no
page number of their own, so they are numbered by position instead.

Two expanding stages reading the same pre-existing column multiply rather than
subdivide: a `PdfToImage` and a `PdfToDocument` both reading `content` turn a
five-page file into twenty-five rows. The card says so when it happens. Reading
what the first one *wrote* is fine, which is why cropping the boxes found on a
rendered page is not flagged.

### Reading the result

The panels are derived from the finished row rather than named in advance, since
an assembled pipeline can write any columns it likes. Each value is classified by
shape — a `Document` has text and boxes, a `NerOutput` has entities, a
`DetectorOutput` has boxes and no text, an `Image` has bytes and dimensions — and
rendered with the matching helper from `@stabrise/scaledp/display`. The last
image is the page on the left; everything else becomes a tab.

## Design notes

The interface is built as a **lightbox**: a dark instrument housing with the
scanned page as the only bright thing on screen, for the same reason photo and
film tools are dark -- a neutral surround raises the perceived contrast of the
thing you are inspecting.

The two accents are the false-colour language OCR tools already use. Cyan is
what the machine *found*, magenta is what it *understood*, and the page uses
the same two colours as the chrome, so the overlay and the interface agree.
Boxes are drawn by chained `ImageDrawBoxes` stages -- one per colour -- rather
than one, because a single stage takes one colour for all its sources. **Find
PII** is written that way -- cyan for the words, magenta over them for the
entities -- and the chaining idiom is visible in the builder: each pass reads
`annotated` and writes it again. The pipelines that produce one colour use a
single pass.

The drop target carries registration marks at its corners, the crop marks on a
press sheet, and a scan beam sweeps it while stages run. The beam is tied to
real work: it starts when the pipeline starts and stops when it finishes, so it
reports rather than decorates. It holds still under `prefers-reduced-motion`.

The pipeline trace is bars of measured time, not illustration -- each bar is
that stage's share of the total, which is usually a lesson in itself (OCR is
~99% of the run; drawing the boxes is 20 ms). It is also the reason the builder
is a numbered list rather than a canvas of connected boxes: the pipeline really
is a flat ordered array, and drawing it as a graph would suggest a branching it
does not have.

Type is Space Grotesk for the interface and JetBrains Mono for anything the
machine produced: recognized text, timings, box tables, capability chips. That
split is load-bearing rather than stylistic -- the recognized text needs a
monospace face for its preserved layout to line up at all.
