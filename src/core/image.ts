/**
 * Image helpers built on OffscreenCanvas/ImageBitmap only.
 *
 * Deliberately DOM-free: no `document.createElement`, no `HTMLImageElement`,
 * no `toDataURL`. That is what lets the whole pipeline -- OCR and detection
 * included -- run inside a worker.
 */

import type { Box } from '../schemas/box.js'
import { scaleBox } from '../schemas/box.js'
import { boxPoints, type Point } from './geometry.js'

export interface Size {
    width: number
    height: number
}

function assertCanvasSupport(): void {
    if (typeof OffscreenCanvas === 'undefined') {
        throw new Error('OffscreenCanvas is unavailable. scaledp requires a browser or worker context.')
    }
}

export function createCanvas(width: number, height: number): OffscreenCanvas {
    assertCanvasSupport()
    return new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
}

export function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Failed to acquire a 2D context')
    return ctx
}

export async function decodeImage(data: Uint8Array | Blob): Promise<ImageBitmap> {
    if (data instanceof Blob) return createImageBitmap(data)
    // Copy into a fresh ArrayBuffer: the view may be a slice of a larger (or
    // shared) buffer, and Blob only accepts a plain ArrayBuffer.
    const bytes = new Uint8Array(data.byteLength)
    bytes.set(data)
    return createImageBitmap(new Blob([bytes.buffer]))
}

export function toImageData(source: ImageBitmap | OffscreenCanvas): ImageData {
    if (source instanceof OffscreenCanvas) {
        return context2d(source).getImageData(0, 0, source.width, source.height)
    }
    const canvas = createCanvas(source.width, source.height)
    context2d(canvas).drawImage(source, 0, 0)
    return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height)
}

export function imageDataToCanvas(image: ImageData): OffscreenCanvas {
    const canvas = createCanvas(image.width, image.height)
    context2d(canvas).putImageData(image, 0, 0)
    return canvas
}

export async function encodeImage(
    source: ImageData | OffscreenCanvas,
    type: 'image/png' | 'image/webp' | 'image/jpeg' = 'image/png',
    quality?: number
): Promise<Uint8Array> {
    const canvas = source instanceof OffscreenCanvas ? source : imageDataToCanvas(source)
    const blob = await canvas.convertToBlob({ type, quality })
    return new Uint8Array(await blob.arrayBuffer())
}

/** Read the intrinsic size of encoded image bytes without keeping the bitmap. */
export async function probeImageSize(data: Uint8Array | Blob): Promise<Size> {
    const bitmap = await decodeImage(data)
    try {
        return { width: bitmap.width, height: bitmap.height }
    } finally {
        bitmap.close()
    }
}

export interface LetterboxResult {
    canvas: OffscreenCanvas
    /** Uniform scale applied to the source. */
    scale: number
    /** Size the source occupies inside the target canvas. */
    resized: Size
    /** Original source size. */
    source: Size
}

/**
 * Fit an image into `target` preserving aspect ratio.
 *
 * `padding: 'end'` pads bottom and right only, matching PaddleOCR's detection
 * preprocessing -- coordinates then restore by dividing by `scale`, with no
 * offset to subtract. `padding: 'center'` centres the image, matching the YOLO
 * preprocessing, where the pad offsets must be subtracted before unscaling.
 */
export function letterbox(
    source: ImageBitmap | OffscreenCanvas,
    target: Size,
    opts: { padding?: 'end' | 'center'; fill?: string } = {}
): LetterboxResult {
    const padding = opts.padding ?? 'end'
    const canvas = createCanvas(target.width, target.height)
    const ctx = context2d(canvas)

    ctx.fillStyle = opts.fill ?? '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const scale = Math.min(target.width / source.width, target.height / source.height)
    const width = Math.trunc(source.width * scale)
    const height = Math.trunc(source.height * scale)
    const dx = padding === 'center' ? Math.trunc((target.width - width) / 2) : 0
    const dy = padding === 'center' ? Math.trunc((target.height - height) / 2) : 0

    ctx.drawImage(source, dx, dy, width, height)
    return {
        canvas,
        scale,
        resized: { width, height },
        source: { width: source.width, height: source.height },
    }
}

