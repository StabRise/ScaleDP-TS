/**
 * Line-orientation detection and correction.
 *
 * Port of ScaleDP's `HasDetectLineOrientation`, which `TesseractRecognizer`
 * mixes in: each detected box is cropped, classified 0 or 180 degrees, and the
 * upside-down ones are turned before recognition. An inverted line otherwise
 * recognises as noise.
 *
 * Python does this per crop inside the recognizer. Here it is a stage of its
 * own, because `PaddleTextRecognizer` detects and recognises in a single pass
 * and has no seam to hook into. Flipping each inverted region in place on a
 * copy of the page gets the same result and costs one recognition pass rather
 * than one per box; the regions are rectangles, so a 180-degree turn leaves
 * every box's coordinates untouched and downstream stages need no adjustment.
 */

import { DetectionError } from '../core/errors.js'
import { context2d, createCanvas, cropBox, decodeImage, encodeImage } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { type Box, isRotated } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import type { Document } from '../schemas/document.js'
import { createImage, type ImageFormat, type ScaleDpImage } from '../schemas/image.js'
import {
    DEFAULT_ORIENTATION_MODEL,
    type LineOrientation,
    LineOrientationClassifier,
} from './line-orientation.js'

export interface LineOrientationDetectorParams extends BaseStageParams {
    /** [imageColumn, boxColumn]. */
    inputCols: string[]
    /** Column the corrected image is written to. */
    outputCol: string
    /** Column the per-box orientation labels are written to. */
    orientationCol: string
    model: string
    /** Turn the inverted regions. Off classifies only, leaving the page as-is. */
    correct: boolean
    /**
     * Classify only boxes that are already rotated, as ScaleDP's `onlyRotated`
     * does, and defaults to.
     *
     * This is not just a saved inference per box. The classifier has a real
     * false-positive rate: on an upright invoice it called 1 of 81 upright
     * regions inverted, and turning that region cost about 40 characters of
     * recognition. Restricting it to boxes that are already rotated is where
     * the signal actually is.
     *
     * Set false for pages that may contain upside-down *horizontal* text, which
     * is the case this misses.
     */
    onlyRotated: boolean
    /** Grow each box before cropping, so glyph edges are not clipped. */
    padding: number
    imageType: ImageFormat
}

export const LINE_ORIENTATION_DEFAULTS: LineOrientationDetectorParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    outputCol: 'oriented',
    orientationCol: 'orientations',
    keepInputData: true,
    model: DEFAULT_ORIENTATION_MODEL,
    correct: true,
    onlyRotated: true,
    padding: 2,
    imageType: 'png' as ImageFormat,
})

function boxesOf(source: unknown): Box[] {
    if (typeof source !== 'object' || source === null) return []
    return (source as DetectorOutput | Document).bboxes ?? []
}

export class LineOrientationDetector extends Stage<LineOrientationDetectorParams> {
    readonly name = 'LineOrientationDetector'

    private classifier: LineOrientationClassifier | null = null

    constructor(options: Partial<LineOrientationDetectorParams> = {}) {
        super(
            resolveParams(LINE_ORIENTATION_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) {
                        throw new RangeError('inputCols must be [imageColumn, boxColumn]')
                    }
                },
            })
        )
    }

    override async init(): Promise<void> {
        this.classifier ??= new LineOrientationClassifier(this.params.model)
    }

    /** One row in, one row out -- but two columns written, so expand not apply. */
    protected override async expand(_input: unknown, row: Row, ctx: StageContext): Promise<Row[]> {
        const { inputCols, outputCol, orientationCol, correct, onlyRotated, padding } = this.params
        const [imageCol, boxCol] = inputCols as [string, string]
        const image = row[imageCol] as ScaleDpImage | undefined

        if (image?.exception) {
            throw new DetectionError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new DetectionError('Expected an Image with decoded bytes', this.name)
        }

        await this.init()
        const classifier = this.classifier as LineOrientationClassifier
        const boxes = boxesOf(row[boxCol])

        const bitmap = await decodeImage(image.data)
        try {
            const canvas = createCanvas(bitmap.width, bitmap.height)
            const ctx2d = context2d(canvas)
            ctx2d.drawImage(bitmap, 0, 0)

            const orientations: LineOrientation[] = []
            let flipped = 0

            for (const box of boxes) {
                ctx.signal?.throwIfAborted()

                if (onlyRotated && !isRotated(box)) {
                    orientations.push('0_degree')
                    continue
                }

                const crop = cropBox(bitmap, box, { padding })
                const orientation = await classifier.classify(crop)
                orientations.push(orientation)

                if (orientation === '180_degree' && correct) {
                    flipRegion(ctx2d, canvas, box)
                    flipped++
                }
            }

            const corrected =
                flipped > 0
                    ? createImage({
                          path: image.path,
                          resolution: image.resolution,
                          data: await encodeImage(canvas, `image/${this.params.imageType}` as never),
                          imageType: this.params.imageType,
                          width: canvas.width,
                          height: canvas.height,
                      })
                    : // Nothing was inverted, so hand the original through rather
                      // than paying a re-encode for an identical image.
                      image

            return [{ ...row, [outputCol]: corrected, [orientationCol]: orientations }]
        } finally {
            bitmap.close()
        }
    }

    protected async apply(): Promise<never> {
        throw new DetectionError('unreachable: expand handles every row', this.name)
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }

    override async dispose(): Promise<void> {
        await this.classifier?.dispose()
        this.classifier = null
    }
}

/**
 * Turn one box's region 180 degrees in place.
 *
 * A rectangle maps onto itself under a 180-degree rotation about its own
 * centre, whatever its angle, so the box's coordinates stay valid and
 * downstream stages need no adjustment.
 *
 * The draw is clipped to the box's own rotated outline. Without that a rotated
 * box turns its whole axis-aligned envelope, dragging neighbouring text through
 * the rotation with it -- and the envelope of a skewed box is meaningfully
 * larger than the box.
 */
function flipRegion(ctx: OffscreenCanvasRenderingContext2D, canvas: OffscreenCanvas, box: Box): void {
    const pad = 1
    const x = Math.max(0, Math.min(Math.round(box.x) - pad, canvas.width - 1))
    const y = Math.max(0, Math.min(Math.round(box.y) - pad, canvas.height - 1))
    const width = Math.min(Math.round(box.width) + pad * 2, canvas.width - x)
    const height = Math.min(Math.round(box.height) + pad * 2, canvas.height - y)
    if (width < 1 || height < 1) return

    // Drawing a canvas onto itself through a transform reads and writes the same
    // backing store, so take a copy first.
    const region = createCanvas(width, height)
    context2d(region).drawImage(canvas, x, y, width, height, 0, 0, width, height)

    const cx = x + width / 2
    const cy = y + height / 2

    ctx.save()
    ctx.beginPath()
    if (Math.abs(box.angle) < 3) {
        ctx.rect(x, y, width, height)
    } else {
        const rad = (box.angle * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const corners: [number, number][] = [
            [-box.width / 2, -box.height / 2],
            [box.width / 2, -box.height / 2],
            [box.width / 2, box.height / 2],
            [-box.width / 2, box.height / 2],
        ]
        corners.forEach(([px, py], index) => {
            const rx = px * cos - py * sin + cx
            const ry = px * sin + py * cos + cy
            if (index === 0) ctx.moveTo(rx, ry)
            else ctx.lineTo(rx, ry)
        })
        ctx.closePath()
    }
    ctx.clip()

    ctx.translate(cx, cy)
    ctx.rotate(Math.PI)
    ctx.drawImage(region, -width / 2, -height / 2)
    ctx.restore()
}
