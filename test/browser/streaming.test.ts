/**
 * One pipeline, streamed by page, against real pdf.js and a real model.
 *
 * What it pins: a page with a usable text layer never reaches the OCR stages,
 * so a document whose pages all have one never loads an OCR model; several
 * pages in flight over one shared pdf.js document work; and page order
 * returns what stage order does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure } from '../../src/core/config.js'
import { EXECUTION_TIME_COL, Pipeline, ROW_TIME_COL, type Row } from '../../src/core/pipeline.js'
import type { PipelineEvent } from '../../src/core/run.js'
import { DbnetOnnxDetector, PaddleTextRecognizer } from '../../src/ocr/index.js'
import {
    PdfEmbeddedImages,
    PdfMergeImageText,
    PdfToDocument,
    PdfToImage,
    usableTextLayer,
} from '../../src/pdf/index.js'
import type { Document } from '../../src/schemas/document.js'

configure({ pdf: { workerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs' } })

afterEach(() => vi.restoreAllMocks())

/** A minimal PDF, one page per entry; an empty string is a page with no text at all. */
function makePdf(pages: string[]): Uint8Array {
    const objects: string[] = []
    const add = (body: string) => objects.push(body)
    add('<< /Type /Catalog /Pages 2 0 R >>')
    const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
    add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    pages.forEach((text, i) => {
        const stream = text ? `BT /F1 24 Tf 72 700 Td (${text}) Tj ET` : ''
        add(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
                `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
        )
        add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    })

    let out = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
        offsets.push(out.length)
        out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = out.length
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    return new TextEncoder().encode(out)
}

const notReadable = { not: usableTextLayer() }

const gatedPipeline = () =>
    new Pipeline([
        new PdfToDocument({ resolution: 72 }),
        { stage: new PdfToImage({ resolution: 72, keepInputData: true }), when: notReadable },
        {
            stage: new DbnetOnnxDetector({ inputCol: 'image', outputCol: 'regions' }),
            id: 'ocr',
            when: notReadable,
        },
    ])

const strip = (rows: Row[]) =>
    rows.map((row) => {
        const { [ROW_TIME_COL]: _r, [EXECUTION_TIME_COL]: _e, content: _c, ...rest } = row
        return rest
    })

describe('page streaming with conditional OCR', () => {
    it('never loads the OCR model when every page has a text layer', async () => {
        const init = vi.spyOn(DbnetOnnxDetector.prototype, 'init')
        const events: PipelineEvent[] = []
        const rows = await gatedPipeline().run(
            { content: makePdf(['alpha', 'beta', 'gamma']), path: 'text.pdf' },
            { pagesInFlight: 3, onEvent: (e) => events.push(e) }
        )

        expect(rows.map((r) => (r.document as Document).text)).toEqual(['alpha', 'beta', 'gamma'])
        expect(rows.every((r) => !('image' in r) && !('regions' in r))).toBe(true)
        expect(init).not.toHaveBeenCalled()
        expect(events.filter((e) => e.type === 'stage:skip' && e.stageId === 'ocr')).toHaveLength(3)
    })

    it('runs OCR only on the page without one', async () => {
        const events: PipelineEvent[] = []
        const rows = await gatedPipeline().run(
            { content: makePdf(['alpha', '', 'gamma']), path: 'mixed.pdf' },
            { pagesInFlight: 3, onEvent: (e) => events.push(e) }
        )

        expect(rows).toHaveLength(3)
        expect(rows.map((r) => 'regions' in r)).toEqual([false, true, false])
        const ocrStarts = events.filter((e) => e.type === 'stage:start' && e.stageId === 'ocr')
        expect(
            ocrStarts.map((e) => (e as Extract<PipelineEvent, { type: 'stage:start' }>).unit.page)
        ).toEqual([1])
    }, 120000)

    it('streams several pages of one document at once, in the same order stage order gives', async () => {
        const content = makePdf(['one', 'two', 'three', 'four', 'five'])
        const build = () =>
            new Pipeline([new PdfToDocument({ resolution: 72 }), new PdfToImage({ resolution: 72 })])
        const stageOrder = await build().transform({ content, path: 'five.pdf' })
        const pageOrder = await build().run({ content, path: 'five.pdf' }, { pagesInFlight: 4 })

        const shape = (rows: Row[]) =>
            strip(rows).map((row) => ({
                page: row.page,
                text: (row.document as Document).text,
                width: (row.image as { width: number }).width,
            }))
        expect(shape(pageOrder)).toEqual(shape(stageOrder))
        expect(pageOrder.map((r) => r.page)).toEqual([0, 1, 2, 3, 4])
    })
})

describe('the hybrid reader, streamed', () => {
    it('gives the same page as stage order', async () => {
        const response = await fetch('/examples/pdfs/SampleWithFaceImage.pdf')
        const content = new Uint8Array(await response.arrayBuffer())
        const build = () =>
            new Pipeline([
                new PdfToDocument({ resolution: 300 }),
                new PdfEmbeddedImages({ resolution: 300 }),
                new PaddleTextRecognizer({ inputCol: 'image', outputCol: 'image_text' }),
                new PdfMergeImageText(),
            ])

        const stageOrder = await build().transform(content)
        const pageOrder = await build().run(content, { pagesInFlight: 2 })

        expect(pageOrder).toHaveLength(1)
        const streamed = pageOrder[0]?.document as Document | undefined
        const staged = stageOrder[0]?.document as Document | undefined
        expect(streamed?.text).toBe(staged?.text)
        expect(streamed?.text).toContain('Apache Spark')
    }, 240000)
})
