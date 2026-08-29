/**
 * Port of `scaledp/image/DataToImage.py`: raw bytes -> an `Image` record.
 *
 * Dimensions are probed without retaining the decoded bitmap, mirroring
 * Python's use of `imagesize.get` rather than a full PIL decode.
 */

import { ImageError } from '../core/errors.js'
import { probeImageSize } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import { createImage, type ImageFormat, type ScaleDpImage } from '../schemas/image.js'

export interface DataToImageParams extends BaseStageParams {
    /** Encoding recorded on the output; the bytes are passed through unchanged. */
    imageType: ImageFormat
    /** DPI to record when the row carries no `resolution` field. */
    resolution: number
}

export const DATA_TO_IMAGE_DEFAULTS: DataToImageParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'content',
    outputCol: 'image',
    imageType: 'png' as ImageFormat,
    resolution: 0,
})

export class DataToImage extends Stage<DataToImageParams> {
    readonly name = 'DataToImage'

    constructor(options: Partial<DataToImageParams> = {}) {
        super(resolveParams(DATA_TO_IMAGE_DEFAULTS, options))
    }

    protected async apply(input: unknown, row: Row): Promise<ScaleDpImage> {
        const data = toBytes(input)
        if (data.byteLength === 0) {
            throw new ImageError('Empty image data', this.name)
        }
        const { width, height } = await probeImageSize(data)
        return createImage({
            path: String(row[this.params.pathCol] ?? 'memory'),
            resolution: Number(row.resolution ?? this.params.resolution) || 0,
            data,
            imageType: this.params.imageType,
            width,
            height,
        })
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }
}

/** Coerce any accepted binary representation into bytes. */
export function toBytes(input: unknown): Uint8Array {
    if (input instanceof Uint8Array) return input
    if (input instanceof ArrayBuffer) return new Uint8Array(input)
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    }
    throw new ImageError(`Expected binary image data, received ${typeof input}`, 'toBytes')
}
