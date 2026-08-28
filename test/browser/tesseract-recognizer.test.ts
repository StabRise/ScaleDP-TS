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
const fake = {
    words: [] as string[],
    confidence: 0.9,
    seen: [] as { width: number; height: number }[],
    call: 0,
}

vi.mock('../../src/ocr/tesseract.js', () => ({
    getTesseractClient: async () => ({
        loadImage: async (image: ImageData) => {
            fake.seen.push({ width: image.width, height: image.height })
        },
        getTextBoxes: async () => {
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
    fake.seen = []
    fake.call = 0
    return fake.seen
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
        expect((rows[0]?.text as Document).exception).toContain('PdfToImage exploded')
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

    it('rejects an inputCols list that is not [image, boxes]', () => {
        expect(() => new TesseractRecognizer({ inputCols: ['image'] })).toThrow(/\[imageColumn, boxColumn\]/)
    })
})

describe('createDocument sanity', () => {
    it('defaults to an empty document', () => {
        expect(createDocument()).toMatchObject({ text: '', bboxes: [], exception: '' })
    })
})
