# Changelog

## [0.1.1] - 29.08.2026

### 🚀 Features

- Added [`PaddleRecognizer`](https://scaledp-ts.stabrise.com/docs/stages/recognise/paddle-recognizer)
  to `@stabrise/scaledp/ocr` — PaddleOCR recognition over the boxes a *separate*
  detector found, the PP-OCR counterpart to `TesseractRecognizer`. Reads
  `[image, boxes]` and writes a `Document`, so `DbnetOnnxDetector`,
  `YoloOnnxDetector` or `PaddleTextDetector` can now feed PP-OCR. `PaddleTextRecognizer`
  detects internally in one pass and still ignores any detector's boxes.
  - Each box is cropped and straightened before reading, so a rotated region is
    read level rather than as its axis-aligned envelope. The box that comes back
    is the detector's own, angle included, carrying the recognised text and score.
  - Crops are stacked onto a sheet canvas and read in one batched call.
    PaddleOCR only batches within a single call and cuts its crops from one
    canvas, so a forty-line page costs a handful of inferences rather than forty.
  - Only the recognition model and character dictionary are downloaded — never
    the detection half of the preset. Cache keys are shared with
    `PaddleTextDetector` and `PaddleTextRecognizer`, so a pipeline using both
    pays for each file once.
  - No `strategy` parameter: `'per-line'` and `'cross-line'` merge boxes before
    reading them, and the contract here is one result per box handed in.
  - `detectLineOrientation` defaults to `false`, unlike `TesseractRecognizer`.
    PaddleOCR already turns crops markedly taller than wide, so only the 180°
    case is missing, and catching it costs a separate ~9 MB model.
- `@stabrise/scaledp/ocr` gained `getPaddleRecognizer()` for building a
  recognition-only service directly, with the `PaddleRecognitionService` and
  `PaddleRecognizerOptions` types.
- `createSession()` gained an opt-in `fallbackToWasm`, plus the exported
  `wasmFallbackProviders()` behind it. WebGPU rewrites convolutions into its
  `com.ms.internal.nhwc` domain and fails at *session creation* on a graph it has
  no kernel for — PP-OCR's recognition model among them. The recognition session
  opts in, matching what `PaddleOcrService` already did internally. Off by
  default, so a genuinely misconfigured provider still fails loudly.
- `validatePreset()` moved to `@stabrise/scaledp/ocr` `presets` and is now
  exported, alongside `isKnownPreset()`.
- `rotate180()` is now exported from the core image helpers, having been private
  to the Tesseract recognizer.

### 💥 Breaking

- Renamed the two PaddleOCR defaults constants to match their stage class names,
  freeing `PADDLE_RECOGNIZER_DEFAULTS` for the new stage:
  - `PADDLE_DETECTOR_DEFAULTS` → `PADDLE_TEXT_DETECTOR_DEFAULTS`
  - `PADDLE_RECOGNIZER_DEFAULTS` → `PADDLE_TEXT_RECOGNIZER_DEFAULTS`

  `PADDLE_RECOGNIZER_DEFAULTS` still exists but now belongs to `PaddleRecognizer`
  and has a different shape — it carries `inputCols` and no `strategy`. Code
  importing it for `PaddleTextRecognizer` will not silently misbehave, but it
  will not type-check either. No stage `type` string changed, so saved pipeline
  descriptors are unaffected.

### 📚 Documentation

- New stage page for `PaddleRecognizer`, with its parameter table generated from
  the stage registry as usual.
- The installation peer table, the Python porting map, the stage index, and the
  `PaddleTextDetector` / `TesseractRecognizer` / `TesseractOcr` pages now point
  at the new stage.
- The demo gained a "Detect, then read with PaddleOCR" preset beside the existing
  Tesseract one.

## [0.1.0] - 29.08.2026

Initial release.
