/** Port of `scaledp/schemas/Image.py`. */

export type ImageFormat = 'png' | 'webp' | 'jpeg'

export interface ScaleDpImage {
    path: string
    /** DPI the image was rendered at; 0 when unknown. */
    resolution: number
    /** Encoded image bytes (PNG unless `imageType` says otherwise). */
    data: Uint8Array
    imageType: ImageFormat
    exception: string
    height: number
    width: number
}

export function createImage(init: Partial<ScaleDpImage> = {}): ScaleDpImage {
    return {
        path: init.path ?? 'memory',
        resolution: init.resolution ?? 0,
        data: init.data ?? new Uint8Array(0),
        imageType: init.imageType ?? 'png',
        exception: init.exception ?? '',
        height: init.height ?? 0,
        width: init.width ?? 0,
    }
}
