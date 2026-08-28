/**
 * Recognize text inside boxes a detector already found.
 *
 * Port of ScaleDP's `TesseractRecognizer` (a `BaseRecognizer`), which is the
 * half of the OCR story `PaddleTextRecognizer` cannot cover: Paddle detects and
 * recognises in a single pass over the page, so boxes produced by a *separate*
 * detector never reach it -- rotated boxes in particular. This stage takes those
 * boxes, straightens each one, and reads it.
 */

import { OcrError } from '../core/errors.js'
import { cropBox, decodeImage, toImageData } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import { type Box, isRotated } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'
import { DEFAULT_ORIENTATION_MODEL, LineOrientationClassifier } from './line-orientation.js'
import { getTesseractClient } from './tesseract.js'

export interface TesseractRecognizerParams extends BaseStageParams {
    /** [imageColumn, boxColumn]. */
    inputCols: string[]
    lang: readonly string[]
    /** Resize the page by this factor before cropping. */
    scaleFactor: number
    /** Grow each box before cropping. ScaleDP hardcodes 5. */
    padding: number
    /** Drop words below this confidence (0-1). */
    scoreThreshold: number
    keepFormatting: boolean
    lineTolerance: number
    /** Classify each crop 0/180 degrees and turn the inverted ones. */
    detectLineOrientation: boolean
    /**
     * Recognize only boxes that are rotated or came back inverted.
     *
     * ScaleDP defaults this to true because there the stage refines an OCR pass
     * that already ran. Standalone it is the primary recognizer, and skipping
     * every upright box would return an empty document for the ordinary case,
     * so the default is flipped here. See docs/porting.md.
     */
    onlyRotated: boolean
    oriModel: string
}

export const TESSERACT_RECOGNIZER_DEFAULTS: TesseractRecognizerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    outputCol: 'text',
    keepInputData: true,
    lang: ['eng'] as readonly string[],
    scaleFactor: 1,
    padding: 5,
    scoreThreshold: 0.5,
    keepFormatting: false,
    lineTolerance: 0,
    detectLineOrientation: true,
    onlyRotated: false,
    oriModel: DEFAULT_ORIENTATION_MODEL,
})

function boxesOf(source: unknown): Box[] {
    if (typeof source !== 'object' || source === null) return []
    return (source as DetectorOutput).bboxes ?? []
}

export class TesseractRecognizer extends Stage<TesseractRecognizerParams> {
    readonly name = 'TesseractRecognizer'

    private orientation: LineOrientationClassifier | null = null

    constructor(options: Partial<TesseractRecognizerParams> = {}) {
        super(
            resolveParams(TESSERACT_RECOGNIZER_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) {
                        throw new RangeError('inputCols must be [imageColumn, boxColumn]')
                    }
                },
                lang: (value) => {
                    if (value.length === 0) throw new RangeError('lang must not be empty')
                },
            })
        )
    }

    private get language(): string {
        return this.params.lang.join('+')
    }

    override async init(): Promise<void> {
        await getTesseractClient(this.language)
        if (this.params.detectLineOrientation) {
            this.orientation ??= new LineOrientationClassifier(this.params.oriModel)
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
        const client = await getTesseractClient(this.language)
        const bitmap = await decodeImage(image.data)
        const recognized: Box[] = []

        try {
            for (const box of boxesOf(source)) {
                ctx.signal?.throwIfAborted()

                // Straightens rotated boxes rather than taking their envelope,
                // which is what makes a skewed line readable at all.
                let crop = cropBox(bitmap, box, { scaleFactor, padding })

                let inverted = false
                if (detectLineOrientation && this.orientation) {
                    inverted = (await this.orientation.classify(crop)) === '180_degree'
                    if (inverted) crop = rotate180(crop)
                }

                // ScaleDP's onlyRotated: an upright, right-way-up box was
                // already handled by whatever pass produced it.
                if (onlyRotated && !isRotated(box) && !inverted) continue

                await client.loadImage(toImageData(crop))
                const items = await client.getTextBoxes('word')
                const text = items
                    .map((item) => item.text.trim())
                    .filter(Boolean)
                    .join(' ')
                if (!text) continue

                // tesseract-wasm reports confidence on a 0-1 scale, not 0-100.
                // ScaleDP writes its confidence to `conf` and then filters on
                // `score`, so its threshold silently applies to the detector's
                // score instead; the value goes where it is read here.
                const score = items.reduce((sum, item) => sum + item.confidence, 0) / (items.length || 1)
                if (score < scoreThreshold) continue

                recognized.push({ ...box, text, score })
            }
        } finally {
            bitmap.close()
        }

        // Coordinates came from the scaled page, so bring them back.
        const bboxes =
            scaleFactor === 1
                ? recognized
                : recognized.map((box) => ({
                      ...box,
                      x: Math.round(box.x / scaleFactor),
                      y: Math.round(box.y / scaleFactor),
                      width: Math.round(box.width / scaleFactor),
                      height: Math.round(box.height / scaleFactor),
                  }))

        return createDocument({
            path: String(row[this.params.pathCol] ?? image.path),
            type: 'tesseract-recognizer',
            text: keepFormatting ? boxesToFormattedText(bboxes, lineTolerance) : boxesToText(bboxes),
            bboxes,
        })
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'tesseract-recognizer',
            exception: message,
        })
    }

    override async dispose(): Promise<void> {
        await this.orientation?.dispose()
        this.orientation = null
    }
}

/** Turn a crop 180 degrees, so an inverted line reads the right way up. */
function rotate180(source: OffscreenCanvas): OffscreenCanvas {
    const out = new OffscreenCanvas(source.width, source.height)
    const ctx = out.getContext('2d')
    if (!ctx) throw new OcrError('Failed to acquire a 2D context', 'TesseractRecognizer')
    ctx.translate(source.width / 2, source.height / 2)
    ctx.rotate(Math.PI)
    ctx.drawImage(source, -source.width / 2, -source.height / 2)
    return out
}
