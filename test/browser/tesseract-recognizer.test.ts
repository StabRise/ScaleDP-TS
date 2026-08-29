/**
 * The crop-based recognizer, which is what lets a *separate* detector's boxes
 * reach recognition at all. PaddleTextRecognizer detects internally in one pass,
 * so rotated boxes from a standalone detector never reached it before this.
 *
 * Tesseract itself is stubbed: what is worth pinning here is which boxes are
 * cropped, how, and what comes back -- not tesseract-wasm's accuracy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { context2d, createCanvas, encodeImage } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { TesseractRecognizer } from '../../src/ocr/tesseract-recognizer.js'
import { type Box, createBox } from '../../src/schemas/box.js'
import { createDetectorOutput } from '../../src/schemas/detector-output.js'
import { createDocument, type Document } from '../../src/schemas/document.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'

async function page(): Promise<ScaleDpImage> {
    const canvas = createCanvas(300, 200)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 200)
    return createImage({ data: await encodeImage(canvas), width: 300, height: 200 })
}

/**
 * tesseract-wasm is replaced at the module boundary. ESM exports are live
 * bindings and cannot be redefined with spyOn, so the module itself is mocked
 * and this holder is what each test scripts.
 */
interface FakeItem {
    text: string
    confidence: number
    rect: { left: number; top: number; right: number; bottom: number }
}

const fake = {
    words: [] as string[],
    confidence: 0.9,
    seen: [] as { width: number; height: number }[],
    call: 0,
    /** Set to script exact rects; otherwise `words` drives a single 10x10 box. */
    items: null as FakeItem[][] | null,
}

vi.mock('../../src/ocr/tesseract.js', () => ({
    getTesseractClient: async () => ({
        loadImage: async (image: ImageData) => {
            fake.seen.push({ width: image.width, height: image.height })
        },
        getTextBoxes: async () => {
            if (fake.items) return fake.items[fake.call++ % fake.items.length] ?? []
            const text = fake.words[fake.call++ % fake.words.length] ?? ''
            return text
                ? [
                      {
                          text,
                          confidence: fake.confidence,
                          rect: { left: 0, top: 0, right: 10, bottom: 10 },
                      },
                  ]
                : []
        },
    }),
}))

/** Script the words tesseract will "read", and start recording crops. */
function stubTesseract(words: string[], confidence = 0.9) {
    fake.words = words
    fake.confidence = confidence
    fake.items = null
    fake.seen = []
    fake.call = 0
    return fake.seen
}

/** Script the exact word rects tesseract reports, per crop. */
function stubTesseractItems(items: FakeItem[][]) {
    fake.items = items
    fake.seen = []
    fake.call = 0
}

function stubOrientation(stage: TesseractRecognizer, inverted: boolean) {
    vi.spyOn(stage, 'init').mockImplementation(async () => {
        ;(stage as unknown as { orientation: unknown }).orientation = {
            classify: async () => (inverted ? '180_degree' : '0_degree'),
            dispose: async () => undefined,
        }
    })
}

const run = async (stage: TesseractRecognizer, boxes: Box[], image: ScaleDpImage) =>
    (await new Pipeline([stage]).transform([{ image, boxes: createDetectorOutput({ bboxes: boxes }) }]))[0]
        ?.text as Document

