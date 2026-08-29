/**
 * The stage catalogue: one `StageSpec` per concrete stage.
 *
 * Transcribed from `docs/stages.md`, which is the same table in prose. Every
 * `defaults` entry is the stage's own frozen constant rather than a copy, and
 * every enum's options come from the model registries that already exist
 * (`PADDLE_OCR_PRESETS`, `NER_MODELS`, `DETECTOR_MODELS`) rather than a second
 * hand-maintained list.
 *
 * Importing this module costs no ML runtime: every engine in the library is
 * reached through a dynamic `import()` inside `ocr/ort.ts`, `pdf/pdfjs.ts`,
 * `ocr/paddle-service.ts` and `ocr/tesseract.ts`, so pulling in the twelve stage
 * classes pulls in no `onnxruntime-web`, `pdfjs-dist`, `ppu-paddle-ocr` or
 * `tesseract-wasm`. It does pull in every stage's code, which is why this lives
 * behind its own subpath instead of the root barrel.
 */

import { FaceDetector, SignatureDetector, YOLO_DETECTOR_DEFAULTS, YoloOnnxDetector } from '../detect/index.js'
import { GLINER_NER_DEFAULTS, GlinerNer, modelSizeBytes, NER_MODELS } from '../ner/index.js'
import {
    DBNET_DETECTOR_DEFAULTS,
    DbnetOnnxDetector,
    DEFAULT_ORIENTATION_MODEL,
    DETECTOR_MODELS,
    LINE_ORIENTATION_DEFAULTS,
    LineOrientationDetector,
    PADDLE_DETECTOR_DEFAULTS,
    PADDLE_OCR_PRESETS,
    PADDLE_RECOGNIZER_DEFAULTS,
    PaddleTextDetector,
    PaddleTextRecognizer,
    TESSERACT_OCR_DEFAULTS,
    TESSERACT_RECOGNIZER_DEFAULTS,
    TesseractOcr,
    TesseractRecognizer,
} from '../ocr/index.js'
import { PDF_TO_DOCUMENT_DEFAULTS, PDF_TO_IMAGE_DEFAULTS, PdfToDocument, PdfToImage } from '../pdf/index.js'
import { DATA_TO_IMAGE_DEFAULTS, DataToImage } from '../stages/data-to-image.js'
import { IMAGE_CROP_BOXES_DEFAULTS, ImageCropBoxes } from '../stages/image-crop-boxes.js'
import { IMAGE_DRAW_BOXES_DEFAULTS, ImageDrawBoxes } from '../stages/image-draw-boxes.js'
import type { ColumnKind, StageParamOption, StageParamSpec, StageSpec } from './types.js'

/**
 * Widen a stage's typed defaults into an indexable record.
 *
 * `*_DEFAULTS` are typed as their stage's params interface, and an interface has
 * no index signature -- so it is not assignable to `Record<string, unknown>`
 * even though every key is a string. The values are frozen and read-only either
 * way; only the type changes.
 */
const asRecord = <T extends object>(defaults: Readonly<T>): Readonly<Record<string, unknown>> =>
    defaults as Readonly<Record<string, unknown>>

/* ── Enum option lists, derived from the existing registries ─────────────── */

const IMAGE_TYPES: readonly StageParamOption[] = Object.freeze([
    { value: 'png', label: 'PNG', title: 'Lossless; the safe default for OCR' },
    { value: 'webp', label: 'WebP', title: 'Smaller, lossy' },
    { value: 'jpeg', label: 'JPEG', title: 'Smallest, lossy; artefacts can cost accuracy' },
])

const STRATEGIES: readonly StageParamOption[] = Object.freeze([
    { value: 'per-box', label: 'Per box', title: 'Word-level boxes, as detected' },
    { value: 'per-line', label: 'Per line', title: 'Merge boxes that share a line' },
    { value: 'cross-line', label: 'Cross line', title: 'Merge across line breaks too' },
])

/**
 * Fields `ImageDrawBoxes` can render above a box.
 *
 * The label is built by reading these off the box or entity, so the valid names
 * are the schema's own field names -- `Box` for a detector or OCR result,
 * `Entity` for NER output. Numbers are formatted to two decimals.
 */
