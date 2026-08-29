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
import { context2d, createCanvas, cropBox, decodeImage, resize, rotate180 } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import { type Box, isRotated } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { DEFAULT_ORIENTATION_MODEL, LineOrientationClassifier } from './line-orientation.js'
import { getPaddleRecognizer, type PaddleRecognitionService } from './paddle-service.js'
import { DEFAULT_OCR_PRESET, validatePreset } from './presets.js'

export interface PaddleRecognizerParams extends BaseStageParams {
    /** [imageColumn, boxColumn]. */
    inputCols: string[]
    /** Language/script preset. See PADDLE_OCR_PRESETS. */
    preset: string
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
     * Recover inter-word spaces the greedy CTC decode drops. Helps Latin text
     * where the model collapses word gaps; can add spurious ones in dense
     * symbol runs.
     */
    spaceRecovery: boolean
    /** Crops per batched inference. 1 disables batching. */
    recBatchSize: number
}

export const PADDLE_RECOGNIZER_DEFAULTS: PaddleRecognizerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    outputCol: 'text',
    keepInputData: true,
    preset: DEFAULT_OCR_PRESET,
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
})

/**
 * Tallest sheet crops are stacked onto.
 *
 * Well under every browser's canvas ceiling, and low enough that a sheet stays
 * cheap to allocate. A single crop taller than this gets a sheet to itself.
 */
const MAX_SHEET_HEIGHT = 8192

function boxesOf(source: unknown): Box[] {
    if (typeof source !== 'object' || source === null) return []
    return (source as DetectorOutput).bboxes ?? []
}

export class PaddleRecognizer extends Stage<PaddleRecognizerParams> {
    readonly name = 'PaddleRecognizer'

    private orientation: LineOrientationClassifier | null = null
    private recognition: PaddleRecognitionService | null = null

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
        this.recognition ??= await getPaddleRecognizer(preset, { recBatchSize, spaceRecovery })
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
        const recognition = this.recognition as PaddleRecognitionService
        const bitmap = await decodeImage(image.data)

        // ScaleDP resizes the *page* and scales each box to index into it, which
        // is how a small line is handed to the model at a readable size. The
        // boxes it reports back are the originals, untouched -- so nothing here
        // has to map coordinates out again.
        const canvas = scaleFactor === 1 ? bitmap : resize(bitmap, scaleFactor)

        // Kept index-aligned: `crops[i]` is what `kept[i]` became.
        const kept: Box[] = []
        const crops: OffscreenCanvas[] = []

        try {
            for (const box of boxesOf(source)) {
                ctx.signal?.throwIfAborted()

                // Straightens rotated boxes rather than taking their envelope,
                // which is what makes a skewed line readable at all -- and what
                // ppu's own cropping, being axis-aligned, cannot do.
                let crop = cropBox(canvas, box, { scaleFactor, padding })

                let inverted = false
                if (detectLineOrientation && this.orientation) {
                    inverted = (await this.orientation.classify(crop)) === '180_degree'
                    if (inverted) crop = rotate180(crop)
                }

                // ScaleDP's onlyRotated: an upright, right-way-up box was
                // already handled by whatever pass produced it.
                if (onlyRotated && !isRotated(box) && !inverted) continue

                kept.push(box)
                crops.push(crop)
            }
        } finally {
            bitmap.close()
        }

        const read = await recognizeCrops(recognition, crops, ctx)

        const bboxes: Box[] = []
        for (const [i, box] of kept.entries()) {
            const result = read[i]
            if (!result?.text) continue
            if (result.score < scoreThreshold) continue
            bboxes.push({ ...box, text: result.text, score: result.score })
        }

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
        // The recognition session is shared per preset and owned by
        // paddle-service; `disposePaddleServices()` is what releases it.
        this.recognition = null
    }
}

interface ReadResult {
    text: string
    score: number
}

/**
 * Read every crop, batching across them.
 *
 * ppu batches `recBatchSize` crops into a single inference, but only within one
 * `run()` call, and `run()` cuts its crops out of the one canvas it is given. So
 * the crops are stacked onto sheet canvases -- each at x 0, one below the last --
 * and handed back as the boxes to read. ppu re-crops exactly those rects, so the
 * unused width beside a narrow crop is never sampled. Calling `run()` once per
 * box would instead pay one inference, and one main-thread yield, per line.
 *
 * Results come back index-aligned to `crops`; a crop ppu rejected or did not
 * return is left `undefined`. `run()` sorts what it returns into reading order,
 * so results are matched on the slot's y offset, never on array position.
 */
async function recognizeCrops(
    recognition: PaddleRecognitionService,
    crops: readonly OffscreenCanvas[],
    ctx: StageContext
): Promise<(ReadResult | undefined)[]> {
    const out: (ReadResult | undefined)[] = new Array(crops.length)

    for (let start = 0; start < crops.length; ) {
        ctx.signal?.throwIfAborted()

        // Take as many crops as fit on one sheet, but always at least one, so a
        // crop taller than the ceiling is still read.
        let end = start
        let height = 0
        let width = 0
        while (end < crops.length) {
            const crop = crops[end] as OffscreenCanvas
            if (end > start && height + crop.height > MAX_SHEET_HEIGHT) break
            height += crop.height
            width = Math.max(width, crop.width)
            end++
        }

        const sheet = createCanvas(width, height)
        const sheetCtx = context2d(sheet)
        const slots: { x: number; y: number; width: number; height: number }[] = []
        const atOffset = new Map<number, number>()
        let offset = 0
        for (let i = start; i < end; i++) {
            const crop = crops[i] as OffscreenCanvas
            sheetCtx.drawImage(crop, 0, offset)
            slots.push({ x: 0, y: offset, width: crop.width, height: crop.height })
            atOffset.set(offset, i)
            offset += crop.height
        }

        const results = await recognition.run(sheet as never, slots, undefined, 'per-box')
        for (const result of results) {
            const index = atOffset.get(result.box.y)
            if (index !== undefined) out[index] = { text: result.text.trim(), score: result.confidence }
        }

        start = end
    }

    return out
}
