import { describe, expect, it } from 'vitest'
import { Pipeline, type Row } from '../../src/core/pipeline.js'
import {
    type ImagePlacement,
    type Matrix,
    NO_EMBEDDED_IMAGES,
    PdfMergeImageText,
} from '../../src/pdf/index.js'
import { createBox } from '../../src/schemas/box.js'
import { createDocument } from '../../src/schemas/document.js'

/** An image of `width x height` placed at `(x, y)` on the page, unrotated. */
function placement(x: number, y: number, width: number, height: number): ImagePlacement {
    const matrix: Matrix = [1, 0, 0, 1, x, y]
    return {
        id: 'img',
        width,
        height,
        box: createBox({ x, y, width, height }),
        matrix,
        effectiveResolution: 300,
        scaleFactor: 1,
    }
}

const word = (text: string, x: number, y: number) =>
    createBox({ text, x, y, width: 40, height: 10, score: 1 })

/** One page's rows: a text layer plus one row per embedded image. */
function pageRows(images: { placement: ImagePlacement | null; document: Row['x'] }[]): Row[] {
    const textLayer = createDocument({
        path: 'a.pdf',
        type: 'pdf',
        bboxes: [word('INVOICE', 100, 50)],
    })
    return images.map((image) => ({
        path: 'a.pdf',
        page: 0,
        document: textLayer,
        placement: image.placement,
        image_text: image.document,
    }))
}

const run = (rows: Row[], options = {}) => new PdfMergeImageText(options).transform(rows, { index: 0 })

describe('PdfMergeImageText', () => {
    it('reduces a page’s rows back to one', async () => {
        const rows = pageRows([
            {
                placement: placement(300, 300, 100, 100),
                document: createDocument({ bboxes: [word('Total', 0, 0)] }),
            },
            {
                placement: placement(300, 600, 100, 100),
                document: createDocument({ bboxes: [word('1,240.00', 0, 0)] }),
            },
        ])

        const out = await run(rows)
        expect(out).toHaveLength(1)
        expect(out[0]?.document).toMatchObject({ type: 'pdf+ocr' })
    })

    it('maps each image’s boxes onto the page through its placement', async () => {
        const rows = pageRows([
            {
                placement: placement(300, 400, 100, 100),
                document: createDocument({ bboxes: [word('Total', 10, 20)] }),
            },
        ])

        const document = (await run(rows))[0]?.document as ReturnType<typeof createDocument>
        const total = document.bboxes.find((b) => b.text === 'Total')
        expect(total).toMatchObject({ x: 310, y: 420 })
    })

    it('keeps pages apart', async () => {
        const rows = [
            ...pageRows([{ placement: null, document: createDocument() }]),
            { ...pageRows([{ placement: null, document: createDocument() }])[0], page: 1 },
        ] as Row[]

        expect(await run(rows)).toHaveLength(2)
    })

    it('passes a page with no images through as its text layer alone', async () => {
        // PdfEmbeddedImages says so on the image it emits, and a recognizer
        // faithfully reports that as its own failure. It is not the page's.
        const rows = pageRows([
            {
                placement: null,
                document: createDocument({
                    exception: `toCanvas: Upstream stage failed: ${NO_EMBEDDED_IMAGES}`,
                }),
            },
        ])

        const document = (await run(rows))[0]?.document as ReturnType<typeof createDocument>
        expect(document.exception).toBe('')
        expect(document.text).toBe('INVOICE')
        expect(document.type).toBe('pdf')
    })

    it('does not poison a page because one of its images failed', async () => {
        const rows = pageRows([
            {
                placement: null,
                document: createDocument({ exception: 'PaddleTextRecognizer: session died' }),
            },
            {
                placement: placement(300, 400, 100, 100),
                document: createDocument({ bboxes: [word('Total', 0, 0)] }),
            },
        ])

        const document = (await run(rows))[0]?.document as ReturnType<typeof createDocument>
        expect(document.exception).toBe('')
        expect(document.bboxes.map((b) => b.text)).toEqual(['INVOICE', 'Total'])
    })

    it('reports the failure when nothing at all could be read', async () => {
        const rows = pageRows([
            {
                placement: null,
                document: createDocument({ exception: 'PaddleTextRecognizer: session died' }),
            },
        ])
        for (const row of rows) row.document = createDocument({ path: 'a.pdf', type: 'pdf' })

        const document = (await run(rows))[0]?.document as ReturnType<typeof createDocument>
        expect(document.exception).toContain('session died')
    })

    it('gathers every image row’s evidence onto the merged row', async () => {
        // Reducing the rows would otherwise leave only the first picture, and
        // "this image contributed nothing" becomes impossible to investigate.
        const rows = pageRows([
            {
                placement: placement(300, 300, 100, 100),
                document: createDocument({ bboxes: [word('Total', 0, 0)] }),
            },
            { placement: placement(300, 600, 100, 100), document: createDocument() },
        ])
        rows.forEach((row, index) => {
            row.embedded = { id: index === 0 ? 'first' : 'second' }
        })

        const out = await run(rows)
        expect(out[0]?.embedded).toEqual([{ id: 'first' }, { id: 'second' }])
    })

    it('leaves a column every row shares alone', async () => {
        // The text layer is one object spread onto every row of the page, so it
        // is not per-image evidence and must not become an array of copies.
        const rows = pageRows([
            { placement: null, document: createDocument() },
            { placement: null, document: createDocument() },
        ])
        const shared = rows[0]?.document

        const out = await run(rows, { inputCols: ['text_layer', 'image_text'] })
        expect(out[0]?.document).not.toBeInstanceOf(Array)
        expect(rows[0]?.document).toBe(shared)
    })

    it('does not collect the pipeline’s own bookkeeping', async () => {
        // row_time is copied per row by design, so it differs on every one and
        // would otherwise come back as an array of meaningless timings.
        const rows = pageRows([
            { placement: null, document: createDocument() },
            { placement: null, document: createDocument() },
        ])
        rows.forEach((row, index) => {
            row.row_time = { stages: {}, total: index }
        })

        const out = await run(rows)
        expect(out[0]?.row_time).not.toBeInstanceOf(Array)
    })

    it('collects nothing when the page produced a single row', async () => {
        const rows = pageRows([{ placement: null, document: createDocument() }])
        for (const row of rows) row.embedded = { id: 'only' }

        const out = await run(rows)
        expect(out[0]?.embedded).toEqual({ id: 'only' })
    })

    it('rejects a strategy it does not know', () => {
        expect(() => new PdfMergeImageText({ strategy: 'best' as never })).toThrow(RangeError)
    })

    it('charges its time to the row, like every other stage', async () => {
        const out = await new Pipeline([new PdfMergeImageText()]).transform(
            pageRows([{ placement: null, document: createDocument() }])
        )
        const timing = out[0]?.row_time as { stages: Record<string, number> } | undefined
        expect(timing?.stages).toHaveProperty('PdfMergeImageText')
    })
})
