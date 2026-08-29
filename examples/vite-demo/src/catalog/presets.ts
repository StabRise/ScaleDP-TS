/**
 * Pipelines worth starting from.
 *
 * These are the three shapes the old demo could produce through its five fixed
 * controls, now written out as data. They are read-only; "Save as" copies one
 * into the saved list.
 *
 * The colours match --detect and --entity in style.css. Boxes are drawn by
 * chained ImageDrawBoxes passes rather than one, because a single stage takes
 * one colour for all its sources -- so the page speaks the same false-colour
 * language as the interface: cyan for what was found, violet for a second
 * detector's view of it, magenta for what was understood.
 */

export const BOX_COLOR = '#3fc9f5'
export const ENTITY_COLOR = '#ff5c8a'
export const DETECT_COLOR = '#9d8cff'

export interface BuiltinPreset {
    id: string
    name: string
    summary: string
    stages: { type: string; options: Record<string, unknown> }[]
}

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    {
        id: 'builtin:read',
        name: 'Read a page',
        summary: 'PaddleOCR detects and reads in one pass, then the boxes are drawn on the page.',
        stages: [
            { type: 'PdfToImage', options: { resolution: 200 } },
            { type: 'PaddleTextRecognizer', options: { keepFormatting: true } },
            {
                type: 'ImageDrawBoxes',
                options: {
                    inputCols: ['image', 'text'],
                    outputCol: 'annotated',
                    color: BOX_COLOR,
                    lineWidth: 2,
                },
            },
        ],
    },
    {
        id: 'builtin:detect-then-read',
        name: 'Detect, then read',
        summary:
            'DBNet finds the regions, upside-down ones are turned, and Tesseract reads exactly those boxes. The path a rotated scan needs.',
        stages: [
            { type: 'PdfToImage', options: { resolution: 200 } },
            { type: 'DbnetOnnxDetector', options: { outputCol: 'detected' } },
            {
                type: 'LineOrientationDetector',
                options: { inputCols: ['image', 'detected'], onlyRotated: false },
            },
            {
                type: 'TesseractRecognizer',
                options: { inputCols: ['oriented', 'detected'], keepFormatting: true },
            },
            {
                type: 'ImageDrawBoxes',
                options: {
                    inputCols: ['oriented', 'text'],
                    outputCol: 'annotated',
                    color: BOX_COLOR,
                    lineWidth: 2,
                },
            },
            {
                type: 'ImageDrawBoxes',
                options: {
                    inputCols: ['annotated', 'detected'],
                    outputCol: 'annotated',
                    color: DETECT_COLOR,
                    lineWidth: 2,
                    padding: 3,
                },
            },
        ],
    },
    {
        id: 'builtin:pii',
        name: 'Find PII',
        summary: 'Read the page, then score it against GLiNER labels and outline what was understood.',
        stages: [
            { type: 'PdfToImage', options: { resolution: 200 } },
            { type: 'PaddleTextRecognizer', options: { keepFormatting: true } },
            { type: 'GlinerNer', options: {} },
            {
                type: 'ImageDrawBoxes',
                options: {
                    inputCols: ['image', 'text'],
                    outputCol: 'annotated',
                    color: BOX_COLOR,
                    lineWidth: 2,
                },
            },
            {
                type: 'ImageDrawBoxes',
                options: {
                    inputCols: ['annotated', 'ner'],
                    outputCol: 'annotated',
                    color: ENTITY_COLOR,
                    lineWidth: 3,
                    padding: 2,
                    displayDataList: ['entity_group'],
                },
            },
        ],
    },
]

export const DEFAULT_PRESET_ID = 'builtin:read'
