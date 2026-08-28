# Quickstart

## Install

```bash
npm install @stabrise/scaledp onnxruntime-web pdfjs-dist ppu-paddle-ocr @huggingface/transformers
```

Only `@stabrise/scaledp` is a hard dependency. The rest are optional peers, so a
project that only reads PDFs never pulls in an ML runtime.

## Serve the assets

Three things must be served from your own origin, because a library cannot know
where your app puts them.

**pdf.js worker and data files.** Copy them out of `node_modules/pdfjs-dist`:

```bash
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/
cp -r node_modules/pdfjs-dist/cmaps public/
cp -r node_modules/pdfjs-dist/standard_fonts public/
```

**onnxruntime-web WASM binaries** (optional — a CDN copy matching your installed
version is used otherwise):

```bash
cp node_modules/onnxruntime-web/dist/*.wasm public/ort/
cp node_modules/onnxruntime-web/dist/*.mjs public/ort/
```

The `.mjs` loader and the `.wasm` binary must come from the same build variant
**and** the same version. A mismatch fails at session creation with an opaque
error.

## Configure

```ts
import { configure } from '@stabrise/scaledp'

configure({
  cache: 'indexeddb',
  pdf: {
    workerSrc: '/pdf.worker.min.mjs',
    cMapUrl: '/cmaps/',
    standardFontDataUrl: '/standard_fonts/',
  },
  ortWasmPaths: '/ort/',
  onProgress: ({ file, loaded, total }) => {
    console.log(`${file}: ${Math.round((loaded / total) * 100)}%`)
  },
})
```

Models download once and live in IndexedDB, so a repeat visit starts instantly
and works offline.

## First pipeline

```ts
import { Pipeline } from '@stabrise/scaledp'
import { PdfToImage } from '@stabrise/scaledp/pdf'
import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'

const pipeline = new Pipeline([
  new PdfToImage({ resolution: 300 }),
  new PaddleTextRecognizer(),
])

const rows = await pipeline.transform(file)
console.log(rows[0].text.text)
```

Each row is one page. `PdfToImage` writes an `image` field; `PaddleTextRecognizer`
reads it and writes `text`.

## Add NER

```ts
import { GlinerNer } from '@stabrise/scaledp/ner'

const pipeline = new Pipeline([
  new PdfToImage({ resolution: 300 }),
  new PaddleTextRecognizer(),
  new GlinerNer({
    labels: ['person', 'organization', 'email', 'phone', 'address'],
    threshold: 0.5,
  }),
])
```

GLiNER is zero-shot: the labels are the prompt. Ask for `'medical_condition'`
and it looks for one, with no retraining. Because the label text *is* the
prompt, renaming a label changes the results — `'phone'` and `'phone_number'`
are different queries.

The first run downloads roughly 333 MB for the default model. Show
`onProgress`, and consider `isCached()` to decide whether to warn the user
first.

## Read the results

```ts
for (const row of rows) {
  if (row.text.exception) {
    console.warn(`page ${row.page} failed:`, row.text.exception)
    continue
  }

  for (const entity of row.ner.entities) {
    console.log(entity.entity_group, entity.word, entity.score)
    for (const box of entity.boxes) {
      // box.x, box.y, box.width, box.height are in the rendered page's
      // pixel space -- the same space PdfToImage produced.
      ctx.strokeRect(box.x, box.y, box.width, box.height)
    }
  }
}
```

## Timings

Every row carries an `execution_time` field with per-stage milliseconds:

```ts
console.log(rows[0].execution_time)
// { stages: { PdfToImage: 412, PaddleTextRecognizer: 1830 }, total: 2244 }
```

## Next

- [Stage reference](stages.md) — every stage and its parameters
- [Models and caching](models.md) — sizes, self-hosting, private repos
- [Workers](workers.md) — keeping the UI responsive
