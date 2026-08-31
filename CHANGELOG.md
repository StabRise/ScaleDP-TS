# Changelog

## [Unreleased]

### 🚀 Features

- **`TesseractScriptDetector`**, a new stage answering "what is this page written
  in?" before you commit to a recognition model. Reading a Cyrillic page with a
  Latin model does not produce worse text, it produces plausible Latin nonsense,
  and nothing downstream can tell. The OSD model was already in the library as
  `detectScript()`, but only as a function: not in the registry, not in the
  builder, not in a saved pipeline, and with no test or documentation. It is now
  a stage in the Detect group, writing a `ScriptOutput` column carrying the
  script, Tesseract's OSD score, the page rotation OSD returns in the same pass,
  and — via `presetsForScript()` — the ids of the PaddleOCR presets that can read
  the result.

  Two things it deliberately does not do. It never infers the script from
  recognised text: the wrong model garbles the text, so a script guessed from it
  would be wrong exactly when it matters. And an unidentified script is written
  as an empty `script` with an **empty `exception`** — OSD needs a reasonable
  amount of text, and a blank page is an answer, not a failure.

  `script_confidence` is Tesseract's own unbounded score, typically 1–20, not a
  0–1 confidence like every other `scoreThreshold` here; the parameter is
  documented and bounded accordingly.

- **Paddle word boxes now cost nothing in text quality.** Word-level output used
  to cut each line at its ink gaps and recognise every word on its own, and the
  text was measurably worse for it: PP-OCR's recogniser is a CTC model trained on
  full text lines, and a three-character crop stretched to its fixed input height
  is nothing like what it saw in training — it also threw away the line context
  the model's accuracy comes from.

  The order is now reversed. The line is read **whole**, at full context, and the
  words are split out of what came back. On a real page the word-level text is
  now character-for-character the line-level text, where before it dropped
  characters — `https:/stabrise.com/scaledp/` became `https://stabrise.com/scaledp/`.
  It is cheaper too: one inference per line instead of one per word.

  Splitting reconciles the words the model reported with the ink gaps a vertical
  projection finds. Equal counts zip together. Where they disagree the ink decides
  how many boxes there are and the text decides what is in them, so no box is
  invented: more spans than words merges adjacent spans smallest-gap-first, and
  more words than spans joins the extra words back onto the span they fall on.
  That second case matters more than it sounds — on a signature the model emits a
  scatter of single letters for one continuous stroke, and cutting the span up to
  match produced a row of boxes with identical widths and heights, which is the
  character count drawn as a rectangle rather than measured geometry. On the
  sample page it was 10 of the 15 short boxes, and word-level output went from 63
  boxes to 53 with the text unchanged.

  Each word carries its line's score — the model scored the line, not its parts.

  `spaceRecovery` stays **off**, and the word split does not need it: ppu already
  places inter-word spaces from the decode's own geometry, against the median
  inter-character gap. `spaceRecovery` is a separate pass that inserts a space
  wherever the space class scores above `0.001` — a threshold nearly every
  timestep clears on small or noisy text, which turns a line into
  `s e n s i t i v e`. Its help text now says so.

- **`PaddleTextRecognizer` returns word boxes**, like every other recognizer here
  — it was the only one stuck at line level. `boxLevel` and `wordGapRatio` join
  it, sharing `PaddleRecognizer`'s machinery, which now lives in
  `src/ocr/paddle-words.ts` so identical pixels give identical words whichever
  detector found the line.

  **This changes the stage's default output.** `boxLevel` defaults to `'word'`,
  matching `TesseractOcr`, `TesseractRecognizer` and `PaddleRecognizer`;
  `boxLevel: 'region'` is the previous behaviour, and remains the right choice
  for a script that does not separate words with spaces. `strategy` applies to
  `'region'` only — the word path runs its own detection pass — and its help text
  now says so.

- **`NerConsistency` can leave the model's own tags alone.** Its resolution pass
  writes the winning label over every occurrence, the one the model read
  differently included — which is what makes a document consistent, and
  occasionally not what you want. `overrideModelLabels: false` treats the model's
  judgement as final wherever it made one, so propagation only fills spans the
  model left untagged and the stage never changes a tag, only adds them. Worth it
  when the same string genuinely means different things in different places — a
  surname that is also a city. Defaults to `true`, so nothing changes unless you
  ask.

- Two new demo pipelines built on the above: **Paddle OCR (model from the page)**,
  and **PII Detection with Paddle OCR (model from the page)** — the latter with no
  separate text detector at all, so PP-OCR finds its own regions and only the
  *model* follows the script. That is the shape for a document whose language you
  do not know before you run it, which is exactly when a wrong recognition model
  hands GLiNER noise to score.

