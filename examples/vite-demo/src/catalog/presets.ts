/**
 * Pipelines worth starting from.
 *
 * Two engines, each on its own and again behind a separate detector, and each
 * again going on to understand what it read. Between them they cover every
 * shape the builder can produce: read a page whole, read exactly the regions
 * someone else found, or read and then score the text. They are read-only;
 * "Save as" copies one into the saved list.
 *
 * Detection boxes are drawn in --detect from style.css, so the page speaks the
 * same false-colour language as the interface: cyan for what was found. Entity
 * boxes leave `color` unset instead, which gives each entity group its own
 * colour -- the same one `visualizeNer` gives it in the text beside the image,
 * because both call `colorForGroup`. One colour for every group would answer
 * "is this sensitive" but not "sensitive how", which is the question a page of
 * mixed PII actually raises.
 *
 * Where detections and entities both appear the boxes are drawn by chained
 * ImageDrawBoxes passes rather than one, because a single stage takes one
 * colour for all its sources.
 */

export const BOX_COLOR = '#3fc9f5'

export interface BuiltinPreset {
    id: string
    name: string
    summary: string
    stages: { type: string; options: Record<string, unknown> }[]
}

/**
 * The steps presets share, built fresh each time they are used.
 *
 * Functions rather than shared constants on purpose: loading a preset copies a
 * stage's options one level deep, so a nested value like `inputCols` would
 * otherwise be the *same array* in every preset here. Nothing mutates one today
 * -- setParam replaces values rather than editing them -- but a single in-place
 * edit somewhere would quietly rewrite all five.
 */
const drawText = () => ({
    type: 'ImageDrawBoxes',
    options: {
        inputCols: ['image', 'text'],
        outputCol: 'annotated',
        color: BOX_COLOR,
        lineWidth: 2,
    },
})

/**
 * The entity pass only.
 *
 * Drawing the text boxes underneath as well would put a cyan box round every
 * word on the page, which is the one thing a PII pipeline is not asking about.
 */
const drawEntities = () => ({
    type: 'ImageDrawBoxes',
    options: {
        inputCols: ['image', 'ner'],
        outputCol: 'annotated',
        // Unset: one colour per entity group, and the same colours the
        // entities-in-context text uses, so the two read as one result rather
        // than two.
        color: null,
        lineWidth: 3,
        padding: 2,
        displayDataList: ['entity_group'],
    },
})

const pdfToImage = () => ({ type: 'PdfToImage', options: { resolution: 200 } })

/**
 * OSD, writing the `script` column the script-aware preset reads its model from.
 *
 * Tesseract takes a `lang`, so its presets already state what they expect to
 * read. A Paddle preset does not: `v6-small` covers Latin and CJK and silently
 * returns plausible Latin nonsense for anything else, with nothing downstream
 * able to tell it went wrong.
 */
