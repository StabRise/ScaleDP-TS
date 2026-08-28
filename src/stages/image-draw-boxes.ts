/**
 * Port of `scaledp/image/ImageDrawBoxes.py`: draw detection or NER boxes onto
 * the page.
 *
 * Takes several input columns -- an image plus one or more box sources -- and
 * writes a new image. A source is treated as NER output when it has `entities`,
 * and as boxes when it has `bboxes`.
 */

import { ImageError } from '../core/errors.js'
import { context2d, createCanvas, decodeImage, encodeImage } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import { type Box, isRotated } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import type { Document } from '../schemas/document.js'
import type { Entity, NerOutput } from '../schemas/entity.js'
import { createImage, type ImageFormat, type ScaleDpImage } from '../schemas/image.js'

export interface ImageDrawBoxesParams extends BaseStageParams {
    /**
     * First entry is the image; the rest are box or entity sources. `inputCol`
     * is inherited and unused here -- multi-input stages address their columns
     * through this list, as they do in Python.
     */
    inputCols: string[]
    imageType: ImageFormat
    /** Fill boxes as well as outlining them. */
    filled: boolean
    /** Fixed colour for every box. Unset colours by group instead. */
    color: string | null
    lineWidth: number
    textSize: number
    /**
     * Box or entity fields to render as a label above each box, joined by ':'.
     * e.g. ['entity_group'] or ['text', 'score'].
     */
    displayDataList: string[]
    /** Grow each box by this many pixels before drawing. */
    padding: number
    /** Only draw these entity groups; empty draws all. */
    whiteList: string[]
    /** Never draw these entity groups. */
    blackList: string[]
}

export const IMAGE_DRAW_BOXES_DEFAULTS: ImageDrawBoxesParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    outputCol: 'image_with_boxes',
    keepInputData: true,
    imageType: 'png' as ImageFormat,
    filled: false,
    color: null,
    lineWidth: 1,
    textSize: 12,
    displayDataList: [] as string[],
    padding: 0,
    whiteList: [] as string[],
    blackList: [] as string[],
})

/**
 * A stable colour per group name.
 *
 * Python picks a random colour per group, which changes on every run and makes
 * two renders of the same document impossible to compare. Hashing the name
 * instead keeps 'PERSON' the same colour everywhere, and the fixed saturation
 * and lightness keep every colour legible on a white page.
 */
export function colorForGroup(name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
    return `hsl(${Math.abs(hash) % 360}, 70%, 45%)`
}

function labelFor(source: Record<string, unknown>, fields: readonly string[]): string {
    const parts: string[] = []
    for (const field of fields) {
        const value = source[field]
        if (value === undefined || value === null) continue
        parts.push(typeof value === 'number' ? value.toFixed(2) : String(value))
    }
    return parts.join(':')
}

type BoxSource = DetectorOutput | Document | NerOutput

function isNerOutput(value: unknown): value is NerOutput {
    return typeof value === 'object' && value !== null && 'entities' in value
}

export class ImageDrawBoxes extends Stage<ImageDrawBoxesParams> {
    readonly name = 'ImageDrawBoxes'

    constructor(options: Partial<ImageDrawBoxesParams> = {}) {
        super(
            resolveParams(IMAGE_DRAW_BOXES_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length < 2) {
                        throw new RangeError('inputCols needs an image column and at least one box column')
                    }
                },
            })
        )
    }

    /** The base class drives `apply` off inputCol; this stage reads several. */
    protected async apply(_input: unknown, row: Row): Promise<ScaleDpImage> {
        const [imageCol, ...boxCols] = this.params.inputCols
        const image = row[imageCol as string] as ScaleDpImage | undefined

        if (image?.exception) {
            throw new ImageError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new ImageError('Expected an Image with decoded bytes', this.name)
        }

        const bitmap = await decodeImage(image.data)
        try {
            const canvas = createCanvas(bitmap.width, bitmap.height)
            const ctx = context2d(canvas)
            ctx.drawImage(bitmap, 0, 0)

            for (const column of boxCols) {
                const source = row[column] as BoxSource | undefined
                if (!source) continue
                if (isNerOutput(source)) this.drawEntities(ctx, source.entities)
                else this.drawBoxes(ctx, source.bboxes)
            }

            return createImage({
                path: image.path,
                resolution: image.resolution,
                data: await encodeImage(canvas, `image/${this.params.imageType}` as never),
                imageType: this.params.imageType,
                width: canvas.width,
                height: canvas.height,
            })
        } finally {
            bitmap.close()
        }
    }

    private drawBoxes(ctx: OffscreenCanvasRenderingContext2D, boxes: readonly Box[]): void {
        for (const box of boxes) {
            // Colour by box text so repeated labels share a colour, matching
            // Python's grouping.
            const color = this.params.color ?? colorForGroup(box.text || 'default')
            this.drawBox(ctx, box, color)
            const label = labelFor(box as unknown as Record<string, unknown>, this.params.displayDataList)
            if (label) this.drawLabel(ctx, box, label, color)
        }
    }

    private drawEntities(ctx: OffscreenCanvasRenderingContext2D, entities: readonly Entity[]): void {
        const { whiteList, blackList } = this.params
        for (const entity of entities) {
            if (whiteList.length > 0 && !whiteList.includes(entity.entity_group)) continue
            if (blackList.includes(entity.entity_group)) continue

            const color = this.params.color ?? colorForGroup(entity.entity_group)
            for (const box of entity.boxes) {
                this.drawBox(ctx, box, color)
                const label = labelFor(
                    entity as unknown as Record<string, unknown>,
                    this.params.displayDataList
                )
                if (label) this.drawLabel(ctx, box, label, color)
            }
        }
    }

    private drawBox(ctx: OffscreenCanvasRenderingContext2D, box: Box, color: string): void {
        const { padding, lineWidth, filled } = this.params
        ctx.strokeStyle = color
        ctx.lineWidth = lineWidth
        ctx.fillStyle = color

        if (!isRotated(box)) {
            ctx.beginPath()
            ctx.roundRect(
                box.x - padding,
                box.y - padding,
                box.width + padding * 2,
                box.height + padding * 2,
                4
            )
            if (filled) ctx.fill()
            ctx.stroke()
            return
        }

        // Rotate the four corners about the box centre, matching how ScaleDP
        // interprets `angle` when it renders.
        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        const rad = (box.angle * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const half: [number, number][] = [
            [-box.width / 2 - padding, -box.height / 2 - padding],
            [box.width / 2 + padding, -box.height / 2 - padding],
            [box.width / 2 + padding, box.height / 2 + padding],
            [-box.width / 2 - padding, box.height / 2 + padding],
        ]

        ctx.beginPath()
        half.forEach(([px, py], index) => {
            const x = px * cos - py * sin + cx
            const y = px * sin + py * cos + cy
            if (index === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.closePath()
        if (filled) ctx.fill()
        ctx.stroke()
    }

    private drawLabel(ctx: OffscreenCanvasRenderingContext2D, box: Box, label: string, color: string): void {
        const { textSize, padding } = this.params
        ctx.font = `${textSize}px sans-serif`
        const width = ctx.measureText(label).width
        const y = box.y - textSize * 1.2 - padding

        // A filled chip behind the label: white-on-page text is unreadable over
        // a light scan.
        ctx.fillStyle = color
        ctx.fillRect(box.x - padding, y, width + 6, textSize * 1.2)
        ctx.fillStyle = '#ffffff'
        ctx.textBaseline = 'top'
        ctx.fillText(label, box.x - padding + 3, y + 1)
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }
}