- **`presetCol` on the PaddleOCR stages: the model can follow the page.** `preset`
  is fixed when the pipeline is built, which is the wrong shape for a document
  whose language you do not know in advance, or one that changes language partway
  through — no single preset reads both halves. `PaddleTextDetector`,
  `PaddleTextRecognizer` and `PaddleRecognizer` now accept `presetCol`, a column
  to take the model from per row. Point it at a `TesseractScriptDetector` column
  and each page is read by a model that can read it.

  `preset` stays as the fallback, so a page OSD could not classify is still read
  rather than skipped, and a column holding a bare preset id works too — the
  choice does not have to come from OSD. Sessions are already cached per preset,
  so a document that swings between scripts loads each model once.

  Left off by default: an empty `presetCol` pins the model exactly as before.

- **The tesseract.js asset paths are configurable.** `detectScript()` was the one
  place in the library that read no paths from `configure()`, silently pulling
  its worker, its core and `osd.traineddata.gz` from a public CDN. `tesseract`
  config now takes `osdWorkerPath`, `osdCorePath`, `osdLangPath` and `osdGzip`
  (the last because a self-hosted directory usually serves plain
  `.traineddata`). Unset keys leave tesseract.js on its own defaults, and
  changing any of them rebuilds the worker on the next detection rather than
  serving a stale one.

  `detectOsd()` is exported alongside `detectScript()` for the raw reading,
  orientation included. `detectScript()` and `suggestPresets()` are unchanged.

- **One colour per entity group, and colours that are actually different.**
  `ImageDrawBoxes` already coloured by group when `color` was unset, but the
  colour was a hash of the group name — and over the label sets these models
  emit, that gave `phone_number` and `date` the *same* hue and put `person` one
  degree from `ip_address`. Any hash over that many labels collides; it is the
  birthday problem, not a bad multiplier. Every group the library's models emit
  now has a hue assigned by hand, spaced 18° from its neighbours, with names for
  one concept (`phone` / `phone_number`) sharing one on purpose. An unlisted
  group still falls back to the hash, so a label nobody anticipated still works.
  `visualizeNer` calls the same function, so the boxes on the image and the
  highlights in the text agree. The demo's PII presets now leave `color` unset.

- `ImageDrawBoxes` defaults `textSize` to **24**, up from 12. The labels are
  drawn onto page images rendered at 200-300 DPI, where 12px was too small to
  read at the size a page is actually viewed.

- **`NerConsistency`**, a new engine-free stage that makes NER output consistent.
  A model scores each mention on its own, so the same name is tagged in the body
  and missed in a heading set in caps, missed again in a table, missed a third
  time because OCR broke it across a line. For redaction that is a correctness
  problem: the occurrence you missed leaks what the others hid.

  The stage pools the entities already found into a vocabulary of strings and
  re-tags every occurrence of them. Matching folds case and collapses runs of
  whitespace — so `JOHN`⏎`SMITH` matches `John Smith` — and requires word
  boundaries, so `Ann` does not match inside `Announcement`. Where two phrases
  overlap the longer one wins.

  - `scope` (default `'document'`) pools across every row, so a name found on
    page 1 is tagged on page 7. `'row'` keeps pages independent.
  - `minLength` (default `3`) and `minScore` (default `0`) bound what is allowed
    to propagate; raise `minScore` to propagate only from confident finds.
  - `resolveConflicts` (default `true`) settles a string tagged two ways on its
    best-scoring label everywhere, so the document ends up consistent rather
    than merely more complete.
  - `Entity` gains an optional `source: 'model' | 'propagated'`, which
    `ImageDrawBoxes` can render like any other field. The field is additive;
    producers that do not track provenance leave it unset.

  It only ever adds: a model span that is not a whole word — `Smith` inside
  `Smithson` — is kept as it was rather than filtered out.

- Both crop-based recognizers now return **one box per word by default**, so
  swapping engines does not change how finely a page comes back.
  - `TesseractRecognizer`'s `boxLevel` default moves from `'region'` to
    `'word'`. The word boxes were always available; only the default changed.
  - `PaddleRecognizer` gains the same `boxLevel` parameter. PaddleOCR reads a
    crop into one undivided string with no geometry inside it, so word boxes
    come from cutting the crop *before* reading it: a vertical projection of the
    ink finds the blank column runs, any run at least `wordGapRatio` of the
    crop's height wide is treated as a space, and each word between them is
    recognised on its own. Every box is therefore measured, not estimated, and
    each word carries its own text and confidence.
  - New `wordGapRatio` (default `0.15`). Measured across 18-64px text, letter
    gaps stay under 0.1 of the crop's height while word spaces land at
    0.20-0.23, so the two separate cleanly at every size.
  - Word boxes are trimmed to the rows a word actually inks, so a word narrower
    than its line is tall is not reported as a 90-degree rotation of itself.
  - `'region'` keeps the previous behaviour, and remains the right choice for
    scripts that do not separate words with spaces.