const scriptDetector = () => ({ type: 'TesseractScriptDetector', options: {} })

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    {
        id: 'builtin:tesseract',
        name: 'Tesseract OCR',
        summary:
            'Tesseract reads the whole page, finding the layout itself. The one engine here that returns a box per word.',
        stages: [pdfToImage(), { type: 'TesseractOcr', options: { keepFormatting: true } }, drawText()],
    },
    {
        id: 'builtin:paddle',
        name: 'Paddle OCR',
        summary:
            'PaddleOCR detects and reads in a single pass. Faster than Tesseract on a dense page, and the boxes are line-level.',
        stages: [
            pdfToImage(),
            { type: 'PaddleTextRecognizer', options: { keepFormatting: true } },
            drawText(),
        ],
    },
    {
        id: 'builtin:paddle-auto-script',
        name: 'Paddle OCR (model from the page)',
        summary:
            'OSD reads the page’s script first and PP-OCR takes its model from that column, per page. The pipeline for documents whose language you do not know in advance, or that change language partway through.',
        stages: [
            pdfToImage(),
            scriptDetector(),
            {
                type: 'PaddleTextRecognizer',
                options: {
                    keepFormatting: true,
                    // The whole point of this preset: the model follows the
                    // page rather than being pinned here. `preset` stays as the
                    // fallback for pages OSD cannot classify.
                    presetCol: 'script',
                },
            },
            drawText(),
        ],
    },
    {
        id: 'builtin:tesseract-detect',
        name: 'Tesseract OCR with Text Detection',
        summary:
            'DBNet finds the regions and Tesseract reads exactly those boxes, turning any that are upside down. The path a rotated scan needs.',
        stages: [
            pdfToImage(),
            { type: 'DbnetOnnxDetector', options: { outputCol: 'detected' } },
            // No LineOrientationDetector: the recognizer classifies each crop
            // itself -- `detectLineOrientation` is on by default -- so a
            // separate pass would run the same model twice. The standalone
            // stage is for putting in front of a recognizer that has no such
            // seam, which is PaddleTextRecognizer.
            {
                type: 'TesseractRecognizer',
                options: { inputCols: ['image', 'detected'], keepFormatting: true },
            },
            drawText(),
        ],
    },
    {
        id: 'builtin:paddle-detect',
        name: 'Paddle OCR with Text Detection',
        summary:
            'The same shape with PP-OCR reading. Only the recognition model is downloaded, so it is the lighter half of a preset.',
        stages: [
            pdfToImage(),
            { type: 'DbnetOnnxDetector', options: { outputCol: 'detected' } },
            {
                type: 'PaddleRecognizer',
                options: {
                    inputCols: ['image', 'detected'],
                    keepFormatting: true,
                    // On here, though the stage defaults it off: PaddleOCR turns
                    // a crop taller than it is wide by itself but never a line
                    // that is merely upside down, and this preset exists for
                    // exactly the scans where that happens. The cost is the same
                    // ~9 MB model the Tesseract preset above already pays for.
                    detectLineOrientation: true,
                },
            },
            drawText(),
        ],
    },
    {
        id: 'builtin:pii-tesseract',
        name: 'PII Detection with Tesseract OCR',
        summary:
            'DBNet finds the regions, Tesseract reads them, then GLiNER scores the text against its labels. Only what was understood is outlined.',
        stages: [
            pdfToImage(),
            { type: 'DbnetOnnxDetector', options: { outputCol: 'detected' } },
            {
                type: 'TesseractRecognizer',
                options: { inputCols: ['image', 'detected'], keepFormatting: true },
            },
            { type: 'GlinerNer', options: {} },
            // GLiNER scores every mention on its own, so a name it catches in
            // the body is routinely missed in a heading set in caps. This tags
            // the ones it missed.
            { type: 'NerConsistency', options: {} },
            drawEntities(),
        ],
    },
    {
        id: 'builtin:pii-paddle',
        name: 'PII Detection with Paddle OCR',
        summary:
            'DBNet finds the regions, PP-OCR reads them, then GLiNER scores the text against its labels. Only what was understood is outlined.',
        stages: [
            pdfToImage(),
            { type: 'DbnetOnnxDetector', options: { outputCol: 'detected' } },
            {
                type: 'PaddleRecognizer',
                options: {
                    inputCols: ['image', 'detected'],
                    keepFormatting: true,
                    detectLineOrientation: true,
                },
            },
            { type: 'GlinerNer', options: {} },
            { type: 'NerConsistency', options: {} },
            drawEntities(),
        ],
    },
    {
        id: 'builtin:pii-paddle-auto-script',
        name: 'PII Detection with Paddle OCR (model from the page)',
        summary:
            'No separate detector: OSD names the page’s script, PP-OCR detects and reads with the model that matches it, then GLiNER scores the text. The path for a document whose language you do not know in advance.',
        stages: [
            pdfToImage(),
            scriptDetector(),
            {
                type: 'PaddleTextRecognizer',
                options: {
                    keepFormatting: true,
                    // PP-OCR finds its own regions here, so there is no DBNet
                    // pass and nothing to feed it -- the whole pipeline is one
                    // detect-and-read. What the script column changes is *which*
                    // model does it, which is the difference between text and
                    // noise on a page GLiNER then has to score.
                    presetCol: 'script',
                },
            },
            { type: 'GlinerNer', options: {} },
            { type: 'NerConsistency', options: {} },
            drawEntities(),
        ],
    },
]

export const DEFAULT_PRESET_ID = 'builtin:tesseract-detect'
