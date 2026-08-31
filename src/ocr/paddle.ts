/**
 * PaddleOCR text detection and recognition -- the default OCR engines.
 *
 * `PaddleTextDetector` mirrors ScaleDP's detector stages (image -> boxes) and
 * `PaddleTextRecognizer` mirrors its OCR stages (image -> Document with text
 * and boxes). Both run PP-OCR models through ppu-paddle-ocr on onnxruntime-web.
 */

import { OcrError } from '../core/errors.js'
import { decodeImage, imageDataToCanvas } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import { type Box, boxFromBBox } from '../schemas/box.js'
import { createDetectorOutput, type DetectorOutput } from '../schemas/detector-output.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { getPaddleRecognizer, getPaddleService } from './paddle-service.js'
import { readRegions } from './paddle-words.js'
import { DEFAULT_OCR_PRESET, presetForRow, validatePreset } from './presets.js'

/** Recognizing per box gives word-level output; per line merges them first. */
export type RecognitionStrategy = 'per-box' | 'per-line' | 'cross-line'

export interface PaddleOcrParams extends BaseStageParams {
    /** Language/script preset. See PADDLE_OCR_PRESETS. */
    preset: string
    /**
     * Column naming the preset to use for *this row*, overriding `preset`.
     *
     * Empty by default, which pins the model to `preset`. Point it at a
     * `TesseractScriptDetector` column and the model follows the page: a
     * mixed-script PDF gets the right recogniser per page, which no single
     * `preset` can do. Anything the column cannot answer -- no detection, a
     * script no preset covers -- falls back to `preset`.
     *
     * Each preset it lands on is downloaded and kept, so a document that swings
     * between scripts pays for both models.
     */
    presetCol: string
    /** Drop results below this confidence (0-1). */
    scoreThreshold: number
}

export interface PaddleTextDetectorParams extends PaddleOcrParams {}

export const PADDLE_TEXT_DETECTOR_DEFAULTS: PaddleTextDetectorParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'boxes',
    keepInputData: true,
    preset: DEFAULT_OCR_PRESET,
    presetCol: '',
    scoreThreshold: 0,
})

/** Decode a stage input into something ppu-paddle-ocr accepts. */
async function toCanvas(input: unknown): Promise<OffscreenCanvas> {
    if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) return input
    if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
        return imageDataToCanvas(input)
    }

    const image = input as ScaleDpImage | undefined
    // Check `exception` first. A failed upstream stage returns a well-formed but
    // empty Image, so testing the bytes first would report "no decoded bytes" and
    // bury the real cause.
    if (image?.exception) {
        throw new OcrError(`Upstream stage failed: ${image.exception}`, 'toCanvas')
    }
    if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
        throw new OcrError('Expected an Image with decoded bytes', 'toCanvas')
    }

    const bitmap = await decodeImage(image.data)
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new OcrError('Failed to acquire a 2D context', 'toCanvas')
        ctx.drawImage(bitmap, 0, 0)
        return canvas
    } finally {
        bitmap.close()
    }
}

/** Text detection only: image -> word boxes, no recognition. */
export class PaddleTextDetector extends Stage<PaddleTextDetectorParams> {
    readonly name = 'PaddleTextDetector'

    constructor(options: Partial<PaddleTextDetectorParams> = {}) {
        super(resolveParams(PADDLE_TEXT_DETECTOR_DEFAULTS, options, { preset: validatePreset }))
    }

    override async init(): Promise<void> {
        await getPaddleService(this.params.preset)
    }

    protected async apply(input: unknown, row: Row): Promise<DetectorOutput> {
        const service = await getPaddleService(presetForRow(row, this.params.presetCol, this.params.preset))
        const canvas = await toCanvas(input)
        const { boxes } = await service.detect(canvas as never)

        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'paddle',
            // ppu returns axis-aligned boxes in original image coordinates.
            bboxes: boxes.map((b) => boxFromBBox([b.x, b.y, b.x + b.width, b.y + b.height], { score: 1 })),
        })
    }

    protected onError(message: string, row: Row): DetectorOutput {
        return createDetectorOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'paddle',
            exception: message,
        })
    }
}

