/**
 * The orientation stage needs a real canvas, and the flip geometry is the part
 * worth pinning down: turning a region in place must leave the box's
 * coordinates untouched, or every downstream stage is off.
 */
import { describe, expect, it, vi } from 'vitest'
import { context2d, createCanvas, decodeImage, encodeImage, toImageData } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import type { LineOrientation } from '../../src/ocr/line-orientation.js'
import { LineOrientationDetector } from '../../src/ocr/line-orientation-stage.js'
import { createBox } from '../../src/schemas/box.js'
import { createDetectorOutput } from '../../src/schemas/detector-output.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'

/**
 * A page with a marker in one corner of a known box, so a 180-degree turn of
 * that box moves the marker to the opposite corner and nowhere else.
 */
async function pageWithMarker(): Promise<ScaleDpImage> {
    const canvas = createCanvas(200, 120)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 120)
    // Box occupies (20,20)-(120,60). Marker in its top-left 10x10.
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(20, 20, 10, 10)
    return createImage({ data: await encodeImage(canvas), width: 200, height: 120 })
}

const MARKED_BOX = createBox({ x: 20, y: 20, width: 100, height: 40 })

async function pixelAt(image: ScaleDpImage, x: number, y: number) {
    const bitmap = await decodeImage(image.data)
    const data = toImageData(bitmap).data
    bitmap.close()
    const i = (y * image.width + x) * 4
    return [data[i], data[i + 1], data[i + 2]]
}

/** Force the classifier's verdict so the geometry can be tested on its own. */
function stubClassifier(stage: LineOrientationDetector, verdict: LineOrientation) {
    const inner = stage as unknown as { classifier: unknown; init(): Promise<void> }
    vi.spyOn(stage, 'init').mockImplementation(async () => {
        inner.classifier = { classify: async () => verdict, dispose: async () => undefined }
    })
}

describe('LineOrientationDetector', () => {
    it('turns an inverted region in place, leaving the box coordinates valid', async () => {
        // onlyRotated defaults to true; this test is about the flip geometry,
        // not the gating, so classify the upright box too.
        const stage = new LineOrientationDetector({ onlyRotated: false })
        stubClassifier(stage, '180_degree')

        const rows = await new Pipeline([stage]).transform([
            { image: await pageWithMarker(), boxes: createDetectorOutput({ bboxes: [MARKED_BOX] }) },
        ])
        const out = rows[0]?.oriented as ScaleDpImage

        // The marker started at the box's top-left and must end at its
        // bottom-right, still inside the same rectangle.
        expect(await pixelAt(out, 24, 24)).toEqual([255, 255, 255])
        expect(await pixelAt(out, 115, 55)).toEqual([255, 0, 0])
        // Same page size, so no downstream coordinate shift.
        expect(out.width).toBe(200)
        expect(out.height).toBe(120)
    })

    it('leaves the page untouched when nothing is inverted', async () => {
        const stage = new LineOrientationDetector({ onlyRotated: false })
        stubClassifier(stage, '0_degree')
        const original = await pageWithMarker()

        const rows = await new Pipeline([stage]).transform([
            { image: original, boxes: createDetectorOutput({ bboxes: [MARKED_BOX] }) },
        ])
        // Handed straight through rather than re-encoded to an identical image.
        expect(rows[0]?.oriented).toBe(original)
        expect(rows[0]?.orientations).toEqual(['0_degree'])
    })

    it('classifies without correcting when correct is off', async () => {
        const stage = new LineOrientationDetector({ correct: false, onlyRotated: false })
        stubClassifier(stage, '180_degree')
        const original = await pageWithMarker()

        const rows = await new Pipeline([stage]).transform([
            { image: original, boxes: createDetectorOutput({ bboxes: [MARKED_BOX] }) },
        ])
        expect(rows[0]?.oriented).toBe(original)
        expect(rows[0]?.orientations).toEqual(['180_degree'])
    })

    it('reports one orientation per box', async () => {
        const stage = new LineOrientationDetector({ correct: false, onlyRotated: false })
        stubClassifier(stage, '0_degree')

        const rows = await new Pipeline([stage]).transform([
            {
                image: await pageWithMarker(),
                boxes: createDetectorOutput({
                    bboxes: [MARKED_BOX, createBox({ x: 10, y: 80, width: 60, height: 20 })],
                }),
            },
        ])
        expect(rows[0]?.orientations).toHaveLength(2)
    })

    it('skips upright boxes when onlyRotated is set', async () => {
        const stage = new LineOrientationDetector({ onlyRotated: true, correct: false })
        const classify = vi.fn(async () => '0_degree' as LineOrientation)
        vi.spyOn(stage, 'init').mockImplementation(async () => {
            ;(stage as unknown as { classifier: unknown }).classifier = {
                classify,
                dispose: async () => undefined,
            }
        })

        await new Pipeline([stage]).transform([
            {
                image: await pageWithMarker(),
                boxes: createDetectorOutput({
                    bboxes: [MARKED_BOX, createBox({ x: 10, y: 80, width: 60, height: 20, angle: 45 })],
                }),
            },
        ])
        // Only the rotated box reaches the classifier; both still get a label.
        expect(classify).toHaveBeenCalledTimes(1)
    })

    it('defaults to classifying only rotated boxes, as ScaleDP does', async () => {
        const stage = new LineOrientationDetector()
        const classify = vi.fn(async () => '0_degree' as LineOrientation)
        vi.spyOn(stage, 'init').mockImplementation(async () => {
            ;(stage as unknown as { classifier: unknown }).classifier = {
                classify,
                dispose: async () => undefined,
            }
        })

        await new Pipeline([stage]).transform([
            { image: await pageWithMarker(), boxes: createDetectorOutput({ bboxes: [MARKED_BOX] }) },
        ])
        // The classifier has a real false-positive rate, so an upright page
        // should not be run through it by default.
        expect(classify).not.toHaveBeenCalled()
    })

    it('reports an upstream failure rather than its own shape complaint', async () => {
        const rows = await new Pipeline([new LineOrientationDetector()]).transform([
            { image: createImage({ exception: 'PdfToImage exploded' }), boxes: createDetectorOutput({}) },
        ])
        expect((rows[0]?.oriented as ScaleDpImage | undefined)?.exception).toContain('PdfToImage exploded')
    })

    it('rejects an inputCols list that is not [image, boxes]', () => {
        expect(() => new LineOrientationDetector({ inputCols: ['image'] })).toThrow(
            /\[imageColumn, boxColumn\]/
        )
    })
})