const LABEL_FIELDS: readonly StageParamOption[] = Object.freeze([
    { value: 'text', label: 'text', title: 'Box: the recognised text' },
    { value: 'score', label: 'score', title: 'Box or entity: confidence, 0-1' },
    { value: 'angle', label: 'angle', title: 'Box: degrees about its centre' },
    { value: 'entity_group', label: 'entity_group', title: 'Entity: the label it matched' },
    { value: 'word', label: 'word', title: 'Entity: the matched text' },
    { value: 'x', label: 'x', title: 'Box: top-left x' },
    { value: 'y', label: 'y', title: 'Box: top-left y' },
    { value: 'width', label: 'width', title: 'Box: the longer side' },
    { value: 'height', label: 'height', title: 'Box: the shorter side' },
])

const OCR_PRESETS: readonly StageParamOption[] = Object.freeze(
    PADDLE_OCR_PRESETS.map((preset) => ({
        value: preset.value,
        label: preset.label,
        title: preset.scripts.join(', '),
    }))
)

const NER_MODEL_OPTIONS: readonly StageParamOption[] = Object.freeze(
    NER_MODELS.map((model) => ({
        value: model.id,
        label: `${model.name} · ${model.languages.join('/')}${model.private ? ' · private' : ''}`,
        title: `${model.arch}, ${Math.round(modelSizeBytes(model) / 1e6)} MB, ${model.repo}`,
        // Private repos need configure({ auth }); offering one without it only
        // produces a 401 mid-pipeline.
        disabled: model.private === true,
    }))
)

const DBNET_MODEL_OPTIONS: readonly StageParamOption[] = Object.freeze(
    DETECTOR_MODELS.filter((model) => model.kind === 'dbnet-onnx' && model.repo).map((model) => ({
        value: model.repo as string,
        label: model.name,
        title: model.notes,
    }))
)

/* ── Param builders ──────────────────────────────────────────────────────── */

const column = (key: string, label: string, extra: Partial<StageParamSpec> = {}): StageParamSpec => ({
    key,
    kind: 'column',
    label,
    ...extra,
})

/**
 * The six params every stage inherits from `BaseStageParams`.
 *
 * `inputCol` and `outputCol` are the wiring a builder actually cares about;
 * the rest is plumbing, so it is marked advanced. Stages that read several
 * columns pass `multiInput` -- there `inputCol` is inherited but unused, and
 * showing it as the input would be a lie.
 */
function baseParams(
    options: { input?: { help?: string; accepts?: ColumnKind[] } | 'unused'; output?: { help?: string } } = {}
): StageParamSpec[] {
    const input =
        options.input === 'unused'
            ? column('inputCol', 'Input column', {
                  advanced: true,
                  help: 'Inherited but unused: this stage reads the columns listed in inputCols.',
              })
            : column('inputCol', 'Input column', {
                  help: options.input?.help,
                  accepts: options.input?.accepts,
              })

    return [
        input,
        column('outputCol', 'Output column', { help: options.output?.help }),
        column('pathCol', 'Path column', {
            advanced: true,
            help: 'Row field holding the source path, copied onto the output.',
        }),
        column('pageCol', 'Page column', {
            advanced: true,
            help: 'Row field holding the page index for multi-page inputs.',
        }),
        {
            key: 'keepInputData',
            kind: 'boolean',
            label: 'Keep input column',
            advanced: true,
            help: 'Keep the input column in the output rows instead of dropping it.',
        },
        {
            key: 'propagateError',
            kind: 'boolean',
            label: 'Throw on error',
            advanced: true,
            help: 'Throw instead of recording the failure in the output’s exception field.',
        },
    ]
}

const imageType: StageParamSpec = {
    key: 'imageType',
    kind: 'enum',
    label: 'Image format',
    options: IMAGE_TYPES,
}

const scoreThreshold = (help: string): StageParamSpec => ({
    key: 'scoreThreshold',
    kind: 'number',
    label: 'Score threshold',
    min: 0,
    max: 1,
    step: 0.05,
    help,
})

const lang: StageParamSpec = {
    key: 'lang',
    kind: 'stringList',
    label: 'Languages',
    required: true,
    help: 'Tesseract language codes, e.g. eng or eng, deu. Each needs its traineddata file.',
}

const keepFormatting: StageParamSpec = {
    key: 'keepFormatting',
    kind: 'boolean',
    label: 'Keep formatting',
    help: 'Rebuild the original layout with spaces and blank lines.',
}

