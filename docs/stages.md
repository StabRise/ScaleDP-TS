# Stage reference

Every stage takes an options object, reads one row field and writes another.
Defaults match the Python ScaleDP stage of the same name wherever one exists.

## Common parameters

Accepted by every stage:

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `inputCol` | `string` | per stage | Row field to read |
| `outputCol` | `string` | per stage | Row field to write |
| `pathCol` | `string` | `'path'` | Field holding the source path |
| `pageCol` | `string` | `'page'` | Field holding the page index |
| `keepInputData` | `boolean` | per stage | Keep `inputCol` instead of dropping it |
| `propagateError` | `boolean` | `false` | Throw on failure instead of recording it |

---

## Core

### `DataToImage`

Raw bytes into an `Image` record. Dimensions are probed without retaining the
decoded bitmap.

| Parameter | Default |
|---|---|
| `inputCol` | `'content'` |
| `outputCol` | `'image'` |
| `imageType` | `'png'` |
| `resolution` | `0` |

---

## `@stabrise/scaledp/pdf`

### `PdfToImage`

A PDF into one image row per page. Mirrors `PdfDataToImage`.

| Parameter | Default | Meaning |
|---|---|---|
| `inputCol` | `'content'` | |
| `outputCol` | `'image'` | |
| `resolution` | `300` | Render DPI. 300 suits OCR; 150 halves the time |
| `pageLimit` | `0` | Maximum pages; 0 renders all |
| `imageType` | `'png'` | |

### `PdfToDocument`

A PDF's embedded text layer into one `Document` row per page, with word-level
boxes. Mirrors `PdfDataToText`. Use it to skip OCR on pages that already have
text.

| Parameter | Default | Meaning |
|---|---|---|
| `outputCol` | `'document'` | |
| `resolution` | `300` | Pixel space for the boxes. Match `PdfToImage` to align them |
| `pageLimit` | `0` | |
| `splitWords` | `true` | Split pdf.js line runs into words |

Boxes come out in the same pixel space `PdfToImage` renders at, so text-layer
and OCR boxes are directly comparable. Python leaves `PdfDataToText` in PDF
points; this is a deliberate divergence.

---

## `@stabrise/scaledp/ocr`

### `PaddleTextRecognizer`

Full OCR: image to `Document` with text and word boxes.

| Parameter | Default | Meaning |
|---|---|---|
| `inputCol` | `'image'` | |
| `outputCol` | `'text'` | |
| `preset` | `'v6-small'` | Language preset; see `PADDLE_OCR_PRESETS` |
| `scoreThreshold` | `0.5` | Drop words below this confidence |
| `strategy` | `'per-box'` | `'per-box'` gives words, `'per-line'` gives lines |
| `keepFormatting` | `false` | Rebuild layout with spaces and blank lines |
| `lineTolerance` | `0` | Line grouping in px; 0 derives from character height |

### `PaddleTextDetector`

Detection only — boxes, no text.

| Parameter | Default |
|---|---|
| `outputCol` | `'boxes'` |
| `preset` | `'v6-small'` |

### `DbnetOnnxDetector`

The direct mirror of ScaleDP's `DBNetOnnxDetector`, so the same model runs in
the browser.

| Parameter | Default | Meaning |
|---|---|---|
| `model` | `'StabRise/text_detection_dbnet_ml_v0.2'` | |
| `scoreThreshold` | `0.3` | Mean in-box probability a candidate must reach |
| `binaryThreshold` | `0.5` | Probability above which a pixel counts as text |
| `unclipRatio` | `2.5` | How far to grow each box; DB shrinks regions in training |
| `mergeBoxes` | `true` | Merge overlapping boxes on the same line |

### `TesseractOcr`

| Parameter | Default |
|---|---|
| `lang` | `['eng']` |
| `scoreThreshold` | `0.5` |
| `keepFormatting` | `false` |

Needs `configure({ tesseract: { workerUrl, dataUrl } })`.

### Language presets

`v6-small` (default, Latin/CJK), `v6-medium`, `v6-tiny`, `v5-latin-mobile`,
`v5-eslav-mobile`, `v5-cyrillic-mobile`, `v5-devanagari-mobile`,
`v5-arabic-mobile`, `v5-greek-mobile`, `v5-korean-mobile`, `v5-thai-mobile`,
`v5-tamil-mobile`, `v5-telugu-mobile`, `v5-en-mobile`.

No single model covers every script, so this is a real choice. `detectScript()`
reports what a page contains and `presetsForScript()` lists what can read it.

---

## `@stabrise/scaledp/ner`

### `GlinerNer`

| Parameter | Default | Meaning |
|---|---|---|
| `inputCol` | `'text'` | A `Document` |
| `outputCol` | `'ner'` | |
| `model` | `'gliner-multi-pii'` | Registry id; see `NER_MODELS` |
| `labels` | `DEFAULT_PII_LABELS` | Entity types to look for |
| `threshold` | `0.5` | Minimum score |
| `whiteList` | `[]` | Keep only these groups; empty keeps all |
| `chunkLength` | `500` | Characters per window |
| `chunkStride` | `480` | Window step; the 20-char overlap catches seam entities |
| `normaliseCasing` | `true` | Title-case all-caps text before inference |

Labels are the prompt. `'phone'` and `'phone_number'` are different queries, and
a model fine-tuned on one will score the other lower.

`normaliseCasing` matters for scans: GLiNER1 models are cased, and a document set
entirely in capitals looks unlike anything in training. The rewrite is
length-preserving, so character offsets stay valid and reported words keep their
original casing.

---

## `@stabrise/scaledp/detect`

### `YoloOnnxDetector`, `SignatureDetector`, `FaceDetector`

| Parameter | Default | Meaning |
|---|---|---|
| `model` | required (preset on subclasses) | |
| `labels` | `[]` | Class index to label; empty gives `class_<n>` |
| `scoreThreshold` | `0.2` | |
| `iouThreshold` | `0.5` | Duplicate suppression |
| `padding` | `0` | Grow boxes by this fraction |

`SignatureDetector` defaults to `StabRise/signature_detection` writing
`signatures`; `FaceDetector` to `StabRise/face_detection` writing `faces`.

---

## Output schemas

```ts
interface Box { text: string; score: number; x: number; y: number
                width: number; height: number; angle: number }

interface Document { path: string; text: string; type: string
                     bboxes: Box[]; exception: string }

interface DetectorOutput { path: string; type: string
                           bboxes: Box[]; exception: string }

interface Entity { entity_group: string; score: number; word: string
                   start: number; end: number; boxes: Box[] }

interface NerOutput { path: string; entities: Entity[]
                      exception: string; json: string }
```

`Box` is neither xyxy nor a polygon. `x`/`y` is the top-left of the
axis-aligned box of the same size centred on the rotated rect's centre, and
`angle` is degrees about that centre. `width` is always the longer side. This
matches ScaleDP exactly — see `scaledp/schemas/Box.py`.
