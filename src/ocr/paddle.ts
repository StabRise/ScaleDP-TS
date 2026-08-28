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
import { type Row, Stage } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import { type Box, boxFromBBox } from '../schemas/box.js'
import { createDetectorOutput, type DetectorOutput } from '../schemas/detector-output.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { getPaddleService } from './paddle-service.js'
import { DEFAULT_OCR_PRESET, isKnownPreset } from './presets.js'

/** Recognizing per box gives word-level output; per line merges them first. */
export type RecognitionStrategy = 'per-box' | 'per-line' | 'cross-line'

export interface PaddleOcrParams extends BaseStageParams {
    /** Language/script preset. See PADDLE_OCR_PRESETS. */
    preset: string
    /** Drop results below this confidence (0-1). */
    scoreThreshold: number
}

export interface PaddleTextDetectorParams extends PaddleOcrParams {}

export const PADDLE_DETECTOR_DEFAULTS: PaddleTextDetectorParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'boxes',
    keepInputData: true,
    preset: DEFAULT_OCR_PRESET,
    scoreThreshold: 0,
})

function validatePreset(value: string): void {
    if (!isKnownPreset(value)) {
        throw new RangeError(`Unknown OCR preset "${value}". See PADDLE_OCR_PRESETS for valid values.`)
    }
}

/** Decode a stage input into something ppu-paddle-ocr accepts. */
async function toCanvas(input: unknown): Promise<OffscreenCanvas> {
    if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) return input
    if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
        return imageDataToCanvas(input)
    }

    const image = input as ScaleDpImage | undefined
    if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
        throw new OcrError('Expected an Image with decoded bytes', 'toCanvas')
    }
    if (image.exception) {
        throw new OcrError(`Upstream stage failed: ${image.exception}`, 'toCanvas')
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
        super(resolveParams(PADDLE_DETECTOR_DEFAULTS, options, { preset: validatePreset }))
    }

    override async init(): Promise<void> {
        await getPaddleService(this.params.preset)
    }

    protected async apply(input: unknown, row: Row): Promise<DetectorOutput> {
        const service = await getPaddleService(this.params.preset)
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
    /** 'per-box' yields word-level boxes; 'per-line' merges them into lines. */
    strategy: RecognitionStrategy
    /** Rebuild the original layout with spaces and blank lines. */
    keepFormatting: boolean
    /** Line-grouping tolerance in pixels; 0 derives it from character height. */
    lineTolerance: number
}

export const PADDLE_RECOGNIZER_DEFAULTS: PaddleTextRecognizerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    outputCol: 'text',
    keepInputData: true,
    preset: DEFAULT_OCR_PRESET,
    scoreThreshold: 0.5,
    strategy: 'per-box' as RecognitionStrategy,
    keepFormatting: false,
    lineTolerance: 0,
})

/** Full OCR: image -> Document with text and word-level boxes. */
export class PaddleTextRecognizer extends Stage<PaddleTextRecognizerParams> {
    readonly name = 'PaddleTextRecognizer'

    constructor(options: Partial<PaddleTextRecognizerParams> = {}) {
        super(resolveParams(PADDLE_RECOGNIZER_DEFAULTS, options, { preset: validatePreset }))
    }

    override async init(): Promise<void> {
        await getPaddleService(this.params.preset)
    }

    protected async apply(input: unknown, row: Row): Promise<Document> {
        const { preset, strategy, scoreThreshold, keepFormatting, lineTolerance } = this.params
        const service = await getPaddleService(preset)
        const canvas = await toCanvas(input)

        const result = await service.recognize(canvas as never, {
            flatten: true,
            strategy,
            // ppu caches globally, keyed on pixels. Without this, switching
            // preset returns the *previous* model's result for the same image.
            noCache: true,
        })

        const items = 'results' in result ? result.results : []
        const bboxes: Box[] = items
            .filter((item) => item.confidence >= scoreThreshold)
            .map((item) =>
                boxFromBBox(
                    [item.box.x, item.box.y, item.box.x + item.box.width, item.box.y + item.box.height],
                    { text: item.text, score: item.confidence }
                )
            )

        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'ocr',
            text: keepFormatting ? boxesToFormattedText(bboxes, lineTolerance) : boxesToText(bboxes),
            bboxes,
        })
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'ocr',
            exception: message,
        })
    }
}
