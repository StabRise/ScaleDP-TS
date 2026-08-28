# Porting from Python ScaleDP

The two libraries share a pipeline model, stage names, parameter names and
schemas. What differs is the runtime.

## Stage map

| Python ScaleDP | scaledp-ts | Notes |
|---|---|---|
| `DataToImage` | `DataToImage` | |
| `PdfDataToImage` | `PdfToImage` (`/pdf`) | |
| `PdfDataToText` | `PdfToDocument` (`/pdf`) | Boxes in pixels, not points |
| `PdfDataToDocument` | `PdfToDocument` (`/pdf`) | One stage covers both |
| `TesseractOcr` | `TesseractOcr` (`/ocr`) | tesseract-wasm; no PSM/OEM |
| `HasDetectLineOrientation` | `LineOrientationDetector` (`/ocr`) | A stage, not a recognizer mixin |
| `EasyOcr`, `SuryaOcr`, `DocTROcr` | `PaddleTextRecognizer` (`/ocr`) | No browser builds of those engines |
| `DBNetOnnxDetector` | `DbnetOnnxDetector` (`/ocr`) | Same model, same thresholds |
| `CraftTextDetector` | — | PyTorch only |
| `LayoutDetector` | — | Needs the PaddleOCR Python runtime |
| `YoloOnnxDetector` | `YoloOnnxDetector` (`/detect`) | |
| `SignatureDetector` | `SignatureDetector` (`/detect`) | |
| `FaceDetector` | `FaceDetector` (`/detect`) | |
| `Ner` | `GlinerNer` (`/ner`) | GLiNER, not BERT token classification |
| `LLMOcr`, `LLMNer`, `LLMExtractor` | — | Any fetch-based OpenAI client works |
| `TextSplitter`, `TextEmbeddings` | — | Not yet ported |
| `df.show_image` | `showImage` (`/display`) | Returns an element, not IPython HTML |
| `df.show_text` | `showText` (`/display`) | |
| `df.show_json` | `showJson` (`/display`) | |
| `df.show_ner` | `showNer` (`/display`) | |
| `df.visualize_ner` | `visualizeNer` (`/display`) | |
| `ImageDrawBoxes` | `ImageDrawBoxes` | |
| `ImageCropBoxes` | `ImageCropBoxes` | |

## API differences

**Options objects, not `inputCol`/`outputCol` positionally.** Column names
remain valid options with the same defaults, so a stage can still be wired
explicitly.

```python
TesseractOcr(inputCol="image", outputCol="text", keepFormatting=True)
```
```ts
new PaddleTextRecognizer({ inputCol: 'image', outputCol: 'text', keepFormatting: true })
```

**Rows, not a DataFrame.** `transform` returns `Row[]` — plain objects. Page
explosion produces several rows per input, exactly as `posexplode` does.

**Everything is async.** Model loading, decoding and inference are all promises.

**No Estimators.** There are none in Python ScaleDP either; every stage is a
pure transform. There is no `fit()`.

## What carries over unchanged

- The **non-throwing error contract**: failures land in `exception` and the
  pipeline completes. `propagateError` opts into throwing.
- The **`Box` convention**: `x`/`y` is the top-left of the axis-aligned box of
  the same size centred on the rotated rect's centre; `angle` is degrees about
  that centre; `width` is the longer side.
- **Parameter names and defaults**, wherever a Python equivalent exists.
- **Layout-preserving text reconstruction** under `keepFormatting`, including
  the per-line indent and blank-line rules.

Both the `Box` geometry and the text reconstruction are verified against the
real Python implementation: `test/fixtures/*.py` generate goldens by running
ScaleDP itself, and the parity suites diff against those.

## Deliberate divergences

Each is a fix, and each is commented at its site.

**`PdfToDocument` emits pixels, not points.** Text-layer and OCR boxes then
share one coordinate space and can be compared directly.

**NER de-duplicates across chunks.** Python's 500/480 sliding window has no
cross-chunk dedup, so an entity in the 20-character overlap is reported twice.

**The character-to-box map is built from the real text.** Python derives it from
`len(box.text) + 1`, assuming exactly one separator per box. That drifts as soon
as `keepFormatting` inserts several spaces or a newline, shifting every
entity's boxes after the first wide gap. Here each box's text is located in the
document text instead.

## Python bugs not reproduced

Found while porting; listed so nobody "fixes" the TS side back toward them.

- `DBNetOnnxDetector.scoreThreshold` never reaches `DBPostProcess`; the
  effective threshold is the hardcoded 0.3. Here the parameter is wired through.
- `use_gpu = params["model"] == Device.CUDA` compares a model-name string to an
  enum and is always false.
- `YoloOnnxTextDetector` multiplies by the letterbox scale where DBNet divides.
- `Ner.aggregate_ner_results` builds `new_ner_results` and then discards it.
- `TesseractRecognizer` sets `b.conf` but filters on `b.score`, so
  `scoreThreshold` is applied to the detector's score rather than the
  recognizer's.