- `gliner-pii-edge` (`knowledgator/gliner-pii-edge-v1.0`, ~181 MB), the smallest
  model in the catalogue and the only one served at full precision. It needed a
  second decoder: its `span_mode` is `token_level`, so its logits are
  `[batch, words, labels, 3]` — a start, an end and an "inside" score per word
  per label — rather than one score per enumerated span. `decodeTokenSpans`
  assembles a span from a start paired with a later end whose whole interior
  also scores, and takes the weakest of the three as the span's score.
  `span_mode` in the model's config picks the decoder.
- Three more GLiNER models from the Hub, all `markerV0` GLiNER1 like the
  existing ones and all verified end to end: `gliner-medium`
  (`onnx-community/gliner_medium-v2.1`, ~392 MB), `gliner-medium-news`
  (news-tuned, ~392 MB) and `gliner-multi` (`gliner_multi-v2.1`, ~580 MB). Only
  `gliner-multi-pii` is PII-tuned; the rest are general NER that GLiNER's
  zero-shot labelling still points at the PII label set.

### 🐛 Fixes

- Entities found in the text but drawn nowhere on the page. `buildCharToBoxMap`
  walked `bboxes` in the detector's order with a forward-only cursor, but
  `keepFormatting` lays the text out in *reading* order — clustered by `y`, then
  sorted by `x`. Every box the detector happened to find out of order sat behind
  the cursor, was skipped, and left its characters mapped to no box at all, so
  the entity came back with an empty `boxes` array. The scan still prefers a
  match ahead of the cursor, which is what keeps a string repeated in a header
  and a footer attached to the right box, but now falls back to any unclaimed
  occurrence rather than giving up. Affects `GlinerNer` on any page whose
  detection order is not its reading order.

- **A failing model cache took the model down with it.** `ensureModelFiles`
  awaited the IndexedDB write with nothing catching it, so a store that refused
  the write — a full quota above all, but also a private window or a database
  held at a version this build does not know — rejected the whole call. The
  weights had already downloaded successfully; they were then thrown away and
  the stage failed. Worse, nothing was ever cached, so the next run downloaded
  them again and failed again. Every cache read and write is now best-effort:
  on failure it warns once, names the reason, and carries on with the bytes in
  hand. A browser test holds the database at a future version to prove a model
  still loads through it.
- Ask for persistent storage in the demo, via the new `requestPersistentStorage()`.
  Cached weights run to hundreds of megabytes, which makes the origin the first
  thing a browser evicts under disk pressure; "best effort" storage is exactly
  the wrong default for it.
- **Cache a downloaded model as a Blob rather than an ArrayBuffer.** Chrome
  structured-clones an ArrayBuffer into the IndexedDB value payload, so writing
  one meant a second full copy of the weights in the renderer at commit time --
  on top of the copy the caller already holds and whatever onnxruntime-web then
  allocates. On a several-hundred-megabyte model that is enough to lose the tab
  immediately after a download that had just finished. A large Blob is kept in
  disk-backed storage and referenced instead, and the bytes are never assembled
  into one JS-side buffer before the write. Entries left by an older build are
  still read.

- **`GlinerNer` found nothing at all.** Every model in the catalogue was served
  as 8-bit weights, and 8-bit quantization of these DeBERTa-backed GLiNER models
  wrecks their score calibration rather than merely blunting it. The spans
  decoded correctly; their scores just collapsed below the default `threshold`
  of 0.5, so the stage filtered every entity out and returned an empty result
  rather than an error. On one sentence the default model scored `person`,
  `account_number` and `date` at 1.00 / 0.99 / 1.00 in fp16 and fp32, but
  0.38 / 0.37 / 0.16 in int8; `gliner_medium-v2.1` at int8 was worse still —
  fourteen spurious spans, none above 0.05. The catalogue now serves fp16
  throughout, which matches fp32 exactly for roughly 1.7x the download. A unit
  test keeps 8-bit weights out of the public catalogue.

### 📚 Documentation

- The demo's runtime strip is now a pair of controls. The execution provider can
  be set to auto, WebGPU or WASM, and switching it drops the engines cached
  against the old one so the next run rebuilds on the new one — no reload.
  Multithreading has its own toggle and a thread count — `auto`, or any number
  up to what the machine reports — showing what it resolves to and saying
  plainly when the page is not cross-origin isolated and threads are therefore
  unavailable. `auto` leaves a core for the interface and caps at 4; an explicit
  count is passed through as given. Changing either offers a reload rather than
  pretending: `env.wasm.numThreads` is read when onnxruntime-web starts its WASM
  runtime, and there is no way to restart it inside a page.
- The demo's starter pipelines are now Tesseract OCR, Paddle OCR, each of those
  again behind DBNet text detection, and a PII detection preset for each engine.
  The two PII presets are the same shape and differ only in which recognizer
  reads the page, so they compare directly. Both Paddle-behind-detection presets
  enable `detectLineOrientation`, matching what the Tesseract ones do by default.
- The demo's model dropdowns mark the entries already in this browser with a
  tick, so the cost of a choice is visible before making it. The set is
  re-probed after each run, when one more of them has just become cached.

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
