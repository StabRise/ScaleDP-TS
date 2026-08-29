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
import type { Point } from '../core/geometry.js'
import { cropBox, cropGeometry, decodeImage, rotate180, toImageData } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { boxesToFormattedText, boxesToText } from '../core/text.js'
import { type Box, boxFromPolygon, isRotated } from '../schemas/box.js'
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
    /**
     * Granularity of the boxes returned.
     *
     * 'region' keeps ScaleDP's behaviour: one box per region the detector
     * found, carrying everything read inside it. Since the detectors here are
     * line-level, so are those boxes.
     *
     * 'word' returns instead the boxes tesseract reports for each word, mapped
     * back through the crop -- rotation included -- into page coordinates. Not
     * in Python ScaleDP, which always returns one box per region.
     */
    boxLevel: 'region' | 'word'
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
    boxLevel: 'region' as 'region' | 'word',
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
            boxLevel,
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
                // which is what makes a skewed line readable at all. The same
                // geometry maps word boxes back out again.
                const geometry = cropGeometry(box, { scaleFactor, padding })
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

                const words = items.filter((item) => item.text.trim())
                if (words.length === 0) continue

                // tesseract-wasm reports confidence on a 0-1 scale, not 0-100.
                // ScaleDP writes its confidence to `conf` and then filters on
                // `score`, so its threshold silently applies to the detector's
                // score instead; the value goes where it is read here.
                // Averaged over every item tesseract returned, empty ones
                // included, which is what the region mode did before word boxes
                // existed -- so a pipeline that was passing this gate still is.
                const score = items.reduce((sum, item) => sum + item.confidence, 0) / (items.length || 1)

                // The gate is the region's score in both modes, so `boxLevel`
                // changes how finely the result is cut up and nothing else. Per
                // word it would also change *what was read*: a word scoring 0.3
                // between two at 0.9 rides out on the region's mean, and would
                // vanish on its own -- so the same page would yield different
                // text depending on the box size asked for. Each word still
                // carries its own confidence for filtering further downstream.
                if (score < scoreThreshold) continue

                if (boxLevel === 'word') {
                    for (const item of words) {
                        recognized.push(
                            wordBox(
                                item.rect,
                                geometry,
                                inverted,
                                scaleFactor,
                                item.text.trim(),
                                item.confidence
                            )
                        )
                    }
                    continue
                }

                recognized.push({ ...box, text: words.map((item) => item.text.trim()).join(' '), score })
            }
        } finally {
            bitmap.close()
        }

        // Coordinates came from the scaled page, so bring them back. Word boxes
        // are already in page coordinates -- `wordBox` divides as it maps, so it
        // rounds once rather than twice.
        const bboxes =
            scaleFactor === 1 || boxLevel === 'word'
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

/**
 * One word's box, in the page's coordinates.
 *
 * tesseract reports the rect in the crop's own space: straightened, padded,
 * scaled, and turned the right way up if the line was upside down. Undo the
 * turn, then push the four corners back through the crop's own transform, so a
 * word inside a skewed line comes back skewed the same way.
 */
function wordBox(
    rect: { left: number; top: number; right: number; bottom: number },
    geometry: ReturnType<typeof cropGeometry>,
    inverted: boolean,
    scaleFactor: number,
    text: string,
    score: number
): Box {
    const { width, height, map } = geometry
    // rotate180 maps (x, y) to (w - x, h - y), so the rect's corners swap.
    const [left, top, right, bottom] = inverted
        ? [width - rect.right, height - rect.bottom, width - rect.left, height - rect.top]
        : [rect.left, rect.top, rect.right, rect.bottom]

    const toPage = (x: number, y: number): Point => {
        const [px, py] = map(x, y)
        return [px / scaleFactor, py / scaleFactor]
    }
    const corners: Point[] = [
        toPage(left, top),
        toPage(right, top),
        toPage(right, bottom),
        toPage(left, bottom),
    ]
    return boxFromPolygon(corners, { text, score })
}
