/**
 * PaddleOCR recognition driven by someone else's boxes.
 *
 * ppu-paddle-ocr is stubbed at the module boundary: what is worth pinning here
 * is which crops we cut, how they are batched onto sheets, and how results are
 * matched back onto the boxes -- not PP-OCR's accuracy. The batching and the
 * matching are the two places this stage can silently go wrong, because
 * `RecognitionService.run` returns its results in reading order rather than the
 * order it was handed them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { context2d, createCanvas, encodeImage } from '../../src/core/image.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { PaddleRecognizer } from '../../src/ocr/paddle-recognizer.js'
import { type Box, createBox } from '../../src/schemas/box.js'
import { createDetectorOutput } from '../../src/schemas/detector-output.js'
import type { Document } from '../../src/schemas/document.js'
import { createImage, type ScaleDpImage } from '../../src/schemas/image.js'

async function page(marker = false): Promise<ScaleDpImage> {
    const canvas = createCanvas(300, 200)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 200)
    // A black square in the page's top-left corner only, so a crop that has been
    // turned 180 degrees can be told apart from one that has not.
    if (marker) {
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, 10, 10)
    }
    return createImage({ data: await encodeImage(canvas), width: 300, height: 200 })
}

interface PpuBox {
    x: number
    y: number
    width: number
    height: number
}

/**
 * ESM exports are live bindings and cannot be redefined with spyOn, so the
 * service module is mocked and this holder is what each test scripts.
 */
const fake = {
    /** One entry per `run()` call: the sheet size and the slots asked for. */
    calls: [] as { sheet: { width: number; height: number }; slots: PpuBox[] }[],
    /** The last sheet handed to `run`, for tests that check what was drawn. */
    sheets: [] as OffscreenCanvas[],
    words: [] as string[],
    confidence: 0.9,
    /** Per-word confidence, when a test needs them to differ. */
    scores: null as number[] | null,
    /** Return results in reverse, as ppu's reading-order sort may. */
    reverse: false,
    read: 0,
}

vi.mock('../../src/ocr/paddle-service.js', () => ({
    getPaddleRecognizer: async () => ({
        run: async (sheet: OffscreenCanvas, slots: PpuBox[]) => {
            fake.calls.push({
                sheet: { width: sheet.width, height: sheet.height },
                slots: slots.map((slot) => ({ ...slot })),
            })
            fake.sheets.push(sheet)
            const results = slots.map((slot) => {
                const index = fake.read++
                return {
                    text: fake.words[index % fake.words.length] ?? '',
                    box: slot,
                    confidence: fake.scores ? (fake.scores[index] ?? 0) : fake.confidence,
                }
            })
            return fake.reverse ? results.reverse() : results
        },
    }),
}))

/** Script the words Paddle will "read", and start recording sheets. */
function stubPaddle(
    words: string[],
    opts: { confidence?: number; scores?: number[]; reverse?: boolean } = {}
) {
    fake.calls = []
    fake.sheets = []
    fake.words = words
    fake.confidence = opts.confidence ?? 0.9
    fake.scores = opts.scores ?? null
    fake.reverse = opts.reverse ?? false
    fake.read = 0
    return fake.calls
}

/** Stand in for the ~9 MB orientation model, which init would otherwise fetch. */
function stubOrientation(stage: PaddleRecognizer, inverted: boolean) {
    const target = stage as unknown as { orientation: unknown }
    vi.spyOn(stage, 'init').mockImplementation(async () => {
        target.orientation = {
            classify: async () => (inverted ? '180_degree' : '0_degree'),
            dispose: async () => undefined,
        }
        ;(stage as unknown as { recognition: unknown }).recognition = await (
            await import('../../src/ocr/paddle-service.js')
        ).getPaddleRecognizer()
    })
}

/** The two opposite corners of a sheet, as 'black' or 'white'. */
function corners(sheet: OffscreenCanvas) {
    const ctx = context2d(sheet)
    const at = (x: number, y: number) =>
        (ctx.getImageData(x, y, 1, 1).data[0] as number) < 128 ? 'black' : 'white'
    return { topLeft: at(2, 2), bottomRight: at(sheet.width - 3, sheet.height - 3) }
}

