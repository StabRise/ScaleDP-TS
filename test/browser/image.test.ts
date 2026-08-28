/**
 * Image utilities need a real browser: OffscreenCanvas, ImageBitmap and
 * createImageBitmap have no usable jsdom equivalent.
 */
import { describe, expect, it } from 'vitest'
import {
    context2d,
    createCanvas,
    cropBox,
    decodeImage,
    encodeImage,
    IMAGENET_MEAN,
    IMAGENET_STD,
    imageDataToCanvas,
    letterbox,
    probeImageSize,
    resize,
    toImageData,
    toNchwFloat32,
} from '../../src/core/image.js'
import { createBox } from '../../src/schemas/box.js'

/** A solid-colour canvas, optionally with a differently coloured patch. */
function paint(
    width: number,
    height: number,
    fill = '#ff0000',
    patch?: { x: number; y: number; w: number; h: number; color: string }
): OffscreenCanvas {
    const canvas = createCanvas(width, height)
    const ctx = context2d(canvas)
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, width, height)
    if (patch) {
        ctx.fillStyle = patch.color
        ctx.fillRect(patch.x, patch.y, patch.w, patch.h)
    }
    return canvas
}

function pixelAt(image: ImageData, x: number, y: number): [number, number, number] {
    const i = (y * image.width + x) * 4
    return [image.data[i] as number, image.data[i + 1] as number, image.data[i + 2] as number]
}

describe('canvas helpers', () => {
    it('clamps canvas dimensions to at least 1px', () => {
        const canvas = createCanvas(0, -5)
        expect(canvas.width).toBe(1)
        expect(canvas.height).toBe(1)
    })

    it('round-trips ImageData through a canvas', () => {
        const original = toImageData(paint(4, 3, '#00ff00'))
        const restored = toImageData(imageDataToCanvas(original))
        expect(restored.width).toBe(4)
        expect(pixelAt(restored, 0, 0)).toEqual([0, 255, 0])
    })
})

describe('encode and decode', () => {
    it('round-trips through PNG bytes', async () => {
        const bytes = await encodeImage(paint(8, 6, '#0000ff'))
        expect(bytes.byteLength).toBeGreaterThan(0)

        const bitmap = await decodeImage(bytes)
        expect(bitmap.width).toBe(8)
        expect(bitmap.height).toBe(6)
        expect(pixelAt(toImageData(bitmap), 0, 0)).toEqual([0, 0, 255])
        bitmap.close()
    })

    it('probes size without leaking the decoded bitmap', async () => {
        const bytes = await encodeImage(paint(37, 19))
        expect(await probeImageSize(bytes)).toEqual({ width: 37, height: 19 })
    })

    it('decodes a Uint8Array view over a larger buffer', async () => {
        const bytes = await encodeImage(paint(4, 4))
        const backing = new Uint8Array(bytes.byteLength + 16)
        backing.set(bytes, 8)
        const view = backing.subarray(8, 8 + bytes.byteLength)

        const bitmap = await decodeImage(view)
        expect(bitmap.width).toBe(4)
        bitmap.close()
    })
})

describe('letterbox', () => {
    it('preserves aspect ratio and pads bottom-right only', () => {
        // 200x100 into 100x100 -> scaled to 100x50, with 50px of white below.
        const fitted = letterbox(paint(200, 100, '#ff0000'), { width: 100, height: 100 })
        expect(fitted.scale).toBeCloseTo(0.5, 6)
        expect(fitted.resized).toEqual({ width: 100, height: 50 })

        const image = toImageData(fitted.canvas)
        expect(pixelAt(image, 0, 0)).toEqual([255, 0, 0])
        // Nothing is padded at the top or left, which is why coordinates
        // restore by dividing by the scale with no offset.
        expect(pixelAt(image, 50, 75)).toEqual([255, 255, 255])
    })

    it('centres the image when asked, as YOLO expects', () => {
        const fitted = letterbox(
            paint(200, 100, '#ff0000'),
            { width: 100, height: 100 },
            {
                padding: 'center',
            }
        )
        const image = toImageData(fitted.canvas)
        // 50px tall content centred in 100px leaves 25px of white above.
        expect(pixelAt(image, 50, 5)).toEqual([255, 255, 255])
        expect(pixelAt(image, 50, 50)).toEqual([255, 0, 0])
        expect(pixelAt(image, 50, 95)).toEqual([255, 255, 255])
    })

    it('honours the fill colour', () => {
        const fitted = letterbox(paint(200, 100), { width: 100, height: 100 }, { fill: '#000000' })
        expect(pixelAt(toImageData(fitted.canvas), 50, 90)).toEqual([0, 0, 0])
    })
})