/** Uniform resize by a scale factor. */
export function resize(source: ImageBitmap | OffscreenCanvas, factor: number): OffscreenCanvas {
    const canvas = createCanvas(source.width * factor, source.height * factor)
    context2d(canvas).drawImage(source, 0, 0, canvas.width, canvas.height)
    return canvas
}

/**
 * Crop a box out of an image, straightening it if it is rotated.
 *
 * Port of `TesseractRecognizer._prepare_box_for_ocr`. For upright boxes this is
 * a plain crop; for rotated ones it applies the affine transform that maps the
 * box's own corners onto the destination rectangle, which is what makes a
 * recognizer see level text.
 */
export function cropBox(
    source: ImageBitmap | OffscreenCanvas,
    box: Box,
    opts: { scaleFactor?: number; padding?: number } = {}
): OffscreenCanvas {
    const scaled = scaleBox(box, opts.scaleFactor ?? 1, opts.padding ?? 0)
    const width = Math.max(1, scaled.width)
    const height = Math.max(1, scaled.height)

    const canvas = createCanvas(width, height)
    const ctx = context2d(canvas)

    if (Math.abs(scaled.angle) < 3) {
        ctx.drawImage(source, scaled.x, scaled.y, width, height, 0, 0, width, height)
        return canvas
    }

    // cv2.boxPoints order is BL, TL, TR, BR. Mapping TL/TR/BL onto the
    // destination corners fixes the affine transform; the fourth corner
    // follows because the source really is a parallelogram.
    const centre: Point = [scaled.x + width / 2, scaled.y + height / 2]
    const [, tl, tr, br] = boxPoints({
        center: centre,
        size: [width, height],
        angle: scaled.angle,
    })
    const bl: Point = [tl[0] + (br[0] - tr[0]), tl[1] + (br[1] - tr[1])]

    // Solve for the affine matrix taking (tl, tr, bl) -> ((0,0), (w,0), (0,h)).
    const ex = [(tr[0] - tl[0]) / width, (tr[1] - tl[1]) / width]
    const ey = [(bl[0] - tl[0]) / height, (bl[1] - tl[1]) / height]
    const det = (ex[0] as number) * (ey[1] as number) - (ey[0] as number) * (ex[1] as number)
    if (Math.abs(det) < 1e-9) {
        ctx.drawImage(source, scaled.x, scaled.y, width, height, 0, 0, width, height)
        return canvas
    }

    const a = (ey[1] as number) / det
    const b = -(ex[1] as number) / det
    const c = -(ey[0] as number) / det
    const d = (ex[0] as number) / det
    ctx.setTransform(a, b, c, d, -(a * tl[0] + c * tl[1]), -(b * tl[0] + d * tl[1]))
    ctx.drawImage(source, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return canvas
}

/**
 * Build an NCHW float32 tensor from an image.
 *
 * `bgr` exists because ScaleDP's DBNet path converts RGB->BGR and never swaps
 * back, so the model is fed BGR channels against RGB ImageNet statistics.
 * Replicating that quirk is required for box parity.
 */
export function toNchwFloat32(
    image: ImageData,
    opts: { mean?: readonly number[]; std?: readonly number[]; scale?: number; bgr?: boolean } = {}
): Float32Array {
    const { width, height, data } = image
    const scale = opts.scale ?? 1 / 255
    const mean = opts.mean ?? [0, 0, 0]
    const std = opts.std ?? [1, 1, 1]
    const order = opts.bgr ? [2, 1, 0] : [0, 1, 2]

    const plane = width * height
    const out = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) {
            const value = (data[i * 4 + (order[c] as number)] as number) * scale
            out[c * plane + i] = (value - (mean[c] as number)) / (std[c] as number)
        }
    }
    return out
}

export const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const
export const IMAGENET_STD = [0.229, 0.224, 0.225] as const
