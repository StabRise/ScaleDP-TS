/**
 * Port of `scaledp/image/ImageCropBoxes.py`: crop each detected box out of the
 * page, emitting one row per crop.
 *
 * Rotated boxes are straightened rather than cropped to their envelope, which
 * is what makes the crops usable as recognizer input.
 */

import { ImageError } from '../core/errors.js'
import { cropBox, decodeImage, encodeImage } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import type { Box } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import type { Document } from '../schemas/document.js'
import { createImage, type ImageFormat, type ScaleDpImage } from '../schemas/image.js'

export interface ImageCropBoxesParams extends BaseStageParams {
    /** [imageColumn, boxColumn]. */
    inputCols: string[]
    imageType: ImageFormat
    /** Grow each box by this many pixels before cropping. */
    padding: number
    /** Maximum crops per page; 0 means all of them. */
    limit: number
    /** Rotate portrait crops a quarter turn, so text reads horizontally. */
    autoRotate: boolean
    /** Emit the whole page when nothing was detected, instead of failing. */
    returnEmpty: boolean
    /** Column to write the source box alongside each crop. */
    boxCol: string
}

export const IMAGE_CROP_BOXES_DEFAULTS: ImageCropBoxesParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    outputCol: 'cropped_image',
    keepInputData: true,
    imageType: 'png' as ImageFormat,
    padding: 0,
    limit: 0,
    autoRotate: true,
    returnEmpty: false,
    boxCol: 'box',
})

function boxesOf(source: unknown): Box[] {
    if (typeof source !== 'object' || source === null) return []
    return (source as DetectorOutput | Document).bboxes ?? []
}

export class ImageCropBoxes extends Stage<ImageCropBoxesParams> {
    readonly name = 'ImageCropBoxes'

    constructor(options: Partial<ImageCropBoxesParams> = {}) {
        super(
            resolveParams(IMAGE_CROP_BOXES_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) {
                        throw new RangeError('inputCols must be [imageColumn, boxColumn]')
                    }
                },
            })
        )
    }

    protected override async expand(_input: unknown, row: Row, ctx: StageContext): Promise<Row[]> {
        const { inputCols, outputCol, boxCol, limit, padding, autoRotate, imageType } = this.params
        const [imageCol, boxSourceCol] = inputCols as [string, string]
        const image = row[imageCol] as ScaleDpImage | undefined

        if (image?.exception) {
            throw new ImageError(`Upstream stage failed: ${image.exception}`, this.name)
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new ImageError('Expected an Image with decoded bytes', this.name)
        }

        let boxes = boxesOf(row[boxSourceCol])
        if (limit > 0) boxes = boxes.slice(0, limit)

        if (boxes.length === 0) {
            if (!this.params.returnEmpty) {
                throw new ImageError('No boxes to crop', this.name)
            }
            return [{ ...row, [outputCol]: image, [boxCol]: null }]
        }

        const bitmap = await decodeImage(image.data)
        try {
            const rows: Row[] = []
            for (const box of boxes) {
                ctx.signal?.throwIfAborted()
                let canvas = cropBox(bitmap, box, { padding })

                // A crop taller than it is wide is almost always vertical text;
                // a quarter turn makes it readable to a horizontal recognizer.
                if (autoRotate && canvas.height > canvas.width) canvas = rotateQuarterTurn(canvas)

                rows.push({
                    ...row,
                    [boxCol]: box,
                    [outputCol]: createImage({
                        path: image.path,
                        resolution: image.resolution,
                        data: await encodeImage(canvas, `image/${imageType}` as never),
                        imageType,
                        width: canvas.width,
                        height: canvas.height,
                    }),
                })
            }
            return rows
        } finally {
            bitmap.close()
        }
    }

    protected async apply(): Promise<never> {
        throw new ImageError('unreachable: expand handles every row', this.name)
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }
}

/** Rotate 90 degrees counter-clockwise, swapping the canvas dimensions. */
function rotateQuarterTurn(source: OffscreenCanvas): OffscreenCanvas {
    const rotated = new OffscreenCanvas(source.height, source.width)
    const ctx = rotated.getContext('2d')
    if (!ctx) throw new ImageError('Failed to acquire a 2D context', 'ImageCropBoxes')
    ctx.translate(0, rotated.height)
    ctx.rotate(-Math.PI / 2)
    ctx.drawImage(source, 0, 0)
    return rotated
}