const run = async (stage: PaddleRecognizer, boxes: Box[], image: ScaleDpImage) =>
    (await new Pipeline([stage]).transform([{ image, boxes: createDetectorOutput({ bboxes: boxes }) }]))[0]
        ?.text as Document

describe('PaddleRecognizer', () => {
    beforeEach(() => stubPaddle([]))

    it('reads every box a detector found, keeping each box own geometry', async () => {
        stubPaddle(['Hello', 'World'])
        const stage = new PaddleRecognizer()

        const document_ = await run(
            stage,
            [
                createBox({ x: 10, y: 10, width: 80, height: 20 }),
                createBox({ x: 10, y: 60, width: 80, height: 20, angle: 30 }),
            ],
            await page()
        )

        expect(document_.exception).toBe('')
        expect(document_.text).toBe('Hello World')
        expect(document_.bboxes).toHaveLength(2)
        // The detector's box is what comes back out -- angle included. ppu's own
        // Box has no angle, so anything it returned would have lost the skew.
        expect(document_.bboxes[1]?.angle).toBe(30)
        expect(document_.bboxes[1]?.text).toBe('World')
    })

    it('crops a rotated box straightened, not as its axis-aligned envelope', async () => {
        const calls = stubPaddle(['Skewed'])
        const stage = new PaddleRecognizer()

        await run(stage, [createBox({ x: 10, y: 60, width: 80, height: 20, angle: 30 })], await page())

        // 80x20 plus ScaleDP's asymmetric padding of 5, once per axis. The
        // envelope of a 30-degree box would be a good deal larger.
        expect(calls[0]?.slots[0]).toEqual({ x: 0, y: 0, width: 85, height: 25 })
    })

    it('stacks the crops onto one sheet, so a page costs one batch of inferences', async () => {
        const calls = stubPaddle(['a', 'b', 'c'])
        const stage = new PaddleRecognizer()

        await run(
            stage,
            [
                createBox({ x: 0, y: 0, width: 100, height: 20 }),
                createBox({ x: 0, y: 40, width: 60, height: 20 }),
                createBox({ x: 0, y: 80, width: 100, height: 30 }),
            ],
            await page()
        )

        expect(calls).toHaveLength(1)
        // As wide as the widest crop, as tall as all of them stacked. ppu re-cuts
        // each slot, so the blank width beside a narrow crop is never sampled.
        expect(calls[0]?.sheet).toEqual({ width: 105, height: 25 + 25 + 35 })
        expect(calls[0]?.slots).toEqual([
            { x: 0, y: 0, width: 105, height: 25 },
            { x: 0, y: 25, width: 65, height: 25 },
            { x: 0, y: 50, width: 105, height: 35 },
        ])
    })

    it('matches results back by slot, not by position in the returned array', async () => {
        stubPaddle(['first', 'second', 'third'], { reverse: true })
        const stage = new PaddleRecognizer()

        const document_ = await run(
            stage,
            [
                createBox({ x: 0, y: 0, width: 100, height: 20 }),
                createBox({ x: 0, y: 40, width: 100, height: 20 }),
                createBox({ x: 0, y: 80, width: 100, height: 20 }),
            ],
            await page()
        )

        // ppu sorts its results into reading order; each word must still land on
        // the box it was read from, whatever order they arrive in.
        expect(document_.bboxes.map((box) => box.text)).toEqual(['first', 'second', 'third'])
        expect(document_.bboxes.map((box) => box.y)).toEqual([0, 40, 80])
    })

    it('drops regions below scoreThreshold', async () => {
        stubPaddle(['keep', 'drop'], { scores: [0.9, 0.2] })
        const stage = new PaddleRecognizer({ scoreThreshold: 0.5 })

        const document_ = await run(
            stage,
            [
                createBox({ x: 0, y: 0, width: 100, height: 20 }),
                createBox({ x: 0, y: 40, width: 100, height: 20 }),
            ],
            await page()
        )

        // ppu's own minimumConfidence is pinned to 0 so it cannot filter behind
        // our back -- that would drop slots and desynchronise the mapping.
        expect(document_.text).toBe('keep')
    })

    it('reads a scaleFactor crop off the resized page, and reports the original box', async () => {
        const calls = stubPaddle(['Scaled'])
        const stage = new PaddleRecognizer({ scaleFactor: 2, padding: 0 })

        const document_ = await run(stage, [createBox({ x: 10, y: 20, width: 40, height: 10 })], await page())

        // ScaleDP resizes the page and scales the box to index into it, so the
        // model sees the line at 2x. The box reported back is the original --
        // scaling it too would move every region the caller handed in.
        expect(calls[0]?.slots[0]).toEqual({ x: 0, y: 0, width: 80, height: 20 })
        expect(document_.bboxes[0]).toMatchObject({ x: 10, y: 20, width: 40, height: 10 })
    })

    it('skips upright boxes when onlyRotated is on', async () => {
        const calls = stubPaddle(['Skewed'])
        const stage = new PaddleRecognizer({ onlyRotated: true })

        const document_ = await run(
            stage,
            [
                createBox({ x: 0, y: 0, width: 100, height: 20 }),
                createBox({ x: 0, y: 40, width: 100, height: 20, angle: 30 }),
            ],
            await page()
        )

        expect(calls[0]?.slots).toHaveLength(1)
        expect(document_.bboxes).toHaveLength(1)
        expect(document_.bboxes[0]?.angle).toBe(30)
    })

    it('turns an inverted crop when detectLineOrientation is on', async () => {
        stubPaddle(['Upside'])
        const box = createBox({ x: 0, y: 0, width: 100, height: 20 })
        const marked = await page(true)

        const upright = new PaddleRecognizer({ detectLineOrientation: true, padding: 0 })
        stubOrientation(upright, false)
        await run(upright, [box], marked)
        const notTurned = corners(fake.sheets[0] as OffscreenCanvas)

        stubPaddle(['Upside'])
        const flipped = new PaddleRecognizer({ detectLineOrientation: true, padding: 0 })
        stubOrientation(flipped, true)
        const document_ = await run(flipped, [box], marked)
        const turned = corners(fake.sheets[0] as OffscreenCanvas)

        expect(document_.text).toBe('Upside')
        // The marker sits in the crop's top-left; a 180 turn moves it to the
        // bottom-right. Paddle only turns crops taller than they are wide, so
        // without this pass an upside-down line is read upside down.
        expect(notTurned).toEqual({ topLeft: 'black', bottomRight: 'white' })
        expect(turned).toEqual({ topLeft: 'white', bottomRight: 'black' })
    })

    it('records a missing box column rather than throwing', async () => {
        stubPaddle(['unused'])

        const rows = await new Pipeline([new PaddleRecognizer()]).transform([{ image: await page() }])
        const document_ = rows[0]?.text as Document

        expect(document_.exception).toMatch(/No boxes in column "boxes"/)
        expect(document_.bboxes).toEqual([])
    })

    it('reports an upstream failure rather than the missing bytes it caused', async () => {
        stubPaddle(['unused'])

        const rows = await new Pipeline([new PaddleRecognizer()]).transform([
            { image: createImage({ exception: 'PdfToImage: boom' }), boxes: createDetectorOutput({}) },
        ])
        const document_ = rows[0]?.text as Document

        expect(document_.exception).toMatch(/PdfToImage: boom/)
    })

    it('starts a second sheet rather than one past the canvas ceiling', async () => {
        const calls = stubPaddle(['x'])
        // 35px per crop after padding; 300 of them overrun the 8192px ceiling.
        const boxes = Array.from({ length: 300 }, (_, i) => createBox({ x: 0, y: i, width: 100, height: 30 }))

        const document_ = await run(new PaddleRecognizer(), boxes, await page())

        expect(calls).toHaveLength(2)
        expect(calls.every((call) => call.sheet.height <= 8192)).toBe(true)
        // Split across sheets or not, every box is still read exactly once.
        expect(calls.reduce((total, call) => total + call.slots.length, 0)).toBe(300)
        expect(document_.bboxes).toHaveLength(300)
    })

    it('rejects a bad inputCols or an unknown preset at construction', () => {
        expect(() => new PaddleRecognizer({ inputCols: ['image'] })).toThrow(/inputCols must be/)
        expect(() => new PaddleRecognizer({ preset: 'nope' })).toThrow(/Unknown OCR preset/)
    })
})
