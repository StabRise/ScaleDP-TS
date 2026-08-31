/**
 * Read the boxes a detector already found, with a PaddleOCR preset.
 *
 * The Paddle counterpart to `TesseractRecognizer`, and for the same reason:
 * `PaddleTextRecognizer` detects and recognises in a single pass over the page,
 * so boxes produced by a *separate* detector never reach it. This stage takes
 * those boxes, straightens each one, and reads it -- which is what lets DBNet or
 * YOLO feed PaddleOCR recognition, rotated regions included.
 *
 * There is no `strategy` parameter. ppu's 'per-line' and 'cross-line' merge
 * boxes before reading them; the contract here is one result per box handed in,
 * which only 'per-box' can honour.
 */

import { OcrError } from '../core/errors.js'
import { decodeImage } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import type { Box } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { DEFAULT_ORIENTATION_MODEL, LineOrientationClassifier } from './line-orientation.js'
import { getPaddleRecognizer } from './paddle-service.js'
import { readRegions } from './paddle-words.js'
import { DEFAULT_OCR_PRESET, presetForRow, validatePreset } from './presets.js'

export interface PaddleRecognizerParams extends BaseStageParams {
    /** [imageColumn, boxColumn]. */
    inputCols: string[]
    /** Language/script preset. See PADDLE_OCR_PRESETS. */
    preset: string
    /**
     * Column naming the preset to use for *this row*, overriding `preset`.
     *
     * Empty by default, which pins the model to `preset`. Point it at a
     * `TesseractScriptDetector` column and the model follows the page, which is
     * the only way a mixed-script document gets the right recogniser on every
     * page. Anything the column cannot answer falls back to `preset`.
     */
    presetCol: string
    /** Resize the page by this factor before cropping. */
    scaleFactor: number
    /** Grow each box before cropping. ScaleDP hardcodes 5. */
    padding: number
    /** Drop regions below this confidence (0-1). */
    scoreThreshold: number
    /** Rebuild the original layout with spaces and blank lines. */
    keepFormatting: boolean
    /** Line-grouping tolerance in pixels; 0 derives it from character height. */
    lineTolerance: number
    /**
     * Classify each crop 0/180 degrees and turn the inverted ones.
     *
     * Off by default, unlike `TesseractRecognizer`. Paddle already turns a crop
     * that is markedly taller than wide, so only the 180 degree flip is missing
     * -- and catching it costs a separate ~9 MB model an ordinary page never
     * needs. Turn it on for scans that come in upside down.
     */
    detectLineOrientation: boolean
    /** Recognize only boxes that are rotated or came back inverted. */
    onlyRotated: boolean
    oriModel: string
    /**
     * Insert a space wherever the space class scores above 0.001.
     *
     * Off, and worth leaving off. It is not what puts spaces between words:
     * ppu already does that unconditionally from the *geometry* of the decode,
     * spacing characters against the median inter-character gap. This is a
     * second, far cruder pass on top, and 0.001 is a threshold nearly every
     * timestep clears on anything but pristine input -- so a small or noisy
     * line comes back as `s e n s i t i v e`.
     *
     * It can recover a genuinely collapsed word gap on clean, large text. That
     * is the only case it is for.
     */
    spaceRecovery: boolean
    /** Crops per batched inference. 1 disables batching. */
    recBatchSize: number
    /**
     * Granularity of the boxes returned.
     *
     * 'word' is the default, so the boxes bracket words the way
     * `TesseractRecognizer` does. PaddleOCR returns one string per crop with no
     * geometry inside it, so the words are recovered by splitting the region's
     * *reading* -- see `paddle-words.ts` for why that beats cutting first.
     *
     * 'region' keeps one box per region the detector found, carrying everything
     * read inside it. The recognition is identical either way; this chooses only
     * how finely the result is cut up, and 'region' is the only sensible choice
     * for a script that does not separate words with spaces.
     */
    boxLevel: 'region' | 'word'
    /**
     * How wide a blank column run must be, relative to the crop's height, to
     * count as a space rather than a gap between letters.
     *
     * Measured across 18-64px text, letter gaps stay under 0.1 of the crop's
     * height while word spaces land at 0.20-0.23, so the two separate cleanly
     * and 0.15 sits in the middle of the window at every size. Raise it if
     * words are being cut in half, lower it if spaces are being missed.
     */
    wordGapRatio: number
}