export interface PaddleTextRecognizerParams extends PaddleOcrParams {
    /**
     * How recognized regions are grouped. 'per-box' keeps them as detected,
     * 'per-line' merges them into lines.
     *
     * ScaleDP's docstring calls 'per-box' word-level. That describes the
     * grouping, not the geometry: the boxes are whatever the preset's detector
     * produced, and PaddleOCR's detector is line-level. No strategy can
     * subdivide a region -- `boxLevel: 'word'` is what does that, and it makes
     * this parameter inert.
     */
    strategy: RecognitionStrategy
    /** Rebuild the original layout with spaces and blank lines. */
    keepFormatting: boolean
    /** Line-grouping tolerance in pixels; 0 derives it from character height. */
    lineTolerance: number
    /**
     * Granularity of the boxes returned.
     *
     * 'word' is the default, matching `TesseractOcr`, `TesseractRecognizer` and
     * `PaddleRecognizer`. PP-OCR's detector is line-level and it reads a crop
     * into one undivided string, so the words are recovered by splitting each
     * line's *reading* -- the same machinery `PaddleRecognizer` uses, over
     * PP-OCR's own boxes instead of a separate detector's.
     *
     * 'region' keeps one box per detected line, which is what this stage
     * returned before the option existed, and the only sensible choice for a
     * script that does not separate words with spaces.
     *
     * `strategy` applies to 'region' only: it groups the regions PP-OCR
     * recognised, and the word path does its own detection pass instead.
     */
    boxLevel: 'region' | 'word'
    /**
     * How wide a blank column run must be, relative to the crop's height, to
     * count as a space rather than a gap between letters. 'word' only.
     */
    wordGapRatio: number
}

export const PADDLE_TEXT_RECOGNIZER_DEFAULTS: PaddleTextRecognizerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'text',
    keepInputData: true,
    preset: DEFAULT_OCR_PRESET,
    presetCol: '',
    scoreThreshold: 0.5,
    strategy: 'per-box' as RecognitionStrategy,
    keepFormatting: false,
    lineTolerance: 0,
    boxLevel: 'word' as 'region' | 'word',
    wordGapRatio: 0.15,
})

/** Full OCR: image -> Document with text and word-level boxes. */
export class PaddleTextRecognizer extends Stage<PaddleTextRecognizerParams> {
    readonly name = 'PaddleTextRecognizer'

    constructor(options: Partial<PaddleTextRecognizerParams> = {}) {
        super(resolveParams(PADDLE_TEXT_RECOGNIZER_DEFAULTS, options, { preset: validatePreset }))
    }

    override async init(): Promise<void> {
        await getPaddleService(this.params.preset)
    }

    protected async apply(input: unknown, row: Row, ctx: StageContext): Promise<Document> {
        const { preset, presetCol, keepFormatting, lineTolerance, boxLevel } = this.params
        const chosen = presetForRow(row, presetCol, preset)
        const service = await getPaddleService(chosen)
        const canvas = await toCanvas(input)

        const bboxes =
            boxLevel === 'word'
                ? await this.readWords(service, chosen, canvas, ctx)
                : await this.readRegionsWhole(service, canvas)

        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'ocr',
            text: keepFormatting ? boxesToFormattedText(bboxes, lineTolerance) : boxesToText(bboxes),
            bboxes,
        })
    }

    /**
     * One box per region PP-OCR detected, read in the same pass.
     *
     * `strategy` lives here: it is ppu's own grouping of the regions it read.
     */
    private async readRegionsWhole(
        service: Awaited<ReturnType<typeof getPaddleService>>,
        canvas: OffscreenCanvas
    ): Promise<Box[]> {
        const { strategy, scoreThreshold } = this.params
        const result = await service.recognize(canvas as never, {
            flatten: true,
            strategy,
            // ppu caches globally, keyed on pixels. Without this, switching
            // preset returns the *previous* model's result for the same image.
            noCache: true,
        })

        const items = 'results' in result ? result.results : []
        return items
            .filter((item) => item.confidence >= scoreThreshold)
            .map((item) =>
                boxFromBBox(
                    [item.box.x, item.box.y, item.box.x + item.box.width, item.box.y + item.box.height],
                    { text: item.text, score: item.confidence }
                )
            )
    }

    /**
     * Detect, then cut each region into words and read those.
     *
     * Two passes rather than ppu's combined one, because `recognize` returns a
     * region's text as a single undivided string with no geometry inside it --
     * there is nothing to cut up afterwards. Detection is not repeated: the
     * combined call would have run it too, so the cost is the recognition of
     * more, smaller crops rather than a whole extra stage.
     */
    private async readWords(
        service: Awaited<ReturnType<typeof getPaddleService>>,
        preset: string,
        canvas: OffscreenCanvas,
        ctx: StageContext
    ): Promise<Box[]> {
        const { scoreThreshold, wordGapRatio } = this.params
        const { boxes } = await service.detect(canvas as never)
        const regions = boxes.map((b) => boxFromBBox([b.x, b.y, b.x + b.width, b.y + b.height], { score: 1 }))

        // Deliberately not passing `spaceRecovery`. The word split needs the
        // line's spaces, but ppu already places those from the decode's own
        // geometry; `spaceRecovery` is a separate 0.001-threshold pass that
        // shreds small or noisy text into `s e n s i t i v e`.
        const recognition = await getPaddleRecognizer(preset)
        const read = await readRegions(
            recognition,
            canvas,
            regions,
            { scaleFactor: 1, padding: 0, boxLevel: 'word', wordGapRatio },
            ctx
        )
        return read.filter((box) => box.score >= scoreThreshold)
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'ocr',
            exception: message,
        })
    }
}
