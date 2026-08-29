/**
 * ImageDrawBoxes and ImageCropBoxes need a real canvas.
 */
import { describe, expect, it } from 'vitest'
import { context2d, createCanvas, decodeImage, encodeImage, toImageData } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { createBox } from '../../src/schemas/box.js'
import { createDetectorOutput } from '../../src/schemas/detector-output.js'
import { createNerOutput } from '../../src/schemas/entity.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'
import { ImageCropBoxes } from '../../src/stages/image-crop-boxes.js'
import { ImageDrawBoxes } from '../../src/stages/image-draw-boxes.js'

async function whitePage(width = 200, height = 120): Promise<ScaleDpImage> {
    const canvas = createCanvas(width, height)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    return createImage({ data: await encodeImage(canvas), width, height })
}

/** Count pixels that are not white -- i.e. something was drawn. */
async function inkedPixels(image: ScaleDpImage): Promise<number> {
    const bitmap = await decodeImage(image.data)
    const { data } = toImageData(bitmap)
    bitmap.close()
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
        if ((data[i] as number) < 245 || (data[i + 1] as number) < 245 || (data[i + 2] as number) < 245) n++
    }
    return n
}

describe('ImageDrawBoxes', () => {
    it('draws detector boxes onto the page', async () => {
        const rows = await new Pipeline([new ImageDrawBoxes({ lineWidth: 3 })]).transform([
            {
                image: await whitePage(),
                boxes: createDetectorOutput({
                    bboxes: [createBox({ x: 20, y: 20, width: 60, height: 30, text: 'hi' })],
                }),
            },
        ])
        const out = rows[0]?.image_with_boxes as ScaleDpImage
        expect(out.exception).toBe('')
        expect(await inkedPixels(out)).toBeGreaterThan(100)
    })

    it('draws a rotated box as a polygon, not an upright rectangle', async () => {
        const page = await whitePage()
        const upright = await new Pipeline([new ImageDrawBoxes({ lineWidth: 2 })]).transform([
            {
                image: page,
                boxes: createDetectorOutput({ bboxes: [createBox({ x: 40, y: 30, width: 80, height: 20 })] }),
            },
        ])
        const rotated = await new Pipeline([new ImageDrawBoxes({ lineWidth: 2 })]).transform([
            {
                image: page,
                boxes: createDetectorOutput({
                    bboxes: [createBox({ x: 40, y: 30, width: 80, height: 20, angle: 30 })],
                }),
            },
        ])
        const a = await inkedPixels(upright[0]?.image_with_boxes as ScaleDpImage)
        const b = await inkedPixels(rotated[0]?.image_with_boxes as ScaleDpImage)
        // A rotated outline covers a different number of pixels than an
        // axis-aligned one of the same size.
        expect(b).not.toBe(a)
        expect(b).toBeGreaterThan(0)
    })

    it('accepts NER output and honours whiteList', async () => {
        const image = await whitePage()
        const ner = createNerOutput({
            entities: [
                {
                    entity_group: 'person',
                    score: 1,
                    word: 'x',
                    start: 0,
                    end: 1,
                    boxes: [createBox({ x: 10, y: 10, width: 40, height: 20 })],
                },
                {
                    entity_group: 'email',
                    score: 1,
                    word: 'y',
                    start: 2,
                    end: 3,
                    boxes: [createBox({ x: 100, y: 60, width: 40, height: 20 })],
                },
            ],
        })
        const all = await new Pipeline([
            new ImageDrawBoxes({ inputCols: ['image', 'ner'], lineWidth: 3 }),
        ]).transform([{ image, ner }])
        const one = await new Pipeline([
            new ImageDrawBoxes({ inputCols: ['image', 'ner'], lineWidth: 3, whiteList: ['person'] }),
        ]).transform([{ image, ner }])

        expect(await inkedPixels(one[0]?.image_with_boxes as ScaleDpImage)).toBeLessThan(
            await inkedPixels(all[0]?.image_with_boxes as ScaleDpImage)
        )
    })

    it('reports an upstream failure rather than its own shape complaint', async () => {
        const rows = await new Pipeline([new ImageDrawBoxes()]).transform([
            { image: createImage({ exception: 'PdfToImage exploded' }), boxes: createDetectorOutput({}) },
        ])
        expect((rows[0]?.image_with_boxes as ScaleDpImage | undefined)?.exception).toContain(
            'PdfToImage exploded'
        )
    })

    it('rejects an inputCols list without a box column', () => {
        expect(() => new ImageDrawBoxes({ inputCols: ['image'] })).toThrow(/at least one box column/)
    })
})

describe('ImageCropBoxes', () => {
    it('emits one row per box, sized to the box', async () => {
        const rows = await new Pipeline([new ImageCropBoxes({ autoRotate: false })]).transform([
            {
                image: await whitePage(),
                boxes: createDetectorOutput({
                    bboxes: [
                        createBox({ x: 10, y: 10, width: 40, height: 20 }),
                        createBox({ x: 60, y: 40, width: 30, height: 15 }),
                    ],
                }),
            },
        ])
        expect(rows).toHaveLength(2)
        expect(rows[0]?.cropped_image).toMatchObject({ width: 40, height: 20 })
        expect(rows[1]?.cropped_image).toMatchObject({ width: 30, height: 15 })
        // The originating box travels with each crop.
        expect(rows[0]?.box).toMatchObject({ x: 10, y: 10 })
    })

    it('rotates a portrait crop so text reads horizontally', async () => {
        const rows = await new Pipeline([new ImageCropBoxes({ autoRotate: true })]).transform([
            {
                image: await whitePage(),
                boxes: createDetectorOutput({ bboxes: [createBox({ x: 10, y: 10, width: 20, height: 60 })] }),
            },
        ])
        // 20x60 in, 60x20 out.
        expect(rows[0]?.cropped_image).toMatchObject({ width: 60, height: 20 })
    })

    it('honours the limit', async () => {
        const rows = await new Pipeline([new ImageCropBoxes({ limit: 1 })]).transform([
            {
                image: await whitePage(),
                boxes: createDetectorOutput({
                    bboxes: [
                        createBox({ x: 0, y: 0, width: 10, height: 10 }),
                        createBox({ x: 20, y: 0, width: 10, height: 10 }),
                    ],
                }),
            },
        ])
        expect(rows).toHaveLength(1)
    })

    it('fails on an empty box list unless returnEmpty is set', async () => {
        const input = [{ image: await whitePage(), boxes: createDetectorOutput({}) }]

        const failed = await new Pipeline([new ImageCropBoxes()]).transform(input)
        expect((failed[0]?.cropped_image as ScaleDpImage | undefined)?.exception).toContain(
            'No boxes to crop'
        )

        const passed = await new Pipeline([new ImageCropBoxes({ returnEmpty: true })]).transform(input)
        expect((passed[0]?.cropped_image as ScaleDpImage | undefined)?.exception).toBe('')
    })
})