const lineTolerance: StageParamSpec = {
    key: 'lineTolerance',
    kind: 'number',
    label: 'Line tolerance',
    min: 0,
    step: 1,
    help: 'Line-grouping tolerance in pixels; 0 derives it from character height.',
}

/**
 * `SignatureDetector` and `FaceDetector` are `YoloOnnxDetector` with different
 * pre-set params (`src/detect/index.ts`), so they take the same parameters.
 *
 * One caveat those two carry: they spread their options straight into `super`
 * rather than going through `resolveParams`, so their validators never run --
 * an empty `model` is accepted there and fails later, at init.
 */
const yoloParams: readonly StageParamSpec[] = Object.freeze([
    ...baseParams({ input: { accepts: ['image'] } }),
    {
        key: 'model',
        kind: 'string',
        label: 'Model',
        required: true,
        help: 'Hugging Face repo id, or a URL when self-hosting. No default.',
    },
    {
        key: 'labels',
        kind: 'stringList',
        label: 'Labels',
        help: 'Class index → label. Empty falls back to class_<n>.',
    },
    scoreThreshold('Drop detections below this confidence.'),
    {
        key: 'iouThreshold',
        kind: 'number',
        label: 'IoU threshold',
        min: 0,
        max: 1,
        step: 0.05,
        help: 'Overlap above which two same-class boxes count as duplicates.',
    },
    {
        key: 'padding',
        kind: 'number',
        label: 'Padding',
        min: 0,
        max: 1,
        step: 0.01,
        help: 'Grow each box by this fraction of its size, to avoid clipping edges.',
    },
    {
        key: 'outputType',
        kind: 'string',
        label: 'Output type',
        advanced: true,
        help: 'Recorded as DetectorOutput.type.',
    },
])

/* ── The catalogue ───────────────────────────────────────────────────────── */