export const PADDLE_RECOGNIZER_DEFAULTS: PaddleRecognizerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    outputCol: 'text',
    keepInputData: true,
    preset: DEFAULT_OCR_PRESET,
    presetCol: '',
    scaleFactor: 1,
    padding: 5,
    scoreThreshold: 0.5,
    keepFormatting: false,
    lineTolerance: 0,
    detectLineOrientation: false,
    onlyRotated: false,
    oriModel: DEFAULT_ORIENTATION_MODEL,
    spaceRecovery: false,
    recBatchSize: 6,
    boxLevel: 'word' as 'region' | 'word',
    wordGapRatio: 0.15,
})

/**
 * Tallest sheet crops are stacked onto.
 *
 * Well under every browser's canvas ceiling, and low enough that a sheet stays
 * cheap to allocate. A single crop taller than this gets a sheet to itself.
 */
function boxesOf(source: unknown): Box[] {
    if (typeof source !== 'object' || source === null) return []
    return (source as DetectorOutput).bboxes ?? []
}

export class PaddleRecognizer extends Stage<PaddleRecognizerParams> {
    readonly name = 'PaddleRecognizer'

    private orientation: LineOrientationClassifier | null = null

    constructor(options: Partial<PaddleRecognizerParams> = {}) {
        super(
            resolveParams(PADDLE_RECOGNIZER_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) {
                        throw new RangeError('inputCols must be [imageColumn, boxColumn]')
                    }
                },
                preset: validatePreset,
            })
        )
    }

    override async init(): Promise<void> {
        const { preset, recBatchSize, spaceRecovery, detectLineOrientation, oriModel } = this.params
        // Warms the configured preset. When `presetCol` overrides it per row,
        // `apply` asks for that one instead. Nothing is held on the instance:
        // paddle-service caches a session per preset, so asking again is a map
        // lookup, and holding one here would only pin the wrong model once the
        // column starts choosing.
        await getPaddleRecognizer(preset, { recBatchSize, spaceRecovery })
        if (detectLineOrientation) {
            this.orientation ??= new LineOrientationClassifier(oriModel)
        }
    }

    protected async apply(_input: unknown, row: Row, ctx: StageContext): Promise<Document> {
        const {
            inputCols,
            scaleFactor,
            padding,
            scoreThreshold,
            keepFormatting,
            lineTolerance,
            detectLineOrientation,
            onlyRotated,
            boxLevel,
            wordGapRatio,
        } = this.params
        const [imageCol, boxCol] = inputCols as [string, string]
        const image = row[imageCol] as ScaleDpImage | undefined

        // Check `exception` first. A failed upstream stage returns a well-formed
        // but empty Image, so testing the bytes first would report "no decoded
        // bytes" and bury the real cause.
        if (image?.exception) {
            throw new OcrError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new OcrError('Expected an Image with decoded bytes', this.name)
        }

        const source = row[boxCol]
        if (source === undefined) {
            throw new OcrError(
                `No boxes in column "${boxCol}". This stage reads a detector's output; ` +
                    'run a text detector before it.',
                this.name
            )
        }

        await this.init()
        const { preset, presetCol, recBatchSize, spaceRecovery } = this.params
        const recognition = await getPaddleRecognizer(presetForRow(row, presetCol, preset), {
            recBatchSize,
            spaceRecovery,
        })
        const bitmap = await decodeImage(image.data)

        let bboxes: Box[]
        try {
            bboxes = await readRegions(
                recognition,
                bitmap,
                boxesOf(source),
                {
                    scaleFactor,
                    padding,
                    boxLevel,
                    wordGapRatio,
                    orientation: detectLineOrientation ? this.orientation : null,
                    onlyRotated,
                },
                ctx
            )
        } finally {
            bitmap.close()
        }
        bboxes = bboxes.filter((box) => box.score >= scoreThreshold)

        return createDocument({
            path: String(row[this.params.pathCol] ?? image.path),
            type: 'paddle-recognizer',
            text: keepFormatting ? boxesToFormattedText(bboxes, lineTolerance) : boxesToText(bboxes),
            bboxes,
        })
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'paddle-recognizer',
            exception: message,
        })
    }

    override async dispose(): Promise<void> {
        await this.orientation?.dispose()
        this.orientation = null
        // The recognition sessions are shared per preset and owned by
        // paddle-service; `disposePaddleServices()` is what releases them.
    }
}
