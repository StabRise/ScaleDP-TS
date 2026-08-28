# Workers, threading and COOP/COEP

## Why a worker

OCR and NER are multi-second CPU-bound operations. On the main thread they
freeze the tab. Everything in this library is `OffscreenCanvas`-based and
DOM-free precisely so the whole pipeline can move into a worker.

## Setup

A worker entry lives in your app, because only your bundler can resolve a
worker URL.

```ts
// src/scaledp.worker.ts
import { registerStages, startScaleDpWorker } from '@stabrise/scaledp/worker'
import { PdfToImage } from '@stabrise/scaledp/pdf'
import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'
import { GlinerNer } from '@stabrise/scaledp/ner'

registerStages({ PdfToImage, PaddleTextRecognizer, GlinerNer })
startScaleDpWorker()
```

Register only the stages you use: importing all of them would pull pdf.js, ORT,
PaddleOCR and Tesseract into every worker bundle.

```ts
// main thread
import { createScaleDpWorker } from '@stabrise/scaledp/worker'

const client = createScaleDpWorker({
  worker: new Worker(new URL('./scaledp.worker.ts', import.meta.url), { type: 'module' }),
  onProgress: (p) => setDownloadProgress(p),
  onStage: (name, ms) => console.log(`${name}: ${ms}ms`),
})

await client.configure({ cache: 'indexeddb', pdf: { workerSrc: '/pdf.worker.min.mjs' } })

const rows = await client.transform(
  [{ type: 'PdfToImage', options: { resolution: 300 } }, { type: 'PaddleTextRecognizer' }],
  [{ content: bytes, path: 'invoice.pdf' }]
)
```

`configure()` on the client cannot carry `auth` or `onProgress` — functions do
not survive `postMessage`. Progress comes back through the client's own
`onProgress`. For `auth`, call `configure({ auth })` inside the worker entry.

## Requests are serialised

An onnxruntime-web session runs one inference at a time; a concurrent call fails
with `Session already started`. Both the client and the host queue requests, so
several `transform` calls are safe — they simply run in order.

## WASM threads need cross-origin isolation

Multi-threaded WebAssembly requires `SharedArrayBuffer`, which requires the
**page** to be cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without those headers, `crossOriginIsolated` is false, ORT falls back to its
single-threaded build, and `numThreads` has no effect. This is a property of
the page, not the worker — moving work into a worker does not escape it.

```ts
import { isCrossOriginIsolated } from '@stabrise/scaledp/ocr'

if (!isCrossOriginIsolated()) {
  console.info('Single-threaded WASM: set COOP/COEP headers, or prefer WebGPU.')
}
```

A library cannot set headers for its consumer, so this is reported rather than
enforced. Note that `require-corp` also affects every cross-origin resource the
page loads, which is why it is worth deciding deliberately.

**WebGPU needs no cross-origin isolation**, and is generally faster than even
multi-threaded WASM. Where it is available it is the simpler answer.

## Thread count

```ts
configure({ numThreads: 4 })  // 0 (default) derives from hardwareConcurrency
```

The default leaves one core for the UI and caps at 4; past that ORT's own
synchronisation overhead outweighs the gain at these model sizes. The value is
baked into a session when it is created, so changing it later requires a
fresh stage.
