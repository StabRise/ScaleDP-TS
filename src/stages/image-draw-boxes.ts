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
    textSize: 24,
    displayDataList: [] as string[],
    padding: 0,
    whiteList: [] as string[],
    blackList: [] as string[],
})

/**
 * Hues for the entity groups the NER models in this library actually emit.
 *
 * Hashing alone is not enough. On the default PII label set it gives
 * `phone_number` and `date` the *same* hue, and puts `person` one degree from
 * `ip_address` -- so the per-group colouring that is supposed to tell groups
 * apart renders them identical. Any hash over 24 labels collides like this; it
 * is the birthday problem, not a bad multiplier. The groups worth telling apart
 * are a known, short list, so they are assigned by hand, evenly spaced 18\u00b0
 * apart around the wheel. Two names for one concept -- `phone` and
 * `phone_number` -- deliberately share a hue.
 *
 * Related groups sit in the same region of the wheel -- the address family in
 * the greens, the account identifiers in the reds -- so a page reads as
 * something more than confetti.
 */
const GROUP_HUES: Readonly<Record<string, number>> = Object.freeze({
    // Numbers that identify a person or an account: reds through yellows.
    credit_card: 0,
    account_number: 18,
    account: 18,
    phone_number: 36,
    phone: 36,
    id: 54,
    passport: 72,
    driver_license: 90,
    // Where something is: greens.
    zip_code: 108,
    postcode: 108,
    location: 126,
    address: 144,
    // How to reach someone online: cyans.
    url: 162,
    email: 180,
    // People and organizations: blues and violets.
    person_title: 198,
    person: 216,
    person_name: 216,
    ip_address: 234,
    ip: 234,
    technology: 252,
    organization: 270,
    // Everything else our models emit.
    date: 288,
    age: 306,
    medical_condition: 324,
    ssn: 342,
})

/** Lowercase, with '-' and spaces folded to '_', so PERSON-NAME finds person_name. */
function normaliseGroup(name: string): string {
    return name.toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * A stable colour per group name.
 *
 * Python picks a random colour per group, which changes on every run and makes
 * two renders of the same document impossible to compare. A fixed hue keeps
 * 'PERSON' the same colour everywhere -- in the drawn boxes and in
 * `visualizeNer`'s text, which call this same function -- and the fixed
 * saturation and lightness keep every colour legible on a white page and under
 * the white label text drawn on top of it.
 *
 * A group outside the table still gets a colour, hashed from its name. That is
 * what makes a label nobody anticipated work; it is only the *known* groups
 * that cannot be left to chance.
 */
export function colorForGroup(name: string): string {
    const known = GROUP_HUES[normaliseGroup(name)]
    if (known !== undefined) return `hsl(${known}, 70%, 45%)`

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

    /**
     * The label chip, anchored to the box's own top edge.
     *
     * Python places it at `box.x, box.y`, which is the corner of the *axis-
     * aligned envelope*. For an upright box that is the top-left corner and the
     * label sits where you expect; for a rotated one the envelope corner can be
     * a long way off the box -- a vertical line's label lands beside its middle,
     * detached from the box it names. Here the chip is drawn in the box's own
     * frame instead, so it rides the top edge at the box's angle whatever that
     * angle is. Upright boxes come out exactly where Python puts them.
     */
    private drawLabel(ctx: OffscreenCanvasRenderingContext2D, box: Box, label: string, color: string): void {
        const { textSize, padding } = this.params
        ctx.font = `${textSize}px sans-serif`
        const width = ctx.measureText(label).width
        const height = textSize * 1.2

        const chip = (x: number, y: number) => {
            ctx.fillStyle = color
            ctx.fillRect(x, y, width + 6, height)
            ctx.fillStyle = '#ffffff'
            ctx.textBaseline = 'top'
            ctx.fillText(label, x + 3, y + 1)
        }

        if (!isRotated(box)) {
            chip(box.x - padding, box.y - height - padding)
            return
        }

        // Top-left corner of the padded box, in the box's own frame.
        const left = -box.width / 2 - padding
        const top = -box.height / 2 - padding

        ctx.save()
        ctx.translate(box.x + box.width / 2, box.y + box.height / 2)
        ctx.rotate((box.angle * Math.PI) / 180)
        chip(left, top - height)
        ctx.restore()
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }
}