export const STAGE_SPECS: readonly StageSpec[] = Object.freeze([
    {
        type: 'DataToImage',
        label: 'Image bytes',
        group: 'Read',
        subpath: '@stabrise/scaledp',
        summary: 'Wrap raw image bytes as an Image without re-encoding them.',
        consumes: ['bytes'],
        produces: 'image',
        defaults: asRecord(DATA_TO_IMAGE_DEFAULTS),
        params: [
            ...baseParams({ input: { help: 'Raw file bytes, normally the content column.' } }),
            { ...imageType, help: 'Encoding recorded on the output; the bytes pass through unchanged.' },
            {
                key: 'resolution',
                kind: 'number',
                label: 'Resolution',
                min: 0,
                step: 1,
                help: 'DPI to record when the row carries no resolution field. 0 leaves it unknown.',
            },
        ],
    },
    {
        type: 'PdfToImage',
        label: 'PDF pages',
        group: 'Read',
        subpath: '@stabrise/scaledp/pdf',
        summary: 'Rasterise every page of a PDF, one output row per page.',
        consumes: ['bytes'],
        produces: 'image',
        peer: 'pdfjs-dist',
        expands: true,
        defaults: asRecord(PDF_TO_IMAGE_DEFAULTS),
        params: [
            ...baseParams({ input: { help: 'Raw PDF bytes, normally the content column.' } }),
            {
                key: 'resolution',
                kind: 'number',
                label: 'Resolution (DPI)',
                min: 36,
                max: 600,
                step: 1,
                help: 'Render DPI. 300 matches ScaleDP; 200 is a good speed/accuracy trade.',
            },
            {
                key: 'pageLimit',
                kind: 'number',
                label: 'Page limit',
                min: 0,
                step: 1,
                help: '0 renders every page.',
            },
            imageType,
        ],
    },
    {
        type: 'PdfToDocument',
        label: 'PDF text layer',
        group: 'Read',
        subpath: '@stabrise/scaledp/pdf',
        summary: 'Read a PDF’s embedded text layer, skipping OCR entirely.',
        consumes: ['bytes'],
        produces: 'document',
        peer: 'pdfjs-dist',
        expands: true,
        defaults: asRecord(PDF_TO_DOCUMENT_DEFAULTS),
        params: [
            ...baseParams({ input: { help: 'Raw PDF bytes, normally the content column.' } }),
            {
                key: 'resolution',
                kind: 'number',
                label: 'Resolution (DPI)',
                min: 36,
                max: 600,
                step: 1,
                help: 'Pixel space the boxes are expressed in. Match PdfToImage to align them.',
            },
            {
                key: 'pageLimit',
                kind: 'number',
                label: 'Page limit',
                min: 0,
                step: 1,
                help: '0 reads every page.',
            },
            {
                key: 'splitWords',
                kind: 'boolean',
                label: 'Split words',
                help: 'Split pdf.js line runs into word boxes. Off yields run-level boxes.',
            },
        ],
    },
    {
        type: 'PaddleTextDetector',
        label: 'PaddleOCR detector',
        group: 'Detect',
        subpath: '@stabrise/scaledp/ocr',
        summary: 'Find text regions with the detection half of a PaddleOCR preset. Regions are line-level.',
        consumes: ['image'],
        produces: 'boxes',
        peer: 'ppu-paddle-ocr',
        cache: { kind: 'paddle-preset', param: 'preset' },
        defaults: asRecord(PADDLE_DETECTOR_DEFAULTS),
        params: [
            ...baseParams({ input: { accepts: ['image'] } }),
            {
                key: 'preset',
                kind: 'enum',
                label: 'Preset',
                options: OCR_PRESETS,
                help: 'Language/script pairing. Detection and recognition share the download.',
            },
            scoreThreshold('Drop regions below this confidence. 0 keeps everything.'),
        ],
    },
    {
        type: 'DbnetOnnxDetector',
        label: 'DBNet detector',
        group: 'Detect',
        subpath: '@stabrise/scaledp/ocr',
        summary:
            'The DBNet ONNX detector ScaleDP uses server-side. Finds rotated regions, one box per text line.',
        consumes: ['image'],
        produces: 'boxes',
        peer: 'onnxruntime-web',
        cache: { kind: 'hf-repo', param: 'model', approxBytes: 4_800_000 },
        defaults: asRecord(DBNET_DETECTOR_DEFAULTS),
        params: [
            ...baseParams({ input: { accepts: ['image'] } }),
            {
                key: 'model',
                kind: 'enum',
                label: 'Model',
                options: DBNET_MODEL_OPTIONS,
                allowCustom: true,
                help: 'Hugging Face repo id, or a URL when self-hosting.',
            },
            scoreThreshold('Mean in-box probability a candidate must reach.'),
            {
                key: 'binaryThreshold',
                kind: 'number',
                label: 'Binary threshold',
                min: 0,
                max: 1,
                step: 0.05,
                help: 'Probability above which a pixel counts as text.',
            },
            {
                key: 'unclipRatio',
                kind: 'number',
                label: 'Unclip ratio',
                min: 0.5,
                max: 5,
                step: 0.1,
                help: 'How far to grow each box; DB shrinks text regions during training.',
            },
            {
                key: 'mergeBoxes',
                kind: 'boolean',
                label: 'Merge boxes',
                help: 'Merge overlapping boxes that share a line. Usually changes nothing here — this model already returns one region per line, so no two boxes overlap.',
            },
        ],
    },
    {
        type: 'YoloOnnxDetector',
        label: 'YOLO detector',
        group: 'Detect',
        subpath: '@stabrise/scaledp/detect',
        summary: 'Detect arbitrary objects with a YOLO ONNX model.',
        consumes: ['image'],
        produces: 'boxes',
        peer: 'onnxruntime-web',
        cache: { kind: 'hf-repo', param: 'model' },
        defaults: asRecord(YOLO_DETECTOR_DEFAULTS),
        params: yoloParams,
    },
    {
        type: 'SignatureDetector',
        label: 'Signature detector',
        group: 'Detect',
        subpath: '@stabrise/scaledp/detect',
        summary: 'YOLO pre-set for StabRise/signature_detection.',
        consumes: ['image'],
        produces: 'boxes',
        peer: 'onnxruntime-web',
        cache: { kind: 'hf-repo', param: 'model' },
        defaults: asRecord({
            ...YOLO_DETECTOR_DEFAULTS,
            model: 'StabRise/signature_detection',
            labels: ['signature'],
            outputCol: 'signatures',
            outputType: 'signature',
            scoreThreshold: 0.2,
        }),
        params: yoloParams,
    },
    {
        type: 'FaceDetector',
        label: 'Face detector',
        group: 'Detect',
        subpath: '@stabrise/scaledp/detect',
        summary: 'YOLO pre-set for StabRise/face_detection.',
        consumes: ['image'],
        produces: 'boxes',
        peer: 'onnxruntime-web',
        cache: { kind: 'hf-repo', param: 'model' },
        defaults: asRecord({
            ...YOLO_DETECTOR_DEFAULTS,
            model: 'StabRise/face_detection',
            labels: ['face'],
            outputCol: 'faces',
            outputType: 'face',
            scoreThreshold: 0.2,
        }),
        params: yoloParams,
    },
    {
        type: 'LineOrientationDetector',
        label: 'Line orientation',
        group: 'Transform',
        subpath: '@stabrise/scaledp/ocr',
        summary: 'Classify each detected region 0°/180° and turn the inverted ones.',
        consumes: ['image', 'boxes'],
        produces: 'image',
        alsoProduces: [{ param: 'orientationCol', kind: 'orientations' }],
        peer: 'onnxruntime-web',
        cache: { kind: 'hf-repo', param: 'model', approxBytes: 9_000_000 },
        expands: true,
        defaults: asRecord(LINE_ORIENTATION_DEFAULTS),
        params: [
            ...baseParams({
                input: 'unused',
                output: { help: 'The corrected page image.' },
            }),
            {
                key: 'inputCols',
                kind: 'columns',
                label: 'Input columns',
                arity: 2,
                accepts: ['image', 'boxes'],
                help: 'The page image, then the detector output whose regions to classify.',
            },
            column('orientationCol', 'Orientation column', {
                help: 'Per-region 0_degree / 180_degree labels.',
            }),
            {
                key: 'model',
                kind: 'string',
                label: 'Model',
                help: `Hugging Face repo id. Defaults to ${DEFAULT_ORIENTATION_MODEL}.`,
            },
            {
                key: 'correct',
                kind: 'boolean',
                label: 'Correct',
                help: 'Turn the inverted regions. Off classifies only, leaving the page as-is.',
            },
            {
                key: 'onlyRotated',
                kind: 'boolean',
                label: 'Only rotated',
                help: 'Classify only already-rotated boxes, where the signal is. Off also catches upside-down horizontal text, at a false-positive cost.',
            },
            {
                key: 'padding',
                kind: 'number',
                label: 'Padding',
                min: 0,
                step: 1,
                help: 'Grow each box before cropping, so glyph edges are not clipped.',
            },
            imageType,
        ],
    },
    {
        type: 'PaddleTextRecognizer',
        label: 'PaddleOCR',
        group: 'Recognise',
        subpath: '@stabrise/scaledp/ocr',
        summary: 'Detect and read a page in one pass. Ignores any separate detector’s boxes.',
        consumes: ['image'],
        produces: 'document',
        peer: 'ppu-paddle-ocr',
        cache: { kind: 'paddle-preset', param: 'preset' },
        defaults: asRecord(PADDLE_RECOGNIZER_DEFAULTS),
        params: [
            ...baseParams({ input: { accepts: ['image'] } }),
            {
                key: 'preset',
                kind: 'enum',
                label: 'Preset',
                options: OCR_PRESETS,
                help: 'Language/script pairing. Pick the one matching your documents.',
            },
            scoreThreshold('Drop words below this confidence.'),
            {
                key: 'strategy',
                kind: 'enum',
                label: 'Strategy',
                help: 'How the detected regions are grouped. It cannot subdivide them: the boxes are whatever the preset’s detector found, which is line-level.',
                options: STRATEGIES,
            },
            keepFormatting,
            lineTolerance,
        ],
    },
    {
        type: 'TesseractOcr',
        label: 'Tesseract',
        group: 'Recognise',
        subpath: '@stabrise/scaledp/ocr',
        summary:
            'Read a whole page with Tesseract, detecting layout itself. The one stage here that returns word-level boxes.',
        consumes: ['image'],
        produces: 'document',
        peer: 'tesseract-wasm',
        defaults: asRecord(TESSERACT_OCR_DEFAULTS),
        params: [
            ...baseParams({ input: { accepts: ['image'] } }),
            lang,
            scoreThreshold('Drop words below this confidence.'),
            keepFormatting,
            lineTolerance,
        ],
    },
    {
        type: 'TesseractRecognizer',
        label: 'Tesseract on boxes',
        group: 'Recognise',
        subpath: '@stabrise/scaledp/ocr',
        summary:
            'Read exactly the regions a detector found, cropping and turning each one. Returns a box per region, or per word with “Box level”.',
        consumes: ['image', 'boxes'],
        produces: 'document',
        peer: 'tesseract-wasm',
        cache: { kind: 'hf-repo', param: 'oriModel', approxBytes: 9_000_000 },
        defaults: asRecord(TESSERACT_RECOGNIZER_DEFAULTS),
        params: [
            ...baseParams({ input: 'unused' }),
            {
                key: 'inputCols',
                kind: 'columns',
                label: 'Input columns',
                arity: 2,
                accepts: ['image', 'boxes'],
                help: 'The page image, then the detector output whose regions to read.',
            },
            lang,
            {
                key: 'boxLevel',
                kind: 'enum',
                label: 'Box level',
                options: [
                    {
                        value: 'region',
                        label: 'One box per region',
                        title: 'ScaleDP’s behaviour: each detected region keeps its own box, carrying everything read inside it',
                    },
                    {
                        value: 'word',
                        label: 'One box per word',
                        title: 'Tesseract’s own word boxes, mapped back into page coordinates',
                    },
                ],
                help: 'The detectors here are line-level, so “region” gives line boxes. Pick “word” to get one box per word instead.',
            },
            {
                key: 'scaleFactor',
                kind: 'number',
                label: 'Scale factor',
                min: 0.1,
                max: 8,
                step: 0.1,
                help: 'Resize the page by this factor before cropping.',
            },
            {
                key: 'padding',
                kind: 'number',
                label: 'Padding',
                min: 0,
                step: 1,
                help: 'Grow each box before cropping. ScaleDP hardcodes 5.',
            },
            scoreThreshold('Drop words below this confidence.'),
            keepFormatting,
            lineTolerance,
            {
                key: 'detectLineOrientation',
                kind: 'boolean',
                label: 'Detect line orientation',
                help: 'Classify each crop 0°/180° and turn the inverted ones.',
            },
            {
                key: 'onlyRotated',
                kind: 'boolean',
                label: 'Only rotated',
                help: 'Read only rotated or inverted boxes. On, an ordinary page returns nothing.',
            },
            {
                key: 'oriModel',
                kind: 'string',
                label: 'Orientation model',
                advanced: true,
                help: `Hugging Face repo id. Defaults to ${DEFAULT_ORIENTATION_MODEL}.`,
            },
        ],
    },
    {
        type: 'GlinerNer',
        label: 'GLiNER entities',
        group: 'Understand',
        subpath: '@stabrise/scaledp/ner',
        summary: 'Find named entities in a document, scored against labels you write.',
        consumes: ['document'],
        produces: 'ner',
        peer: '@huggingface/transformers',
        cache: { kind: 'ner-id', param: 'model' },
        defaults: asRecord(GLINER_NER_DEFAULTS),
        params: [
            ...baseParams({ input: { accepts: ['document'] } }),
            {
                key: 'model',
                kind: 'enum',
                label: 'Model',
                options: NER_MODEL_OPTIONS,
                help: 'Registry id. Private repos need configure({ auth }).',
            },
            {
                key: 'labels',
                kind: 'stringList',
                label: 'Labels',
                required: true,
                help: 'GLiNER scores a label by its prompt text, so other wording asks a different question.',
            },
            {
                key: 'threshold',
                kind: 'number',
                label: 'Threshold',
                min: 0,
                max: 1,
                step: 0.05,
                help: 'Minimum score an entity must reach.',
            },
            {
                key: 'whiteList',
                kind: 'stringList',
                label: 'Only these groups',
                help: 'Keep only these entity groups; empty keeps everything.',
            },
            {
                key: 'chunkLength',
                kind: 'number',
                label: 'Chunk length',
                min: 1,
                step: 1,
                advanced: true,
                help: 'Tokens per inference window.',
            },
            {
                key: 'chunkStride',
                kind: 'number',
                label: 'Chunk stride',
                min: 1,
                step: 1,
                advanced: true,
                help: 'Window step. Below chunk length, windows overlap.',
            },
            {
                key: 'normaliseCasing',
                kind: 'boolean',
                label: 'Normalise casing',
                help: 'Title-case runs of capitals first. GLiNER1 models are cased; scans are often all caps.',
            },
        ],
    },
    {
        type: 'ImageDrawBoxes',
        label: 'Draw boxes',
        group: 'Transform',
        subpath: '@stabrise/scaledp',
        summary: 'Annotate a page with any boxes or entities found so far.',
        consumes: ['image', 'boxes'],
        produces: 'image',
        terminal: true,
        defaults: asRecord(IMAGE_DRAW_BOXES_DEFAULTS),
        params: [
            ...baseParams({ input: 'unused' }),
            {
                key: 'inputCols',
                kind: 'columns',
                label: 'Input columns',
                minArity: 2,
                accepts: ['image', 'boxes'],
                help: 'The image first, then one or more box, document or entity columns.',
            },
            {
                key: 'color',
                kind: 'color',
                label: 'Colour',
                help: 'One colour for every box. Unset colours by group instead.',
            },
            {
                key: 'filled',
                kind: 'boolean',
                label: 'Filled',
                help: 'Fill boxes as well as outlining them.',
            },
            { key: 'lineWidth', kind: 'number', label: 'Line width', min: 0, max: 20, step: 1 },
            { key: 'textSize', kind: 'number', label: 'Text size', min: 4, max: 72, step: 1 },
            {
                key: 'displayDataList',
                kind: 'stringList',
                label: 'Label fields',
                options: LABEL_FIELDS,
                help: 'Rendered above each box, joined by ":". Pick "text" to read the OCR output back off the page.',
            },
            {
                key: 'padding',
                kind: 'number',
                label: 'Padding',
                min: 0,
                step: 1,
                help: 'Grow each box by this many pixels before drawing.',
            },
            {
                key: 'whiteList',
                kind: 'stringList',
                label: 'Only these groups',
                help: 'Draw only these entity groups; empty draws all.',
            },
            {
                key: 'blackList',
                kind: 'stringList',
                label: 'Never these groups',
                help: 'Never draw these entity groups.',
            },
            imageType,
        ],
    },
    {
        type: 'ImageCropBoxes',
        label: 'Crop boxes',
        group: 'Transform',
        subpath: '@stabrise/scaledp',
        summary: 'Cut each detected region out of the page, one output row per crop.',
        consumes: ['image', 'boxes'],
        produces: 'image',
        alsoProduces: [{ param: 'boxCol', kind: 'box' }],
        expands: true,
        defaults: asRecord(IMAGE_CROP_BOXES_DEFAULTS),
        params: [
            ...baseParams({ input: 'unused' }),
            {
                key: 'inputCols',
                kind: 'columns',
                label: 'Input columns',
                arity: 2,
                accepts: ['image', 'boxes'],
                help: 'The page image, then the box column to cut from it.',
            },
            column('boxCol', 'Box column', { help: 'Where each crop’s source box is written.' }),
            {
                key: 'padding',
                kind: 'number',
                label: 'Padding',
                min: 0,
                step: 1,
                help: 'Grow each box by this many pixels before cropping.',
            },
            {
                key: 'limit',
                kind: 'number',
                label: 'Limit',
                min: 0,
                step: 1,
                help: 'Maximum crops per page; 0 means all of them.',
            },
            {
                key: 'autoRotate',
                kind: 'boolean',
                label: 'Auto-rotate',
                help: 'Turn portrait crops a quarter turn, so text reads horizontally.',
            },
            {
                key: 'returnEmpty',
                kind: 'boolean',
                label: 'Return empty',
                help: 'Emit the whole page when nothing was detected, instead of failing.',
            },
            imageType,
        ],
    },
])

/** Name → constructor, for building a stage from a `StageDescriptor`. */
export const STAGE_CLASSES = Object.freeze({
    DataToImage,
    DbnetOnnxDetector,
    FaceDetector,
    GlinerNer,
    ImageCropBoxes,
    ImageDrawBoxes,
    LineOrientationDetector,
    PaddleTextDetector,
    PaddleTextRecognizer,
    PdfToDocument,
    PdfToImage,
    SignatureDetector,
    TesseractOcr,
    TesseractRecognizer,
    YoloOnnxDetector,
}) as Readonly<Record<string, new (options?: never) => import('../core/pipeline.js').Stage>>
