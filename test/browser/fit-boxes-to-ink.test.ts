/**
 * FitBoxesToInk end to end: a real PNG decoded through a real canvas, boxes in
 * both shapes it accepts, and the failure paths.
 */
import { describe, expect, it } from 'vitest'
import { NO_EMBEDDED_IMAGES } from '../../src/core/errors.js'
import { context2d, createCanvas, encodeImage } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { createBox } from '../../src/schemas/box.js'
import { createDetectorOutput, type DetectorOutput } from '../../src/schemas/detector-output.js'
import { createDocument, type Document } from '../../src/schemas/document.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'
import { FitBoxesToInk } from '../../src/stages/fit-boxes-to-ink.js'

/** "reya" as solid letters, with an "F" standing 4px apart before it. */
async function handwriting(): Promise<ScaleDpImage> {
    const canvas = createCanvas(300, 200)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 200)
    ctx.fillStyle = '#000000'
    for (const x of [100, 114, 128, 142]) ctx.fillRect(x, 100, 10, 30)
    ctx.fillRect(84, 96, 12, 34)
    return createImage({ data: await encodeImage(canvas), width: 300, height: 200 })
}

const clipped = () => createBox({ text: 'reya', x: 100, y: 100, width: 52, height: 30, score: 1 })

describe('FitBoxesToInk', () => {
    it('grows a detector box to the capital it missed', async () => {
        const stage = new FitBoxesToInk({ inputCols: ['image', 'detected'], outputCol: 'detected' })
        const [row] = await new Pipeline([stage]).transform([
            { image: await handwriting(), detected: createDetectorOutput({ bboxes: [clipped()] }) },
        ])
        const fitted = (row?.detected as DetectorOutput | undefined)?.bboxes[0]
        expect(fitted).toMatchObject({ text: 'reya', x: 84, y: 96 })
        expect((fitted?.x ?? 0) + (fitted?.width ?? 0)).toBe(152)
    })

    it('fits a Document in place and keeps its text', async () => {
        const stage = new FitBoxesToInk({ inputCols: ['image', 'document'], outputCol: 'document' })
        const [row] = await new Pipeline([stage]).transform([
            { image: await handwriting(), document: createDocument({ text: 'reya', bboxes: [clipped()] }) },
        ])
        const document = row?.document as Document
        expect(document.text).toBe('reya')
        expect(document.bboxes[0]?.x).toBe(84)
    })

    it('passes a skipped page through as a skip, boxes untouched', async () => {
        const stage = new FitBoxesToInk({ inputCols: ['image', 'detected'], outputCol: 'detected' })
        const [row] = await new Pipeline([stage]).transform([
            {
                image: createImage({ exception: NO_EMBEDDED_IMAGES }),
                detected: createDetectorOutput({ bboxes: [clipped()] }),
            },
        ])
        const detected = row?.detected as DetectorOutput
        expect(detected.exception).toBe(NO_EMBEDDED_IMAGES)
        expect(detected.bboxes[0]?.x).toBe(100)
    })

    it('records a missing box column without throwing', async () => {
        const stage = new FitBoxesToInk({ inputCols: ['image', 'nowhere'], outputCol: 'nowhere' })
        const [row] = await new Pipeline([stage]).transform([{ image: await handwriting() }])
        expect((row?.nowhere as Document | undefined)?.exception).toMatch(/Expected boxes in "nowhere"/)
    })
})
