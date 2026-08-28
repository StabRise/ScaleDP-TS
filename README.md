<p align="center">
  <br/>
    <a href="https://stabrise.com/scaledp/" target="_blank"><img alt="ScaleDP" src="https://stabrise.com/static/images/projects/scaledp.webp" width="450" style="max-width: 100%;"></a>
  <br/>
</p>

<p align="center">
    <i>Process documents using AI/ML in the browser. No server, no upload.</i>
</p>

<p align="center">
    <a href="https://www.npmjs.com/package/@stabrise/scaledp" alt="Package on npm"><img src="https://img.shields.io/npm/v/@stabrise/scaledp.svg" /></a>
    <a href="https://github.com/StabRise/scaledp-ts/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@stabrise/scaledp.svg?color=blue"></a>
    <a href="https://stabrise.com"><img alt="StabRise" src="https://img.shields.io/badge/powered%20by-StabRise-orange.svg?style=flat&colorA=E1523D&colorB=blue"></a>
</p>

---

**Source Code**: <a href="https://github.com/StabRise/scaledp-ts/" target="_blank">https://github.com/StabRise/scaledp-ts</a>

**Python sibling**: <a href="https://github.com/StabRise/ScaleDP/" target="_blank">ScaleDP</a> — the same pipeline model, on Apache Spark

---

# scaledp-ts

`@stabrise/scaledp` processes PDFs and images entirely in the browser: PDF
rendering, text detection, OCR and named-entity recognition, composed as a
pipeline. Inference runs on [onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/)
over WebAssembly or WebGPU.

It mirrors the [ScaleDP](https://github.com/StabRise/ScaleDP) Python library —
same stages, same parameter names, same schemas — so a pipeline reads the same
in both. What differs is the runtime: no Spark, no server, and **no document
ever leaves the browser**, which is the point for anything sensitive.

## Key features

### Document processing

- Load PDFs and images from a `File`, `Blob`, `ArrayBuffer` or URL
- Render PDF pages, or read an existing text layer and skip OCR entirely
- Word-level bounding boxes throughout, so every result maps back to the page

### OCR

- **PaddleOCR** (PP-OCRv5/v6) via [ppu-paddle-ocr](https://www.npmjs.com/package/ppu-paddle-ocr) — 13 language presets
- **DBNet ONNX** — the same detection model ScaleDP uses server-side
- **Tesseract** via [tesseract-wasm](https://www.npmjs.com/package/tesseract-wasm), with independent script detection

### NLP

- **GLiNER** zero-shot NER: entity types are plain-language labels given at call time, not fixed by the model
- Both GLiNER1 and GLiNER2 architectures
- Entities carry the boxes they came from, ready to highlight or redact

### CV

- YOLO object detection, including signature and face detectors

## Installation

```bash
npm install @stabrise/scaledp
```

Engines are optional peer dependencies — install only what you use:

```bash
npm install pdfjs-dist                        # PDF reading
npm install onnxruntime-web ppu-paddle-ocr    # PaddleOCR
npm install onnxruntime-web @huggingface/transformers  # GLiNER NER
npm install tesseract-wasm tesseract.js       # Tesseract + script detection
```

## Quickstart

```ts
import { Pipeline, configure } from '@stabrise/scaledp'
import { PdfToImage } from '@stabrise/scaledp/pdf'
import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'
import { GlinerNer } from '@stabrise/scaledp/ner'

configure({
  cache: 'indexeddb',
  pdf: { workerSrc: '/pdf.worker.min.mjs' },
  onProgress: (p) => console.log(`${p.file}: ${p.loaded}/${p.total}`),
})

const pipeline = new Pipeline([
  new PdfToImage({ resolution: 300 }),
  new PaddleTextRecognizer({ preset: 'v6-small', keepFormatting: true }),
  new GlinerNer({ labels: ['person', 'organization', 'email', 'phone'] }),
])

const rows = await pipeline.transform(file)

for (const row of rows) {
  console.log(row.page, row.text.text)
  for (const entity of row.ner.entities) {
    console.log(entity.entity_group, entity.word, entity.boxes)
  }
}
```

Compare with the Python original:

```python
pipeline = PipelineModel(stages=[
    PdfDataToImage(resolution=300),
    TesseractOcr(inputCol="image", outputCol="text", keepFormatting=True),
    Ner(inputCol="text", outputCol="ner"),
])
result = pipeline.transform(df)
```

### Skip OCR when the PDF already has text

```ts
import { PdfToDocument, hasUsableTextLayer } from '@stabrise/scaledp/pdf'

const pipeline = new Pipeline([new PdfToDocument({ resolution: 300 })])
const rows = await pipeline.transform(file)

// Only pages without a text layer need the OCR pipeline.
const needsOcr = rows.filter((r) => !hasUsableTextLayer(r.document))
```

### Run off the main thread

```ts
// worker.ts
import { registerStages, startScaleDpWorker } from '@stabrise/scaledp/worker'
import { PdfToImage } from '@stabrise/scaledp/pdf'
import { PaddleTextRecognizer } from '@stabrise/scaledp/ocr'

registerStages({ PdfToImage, PaddleTextRecognizer })
startScaleDpWorker()
```

```ts
// main.ts
import { createScaleDpWorker } from '@stabrise/scaledp/worker'

const client = createScaleDpWorker({
  worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  onProgress: (p) => console.log(p),
})

const rows = await client.transform(
  [{ type: 'PdfToImage' }, { type: 'PaddleTextRecognizer' }],
  [{ content: bytes, path: 'invoice.pdf' }]
)
```

## Errors never abort a pipeline

Every output schema carries an `exception` field. A stage that fails records the
message there and the pipeline continues, so one bad page does not lose the
other forty. Pass `propagateError: true` to a stage to make it throw instead.

```ts
const row = rows[0]
if (row.text.exception) console.warn('OCR failed:', row.text.exception)
```

## OCR engines

|                    | Box level | Models fetched | WebGPU | Notes |
|--------------------|-----------|----------------|--------|-------|
| PaddleOCR (default)| word      | ~6 MB          | yes    | 13 language presets, best all-rounder |
| DBNet ONNX         | word      | ~5 MB          | yes    | Detection only; mirrors ScaleDP server-side |
| Tesseract          | word      | ~15 MB / lang  | no     | No ONNX; good for clean Latin scans |

## Documentation

- [Quickstart](docs/quickstart.md)
- [Stage reference](docs/stages.md)
- [Models and caching](docs/models.md)
- [Workers, threading and COOP/COEP](docs/workers.md)
- [Porting from Python ScaleDP](docs/porting.md)

## License

AGPL-3.0-or-later, matching the Python library. Contact
[StabRise](https://stabrise.com) for commercial licensing.
