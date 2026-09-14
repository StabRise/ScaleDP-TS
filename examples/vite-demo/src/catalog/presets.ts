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
 * The resolution every stage of a hybrid preset has to agree on.
 *
 * It is not a render DPI for `PdfToDocument` and `PdfEmbeddedImages` -- it is the
 * pixel space they express their boxes in. Set one of the three differently and
 * the boxes land somewhere else on the page, silently.
 */
const HYBRID_DPI = 200

/**
 * The three readers a hybrid preset starts with.
 *
 * `PdfToDocument` goes first and not only for the text: it keeps `content` and
 * stamps the page index, and every PDF stage after it then reads just that page.
 * Two readers that each exploded the document again would square the row count.
 *
 * `PdfToImage` is here only so there is a page to draw on at the end, and it
 * needs `keepInputData` because it drops `content` by default -- which the stage
 * after it still has to read.
 */
const hybridRead = () => [
    { type: 'PdfToDocument', options: { resolution: HYBRID_DPI } },
    { type: 'PdfToImage', options: { resolution: HYBRID_DPI, keepInputData: true } },
    {
        type: 'PdfEmbeddedImages',
        options: {
            resolution: HYBRID_DPI,
            // Not `image`: that is the page, and the drawing stage at the end
            // needs it. Writing the crops there would leave the boxes drawn over
            // the last embedded picture instead.
            outputCol: 'embedded',
            // placementCol is left at its default, which is the one
            // PdfMergeImageText reads by default too.
        },
    },
]

/**
 * ...and the two stages every one of them ends with.
 *
 * The merge maps each picture's boxes back onto the page through its placement
 * and folds the rows back to one per page. `text-layer-wins` is its default:
 * where a page carries an invisible OCR layer over a scan, the PDF's own words
 * are the exact ones.
 */
const hybridMerge = () => [
    // `collect` is on by default, so the pictures the page was cut into, the
    // regions found in each and what was read all survive the reduction --
    // which is the first thing to check when a reading comes back short.
    { type: 'PdfMergeImageText', options: { keepFormatting: true } },
    {
        type: 'ImageDrawBoxes',
        options: {
            // The merged document, so typed words and scanned words are outlined
            // together -- which is the point of a hybrid preset.
            inputCols: ['image', 'document'],
            outputCol: 'annotated',
            color: BOX_COLOR,
            lineWidth: 2,
        },
    },
]

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
        id: 'builtin:pdf-hybrid',
        name: 'PDF text layer + scanned images',
        summary:
            'Lifts the PDF’s own words and OCRs only the pictures embedded beside them, into one result per page. The pipeline for a page that is part typed and part scanned — a letterhead around a photographed table.',
        stages: [
            ...hybridRead(),
            // An ordinary recognizer on ordinary images -- nothing about this
            // step knows it is looking at the inside of a PDF.
            {
                type: 'PaddleTextRecognizer',
                options: { inputCol: 'embedded', outputCol: 'image_text' },
            },
            ...hybridMerge(),
        ],
    },
    {
        id: 'builtin:pdf-hybrid-detect',
        name: 'PDF text layer + scanned images with Text Detection',
        summary:
            'The same, with DBNet finding the regions inside each embedded picture and PP-OCR reading exactly those. What a scan pasted in askew needs, since the recognizer can turn each region the right way up.',
        stages: [
            ...hybridRead(),
            // Pointed at the extracted picture, not at `image`: the page is only
            // there to be drawn on, and detecting over it again would find the
            // typed text the layer has already read exactly.
            { type: 'DbnetOnnxDetector', options: { inputCol: 'embedded', outputCol: 'detected' } },
            {
                type: 'PaddleRecognizer',
                options: {
                    inputCols: ['embedded', 'detected'],
                    outputCol: 'image_text',
                    // On here, though the stage defaults it off, for the same
                    // reason as the other detection presets: PaddleOCR turns a
                    // crop taller than it is wide by itself but never a line that
                    // is merely upside down, and a pasted-in scan is exactly
                    // where that happens.
                    detectLineOrientation: true,
                },
            },
            ...hybridMerge(),
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
