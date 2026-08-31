/**
 * PaddleOCR's own detect-then-read pass, and the word cutting layered over it.
 *
 * ppu-paddle-ocr is stubbed at the module boundary: what is pinned here is which
 * of its two entry points the stage uses for each `boxLevel`, and that a line
 * really does come back cut into words. PP-OCR's accuracy is not under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { context2d, createCanvas, encodeImage } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { PaddleTextRecognizer } from '../../src/ocr/paddle.js'
import type { Document } from '../../src/schemas/document.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'

interface PpuBox {
    x: number
    y: number
    width: number
    height: number
}

const LINE: PpuBox = { x: 20, y: 40, width: 200, height: 40 }

const fake = {
    /** Regions `detect()` reports. */
    boxes: [LINE] as PpuBox[],
    /** Text `recognize()` reports, one entry per region. */
    regionText: ['Hello World'],
    /** Line readings `run()` reports, one per crop handed over. */
    words: ['Hello World'],
    confidence: 0.9,
    scores: null as number[] | null,
    detects: 0,
    recognizes: [] as unknown[],
    /** Slot counts per `run()` call: how many crops were read. */
    runs: [] as number[],
    read: 0,
}

vi.mock('../../src/ocr/paddle-service.js', () => ({
    getPaddleService: async () => ({
        detect: async () => {
            fake.detects++
            return { boxes: fake.boxes }
        },
        recognize: async (_canvas: unknown, options: unknown) => {
            fake.recognizes.push(options)
            return {
                results: fake.boxes.map((box, i) => ({
                    box,
                    text: fake.regionText[i] ?? '',
                    confidence: fake.scores ? (fake.scores[i] ?? 0) : fake.confidence,
                })),
            }
        },
    }),
    getPaddleRecognizer: async () => ({
        run: async (_sheet: OffscreenCanvas, slots: PpuBox[]) => {
            fake.runs.push(slots.length)
            return slots.map((slot) => {
                const index = fake.read++
                return {
                    text: fake.words[index % fake.words.length] ?? '',
                    box: slot,
                    confidence: fake.scores ? (fake.scores[index] ?? 0) : fake.confidence,
                }
            })
        },
    }),
}))

/**
 * A page with two inked blocks inside `LINE`, separated by a gap wider than the
 * line is tall -- so `wordSpans` has something real to cut on.
 */
async function page(): Promise<ScaleDpImage> {
    const canvas = createCanvas(300, 200)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 200)
    ctx.fillStyle = '#000000'
    ctx.fillRect(25, 50, 60, 20)
    ctx.fillRect(160, 50, 55, 20)
    return createImage({ data: await encodeImage(canvas), width: 300, height: 200 })
}

const run = async (stage: PaddleTextRecognizer, image: ScaleDpImage) =>
    (await new Pipeline([stage]).transform([{ image }]))[0]?.text as Document

beforeEach(() => {
    fake.boxes = [LINE]
    fake.regionText = ['Hello World']
    fake.words = ['Hello World']
    fake.confidence = 0.9
    fake.scores = null
    fake.detects = 0
    fake.recognizes = []
    fake.runs = []
    fake.read = 0
})

describe('PaddleTextRecognizer', () => {
    it('defaults to word boxes, like every other recognizer here', async () => {
        const stage = new PaddleTextRecognizer()
        expect(stage.params.boxLevel).toBe('word')

        const document_ = await run(stage, await page())

        expect(document_.exception).toBe('')
        expect(document_.bboxes.map((box) => box.text)).toEqual(['Hello', 'World'])
        // Detection only, then one inference for the whole line: the words are
        // split out of what the model returned, not read separately.
        expect(fake.detects).toBe(1)
        expect(fake.recognizes).toEqual([])
        expect(fake.runs).toEqual([1])
    })

    it('puts each word where it sits on the page', async () => {
        const document_ = await run(new PaddleTextRecognizer(), await page())
        const [first, second] = document_.bboxes

        // Inside the detected line, and apart along it rather than stacked.
        for (const box of document_.bboxes) {
            expect(box.y).toBeGreaterThanOrEqual(LINE.y)
            expect(box.y + box.height).toBeLessThanOrEqual(LINE.y + LINE.height + 1)
        }
        expect((second?.x ?? 0) - (first?.x ?? 0)).toBeGreaterThan(60)
        // Each hugs its own ink rather than spanning the whole line.
        expect(first?.width ?? 0).toBeLessThan(LINE.width / 2)
    })

    it('keeps one box per line when boxLevel is region', async () => {
        const document_ = await run(new PaddleTextRecognizer({ boxLevel: 'region' }), await page())

        expect(document_.bboxes.map((box) => box.text)).toEqual(['Hello World'])
        // The combined pass, and nothing cut.
        expect(fake.recognizes).toHaveLength(1)
        expect(fake.detects).toBe(0)
        expect(fake.runs).toEqual([])
    })

    it('passes strategy to the combined pass, which is where it applies', async () => {
        await run(new PaddleTextRecognizer({ boxLevel: 'region', strategy: 'per-line' }), await page())

        expect(fake.recognizes[0]).toMatchObject({ strategy: 'per-line', noCache: true })
    })

    it('drops a line below scoreThreshold, words and all', async () => {
        // A word inherits its line's confidence: the model scored the line, not
        // its parts, so the threshold acts on lines.
        fake.boxes = [LINE, { x: 20, y: 120, width: 200, height: 40 }]
        fake.words = ['Hello World', 'Faint Line']
        fake.scores = [0.9, 0.2]

        const document_ = await run(new PaddleTextRecognizer({ scoreThreshold: 0.5 }), await page())

        expect(document_.bboxes.map((box) => box.text)).toEqual(['Hello', 'World'])
    })

    it('drops regions below scoreThreshold too', async () => {
        fake.scores = [0.2]
        const document_ = await run(
            new PaddleTextRecognizer({ boxLevel: 'region', scoreThreshold: 0.5 }),
            await page()
        )

        expect(document_.bboxes).toEqual([])
    })

    it('records a missing image and lets the pipeline finish', async () => {
        const rows = await new Pipeline([new PaddleTextRecognizer()]).transform([{ image: null }])

        expect(rows).toHaveLength(1)
        const document_ = rows[0]?.text as Document
        expect(document_.exception).toContain('decoded bytes')
        expect(document_.bboxes).toEqual([])
    })

    it('surfaces an upstream failure rather than complaining about the shape', async () => {
        const document_ = await run(
            new PaddleTextRecognizer(),
            createImage({ exception: 'PdfToImage: no pages' })
        )

        expect(document_.exception).toContain('PdfToImage: no pages')
        expect(document_.exception).not.toContain('decoded bytes')
    })
})