describe('resize', () => {
    it('scales by a factor', () => {
        const scaled = resize(paint(40, 20), 2)
        expect(scaled.width).toBe(80)
        expect(scaled.height).toBe(40)
    })
})

describe('cropBox', () => {
    const source = paint(200, 100, '#ffffff', { x: 50, y: 20, w: 40, h: 30, color: '#ff0000' })

    it('crops an upright box', () => {
        const crop = cropBox(source, createBox({ x: 50, y: 20, width: 40, height: 30 }))
        expect(crop.width).toBe(40)
        expect(crop.height).toBe(30)
        expect(pixelAt(toImageData(crop), 20, 15)).toEqual([255, 0, 0])
    })

    it('applies scaleFactor and padding', () => {
        const crop = cropBox(source, createBox({ x: 50, y: 20, width: 40, height: 30 }), {
            scaleFactor: 1,
            padding: 5,
        })
        // Padding is asymmetric, matching Python: the origin moves back by 5 and
        // the size grows by 5, so the box gains room on its left and top only.
        expect(crop.width).toBe(45)
        expect(crop.height).toBe(35)
    })

    it('straightens a rotated box instead of taking its envelope', () => {
        const rotated = createBox({ x: 50, y: 20, width: 40, height: 30, angle: 30 })
        const crop = cropBox(source, rotated)
        // Output is the box's own size, not the axis-aligned envelope, which
        // would be larger for a rotated rect.
        expect(crop.width).toBe(40)
        expect(crop.height).toBe(30)
    })

    it('never returns a zero-sized canvas', () => {
        const crop = cropBox(source, createBox({ x: 0, y: 0, width: 0, height: 0 }))
        expect(crop.width).toBeGreaterThanOrEqual(1)
        expect(crop.height).toBeGreaterThanOrEqual(1)
    })
})

describe('toNchwFloat32', () => {
    const image = toImageData(paint(2, 1, '#ff8000'))

    it('lays channels out plane-major with /255 scaling', () => {
        const tensor = toNchwFloat32(image)
        expect(tensor.length).toBe(3 * 2)
        // Plane 0 is red for every pixel, plane 1 green, plane 2 blue.
        expect(tensor[0]).toBeCloseTo(1, 5)
        expect(tensor[2]).toBeCloseTo(128 / 255, 2)
        expect(tensor[4]).toBeCloseTo(0, 5)
    })

    it('swaps channels for bgr, which the DBNet path relies on', () => {
        const rgb = toNchwFloat32(image)
        const bgr = toNchwFloat32(image, { bgr: true })
        // First plane becomes blue, last becomes red.
        expect(bgr[0]).toBeCloseTo(rgb[4] as number, 6)
        expect(bgr[4]).toBeCloseTo(rgb[0] as number, 6)
    })

    it('applies mean/std normalisation', () => {
        const tensor = toNchwFloat32(image, { mean: IMAGENET_MEAN, std: IMAGENET_STD })
        expect(tensor[0]).toBeCloseTo((1 - IMAGENET_MEAN[0]) / IMAGENET_STD[0], 4)
    })
})