describe('TesseractRecognizer', () => {
    beforeEach(() => stubTesseract([]))

    it('recognizes every box a detector found, rotated ones included', async () => {
        const seen = stubTesseract(['Hello', 'World'])
        const stage = new TesseractRecognizer({ detectLineOrientation: false })

        const document_ = await run(
            stage,
            [
                createBox({ x: 10, y: 10, width: 80, height: 20 }),
                createBox({ x: 10, y: 60, width: 80, height: 20, angle: 30 }),
            ],
            await page()
        )

        expect(seen).toHaveLength(2)
        expect(document_.text).toBe('Hello World')
        // Straightened to the box's own size, not its axis-aligned envelope --
        // which for a 30-degree box would be far larger. Padding adds once per
        // axis, matching ScaleDP's asymmetric Box.scale(factor, padding=5).
        expect(seen[1]).toEqual({ width: 85, height: 25 })
    })

    it('keeps each box geometry and attaches the recognized text', async () => {
        stubTesseract(['Invoice'])
        const stage = new TesseractRecognizer({ detectLineOrientation: false })
        const document_ = await run(
            stage,
            [createBox({ x: 25, y: 40, width: 100, height: 24, angle: 12 })],
            await page()
        )

        expect(document_.bboxes).toHaveLength(1)
        expect(document_.bboxes[0]).toMatchObject({ text: 'Invoice', x: 25, y: 40, angle: 12 })
    })

    it('drops words below the confidence threshold', async () => {
        stubTesseract(['faint'], 0.2)
        const stage = new TesseractRecognizer({ detectLineOrientation: false, scoreThreshold: 0.5 })
        const document_ = await run(stage, [createBox({ x: 0, y: 0, width: 50, height: 20 })], await page())
        expect(document_.bboxes).toHaveLength(0)
    })

    it('turns an inverted crop before reading it', async () => {
        stubTesseract(['flipped'])
        const stage = new TesseractRecognizer()
        stubOrientation(stage, true)

        const document_ = await run(stage, [createBox({ x: 0, y: 0, width: 60, height: 20 })], await page())
        expect(document_.text).toBe('flipped')
    })

    it('onlyRotated keeps just the rotated and inverted boxes', async () => {
        stubTesseract(['a', 'b'])
        const stage = new TesseractRecognizer({ detectLineOrientation: false, onlyRotated: true })

        const document_ = await run(
            stage,
            [
                createBox({ x: 0, y: 0, width: 50, height: 20 }),
                createBox({ x: 0, y: 40, width: 50, height: 20, angle: 25 }),
            ],
            await page()
        )
        expect(document_.bboxes).toHaveLength(1)
        expect(document_.bboxes[0]?.angle).toBe(25)
    })

    it('defaults onlyRotated off, unlike ScaleDP, so a plain run is not empty', async () => {
        stubTesseract(['a', 'b'])
        const stage = new TesseractRecognizer({ detectLineOrientation: false })
        const document_ = await run(
            stage,
            [
                createBox({ x: 0, y: 0, width: 50, height: 20 }),
                createBox({ x: 0, y: 40, width: 50, height: 20 }),
            ],
            await page()
        )
        expect(document_.bboxes).toHaveLength(2)
    })

    it('says which column is missing rather than silently reading nothing', async () => {
        const stage = new TesseractRecognizer({ detectLineOrientation: false })
        const rows = await new Pipeline([stage]).transform([{ image: await page() }])
        const document_ = rows[0]?.text as Document
        expect(document_.exception).toContain('No boxes in column "boxes"')
        expect(document_.exception).toContain('run a text detector before it')
    })

    it('reports an upstream failure rather than its own shape complaint', async () => {
        const stage = new TesseractRecognizer({ detectLineOrientation: false })
        const rows = await new Pipeline([stage]).transform([
            { image: createImage({ exception: 'PdfToImage exploded' }), boxes: createDetectorOutput({}) },
        ])
        expect((rows[0]?.text as Document | undefined)?.exception).toContain('PdfToImage exploded')
    })

    it('rebuilds the layout when keepFormatting is set', async () => {
        stubTesseract(['left', 'right'])
        const stage = new TesseractRecognizer({ detectLineOrientation: false, keepFormatting: true })
        const document_ = await run(
            stage,
            [
                createBox({ x: 10, y: 10, width: 40, height: 12 }),
                createBox({ x: 200, y: 10, width: 40, height: 12 }),
            ],
            await page()
        )
        // Layout-preserving output pads the gap rather than joining with one space.
        expect(document_.text).not.toBe('left right')
        expect(document_.text).toContain('left')
        expect(document_.text).toContain('right')
    })

    /*
     * Word-level output is a coordinate transform, and a wrong one still
     * produces plausible-looking boxes -- so these assert exact positions,
     * worked back by hand through the crop.
     */
    describe('boxLevel: word', () => {
        const word = (text: string, left: number, top: number, right: number, bottom: number) => ({
            text,
            confidence: 0.9,
            rect: { left, top, right, bottom },
        })

        it('defaults to one box per region', async () => {
            stubTesseract(['one two'])
            const stage = new TesseractRecognizer({ detectLineOrientation: false })
            const document_ = await run(
                stage,
                [createBox({ x: 100, y: 50, width: 200, height: 40 })],
                await page()
            )

            expect(stage.params.boxLevel).toBe('region')
            expect(document_.bboxes).toHaveLength(1)
            expect(document_.bboxes[0]).toMatchObject({ x: 100, y: 50, width: 200, height: 40 })
        })

        it('maps each word back out of an upright crop', async () => {
            // padding 5 puts the crop origin at (95, 45), so a word at (5, 3)
            // in the crop is at (100, 48) on the page.
            stubTesseractItems([[word('one', 5, 3, 25, 13), word('two', 40, 3, 70, 13)]])
            const stage = new TesseractRecognizer({ detectLineOrientation: false, boxLevel: 'word' })
            const document_ = await run(
                stage,
                [createBox({ x: 100, y: 50, width: 200, height: 40 })],
                await page()
            )

            expect(document_.bboxes).toHaveLength(2)
            expect(document_.bboxes[0]).toMatchObject({ text: 'one', x: 100, y: 48, width: 20, height: 10 })
            expect(document_.bboxes[1]).toMatchObject({ text: 'two', x: 135, y: 48, width: 30, height: 10 })
            expect(document_.text).toBe('one two')
        })

        it('undoes the 180-degree turn before mapping', async () => {
            // The crop is 205x45; turned back, (5,3)-(25,13) becomes
            // (180,32)-(200,42), which is (275,77) on the page.
            stubTesseractItems([[word('one', 5, 3, 25, 13)]])
            const stage = new TesseractRecognizer({ boxLevel: 'word' })
            stubOrientation(stage, true)
            const document_ = await run(
                stage,
                [createBox({ x: 100, y: 50, width: 200, height: 40 })],
                await page()
            )

            expect(document_.bboxes[0]).toMatchObject({ text: 'one', x: 275, y: 77, width: 20, height: 10 })
        })

        it('keeps a word inside its rotated region, at the region’s angle', async () => {
            stubTesseractItems([[word('one', 5, 3, 25, 13)]])
            const stage = new TesseractRecognizer({ detectLineOrientation: false, boxLevel: 'word' })
            const region = createBox({ x: 100, y: 50, width: 200, height: 40, angle: 30 })
            const document_ = await run(stage, [region], await page())

            const box = document_.bboxes[0] as NonNullable<(typeof document_.bboxes)[0]>
            // A rectangle is invariant under a half turn, so compare modulo 180.
            expect(Math.abs((((box.angle - region.angle) % 180) + 180) % 180)).toBeLessThan(1)
            // Its centre must land inside the region it was read from.
            const cx = box.x + box.width / 2
            const cy = box.y + box.height / 2
            const rcx = region.x + region.width / 2
            const rcy = region.y + region.height / 2
            expect(Math.hypot(cx - rcx, cy - rcy)).toBeLessThan(region.width / 2 + region.height / 2)
        })

        it('brings the coordinates back down through scaleFactor', async () => {
            // scaleFactor 2, padding 5: the crop starts at (195, 95) in scaled
            // page space, so a word at (5, 3)-(25, 13) is (200, 98)-(220, 108)
            // there, and half that on the page.
            stubTesseractItems([[word('one', 5, 3, 25, 13)]])
            const stage = new TesseractRecognizer({
                detectLineOrientation: false,
                boxLevel: 'word',
                scaleFactor: 2,
            })
            const document_ = await run(
                stage,
                [createBox({ x: 100, y: 50, width: 200, height: 40 })],
                await page()
            )

            expect(document_.bboxes[0]).toMatchObject({ text: 'one', x: 100, y: 49, width: 10, height: 5 })
        })

        it('reads the same words as region level, only cut finer', async () => {
            // The middle word is well below the threshold but the region's mean
            // is above it, so region level keeps all three. Word level has to
            // agree: `boxLevel` chooses how finely the result is cut up, not
            // what was read.
            const items = [
                [
                    word('good', 5, 3, 25, 13),
                    { ...word('faint', 40, 3, 70, 13), confidence: 0.1 },
                    word('also', 90, 3, 120, 13),
                ],
            ]
            const region = createBox({ x: 100, y: 50, width: 200, height: 40 })

            stubTesseractItems(items)
            const asRegion = await run(
                new TesseractRecognizer({ detectLineOrientation: false, scoreThreshold: 0.5 }),
                [region],
                await page()
            )
            stubTesseractItems(items)
            const asWords = await run(
                new TesseractRecognizer({
                    detectLineOrientation: false,
                    boxLevel: 'word',
                    scoreThreshold: 0.5,
                }),
                [region],
                await page()
            )

            expect(asRegion.text).toBe('good faint also')
            expect(asWords.bboxes.map((b) => b.text)).toEqual(['good', 'faint', 'also'])
            expect(asWords.text).toBe(asRegion.text)
            // The word's own confidence is still on its box, to filter on later.
            expect(asWords.bboxes[1]?.score).toBeCloseTo(0.1)
        })

        it('drops a region whose mean falls below the threshold, in both modes', async () => {
            const items = [[{ ...word('faint', 5, 3, 25, 13), confidence: 0.1 }]]
            const region = createBox({ x: 100, y: 50, width: 200, height: 40 })

            stubTesseractItems(items)
            const asRegion = await run(
                new TesseractRecognizer({ detectLineOrientation: false, scoreThreshold: 0.5 }),
                [region],
                await page()
            )
            stubTesseractItems(items)
            const asWords = await run(
                new TesseractRecognizer({
                    detectLineOrientation: false,
                    boxLevel: 'word',
                    scoreThreshold: 0.5,
                }),
                [region],
                await page()
            )

            expect(asRegion.bboxes).toHaveLength(0)
            expect(asWords.bboxes).toHaveLength(0)
        })
    })

    it('rejects an inputCols list that is not [image, boxes]', () => {
        expect(() => new TesseractRecognizer({ inputCols: ['image'] })).toThrow(/\[imageColumn, boxColumn\]/)
    })
})

describe('createDocument sanity', () => {
    it('defaults to an empty document', () => {
        expect(createDocument()).toMatchObject({ text: '', bboxes: [], exception: '' })
    })
})
