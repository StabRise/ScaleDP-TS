/**
 * The PDF readers against real files. pdf.js needs a real worker, a real
 * canvas and real `createImageBitmap`, so none of this can run in node.
 *
 * `SampleWithFaceImage.pdf` is the shape the hybrid reader exists for: a footer
 * of vector text around a 1524x2014 scan that the text layer cannot see.
 */
import { describe, expect, it } from 'vitest'
import { configure } from '../../src/core/config.js'
import { decodeImage, toImageData } from '../../src/core/image.js'
import { Pipeline, type Row } from '../../src/core/pipeline.js'
import {
    type ImagePlacement,
    imageDataToOwnedCanvas,
    PdfEmbeddedImages,
    PdfMergeImageText,
    PdfToDocument,
    PdfToImage,
} from '../../src/pdf/index.js'
import type { Document } from '../../src/schemas/document.js'
import type { ScaleDpImage } from '../../src/schemas/image.js'

configure({ pdf: { workerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs' } })

const SAMPLE = '/examples/pdfs/SampleWithFaceImage.pdf'

async function pdfBytes(path = SAMPLE): Promise<Uint8Array> {
    const response = await fetch(path)
    if (!response.ok) throw new Error(`fixture ${path}: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
}

const documentOf = (row: Row | undefined) => row?.document as Document
const imageOf = (row: Row | undefined) => row?.image as ScaleDpImage
const placementOf = (row: Row | undefined) => row?.placement as ImagePlacement | null

describe('PdfToImage and PdfToDocument', () => {
    it('render a page and read its text layer into one pixel space', async () => {
        const content = await pdfBytes()

        const [rendered] = await new Pipeline([new PdfToImage({ resolution: 300 })]).transform(content)
        const [read] = await new Pipeline([new PdfToDocument({ resolution: 300 })]).transform(content)

        // US Letter at 300 DPI.
        expect(imageOf(rendered)).toMatchObject({ width: 2550, height: 3300, exception: '' })

        const boxes = documentOf(read).bboxes
        expect(boxes.length).toBeGreaterThan(0)
        // Every text-layer box lands inside the rendered page, which is the
        // whole point of the two stages sharing `resolution`.
        for (const box of boxes) {
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(2550)
            expect(box.y + box.height).toBeLessThanOrEqual(3300)
        }
    })
})

describe('imageDataToOwnedCanvas', () => {
    /** A 2x2 image: one opaque red pixel, three fully transparent black ones. */
    const overlay = () => {
        const data = new Uint8ClampedArray(16)
        data.set([255, 0, 0, 255], 0)
        return { data, width: 2, height: 2, kind: 3 }
    }

    it('puts a transparent ground on white, not on black', async () => {
        // A PDF text overlay is opaque glyphs on a transparent ground with its
        // RGB left at zero. Keeping the alpha would hand a recognizer black ink
        // on black paper -- it reads nothing, while a detector still finds the
        // regions, so the failure looks like recognition rather than compositing.
        const { data } = toImageData(imageDataToOwnedCanvas(overlay()))

        expect([data[0], data[1], data[2], data[3]]).toEqual([255, 0, 0, 255])
        expect([data[4], data[5], data[6], data[7]]).toEqual([255, 255, 255, 255])
    })

    it('composites a half-transparent pixel rather than dropping its alpha', async () => {
        const data = new Uint8ClampedArray(16)
        data.set([0, 0, 0, 128], 0)
        const out = toImageData(imageDataToOwnedCanvas({ data, width: 2, height: 2, kind: 3 })).data

        // Black at half alpha over white is mid grey, give or take rounding.
        expect(out[0]).toBeGreaterThan(120)
        expect(out[0]).toBeLessThan(135)
        expect(out[3]).toBe(255)
    })

    it('leaves an opaque kind alone', async () => {
        const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60])
        const out = toImageData(imageDataToOwnedCanvas({ data, width: 2, height: 1, kind: 2 })).data
        expect([out[0], out[1], out[2], out[3]]).toEqual([10, 20, 30, 255])
    })
})

describe('PdfEmbeddedImages', () => {
    it('finds the scan and the logo, at their own pixel sizes', async () => {
        const rows = await new Pipeline([
            new PdfEmbeddedImages({ resolution: 300, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes())

        expect(rows).toHaveLength(2)
        const sizes = rows.map((row) => [imageOf(row).width, imageOf(row).height])
        expect(sizes).toContainEqual([1524, 2014])
        expect(sizes).toContainEqual([345, 84])
    })

    it('places the scan where the page paints it', async () => {
        const rows = await new Pipeline([
            new PdfEmbeddedImages({ resolution: 300, minPixels: 1_000_000, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes())

        expect(rows).toHaveLength(1)
        expect(placementOf(rows[0])?.box).toMatchObject({ x: 325, y: 306, width: 1981, height: 2619 })
    })

    it('reports the DPI the pixels carry, not the page’s', async () => {
        // 1524 pixels spread over 1981 page pixels at 300 DPI is 231 DPI. Asking
        // for a 300 DPI render does not conjure detail the scan never had.
        const rows = await new Pipeline([
            new PdfEmbeddedImages({ resolution: 300, minPixels: 1_000_000, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes())

        expect(placementOf(rows[0])?.effectiveResolution).toBeCloseTo(231, 0)
    })

    it('hands on pixels that outlive pdf.js’s own bitmap', async () => {
        // page.cleanup() closes every ImageBitmap pdf.js handed out, and the
        // stage calls it before returning -- so decoding here proves the copy.
        const rows = await new Pipeline([
            new PdfEmbeddedImages({ resolution: 300, minPixels: 1_000_000, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes())

        const bitmap = await decodeImage(imageOf(rows[0]).data)
        expect(bitmap.width).toBe(1524)
        bitmap.close()
    })

    it('extracts only the page the row already names', async () => {
        // Two expanding PDF stages over one file would otherwise square the
        // row count. PdfToDocument sets `page`; this stage honours it.
        const rows = await new Pipeline([
            new PdfToDocument({ resolution: 300 }),
            new PdfEmbeddedImages({ resolution: 300, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes())

        expect(rows).toHaveLength(2)
        expect(rows.every((row) => row.page === 0)).toBe(true)
        expect(documentOf(rows[0]).bboxes.length).toBeGreaterThan(0)
    })

    it('keeps a page with no readable image, so its text layer survives', async () => {
        const rows = await new Pipeline([
            // No image is big enough, so the page has nothing to read.
            new PdfEmbeddedImages({ resolution: 300, minPixels: 100_000_000 }),
        ]).transform(await pdfBytes())

        expect(rows).toHaveLength(1)
        expect(imageOf(rows[0]).exception).toContain('no embedded images')
    })
})

describe('the hybrid pipeline', () => {
    it('merges image text into the text layer, one row per page', async () => {
        const rows = await new Pipeline([
            new PdfToDocument({ resolution: 300 }),
            new PdfEmbeddedImages({ resolution: 300, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes())

        // Stand in for the recognizer: one word at the top-left of each image.
        for (const row of rows) {
            row.image_text = {
                path: 'a.pdf',
                type: 'ocr',
                text: 'SCANNED',
                exception: '',
                bboxes: [{ text: 'SCANNED', score: 0.9, x: 0, y: 0, width: 100, height: 40, angle: 0 }],
            }
        }

        const merged = await new PdfMergeImageText().transform(rows, { index: 0 })
        expect(merged).toHaveLength(1)

        const document = documentOf(merged[0])
        expect(document.type).toBe('pdf+ocr')
        expect(document.text).toContain('SCANNED')
        // The word was at the scan's top-left, so it lands at its placement.
        const scanned = document.bboxes.filter((box) => box.text === 'SCANNED')
        expect(scanned.some((box) => box.x === 325 && box.y === 306)).toBe(true)
    })
})

describe('a PDF whose images are transparent overlays', () => {
    it('extracts them as ink on paper, so a recognizer can read them', async () => {
        // SampleWithRotatedText.pdf paints its rotated text as an image with a
        // fully transparent ground. Extracted with its alpha intact it is 100%
        // black pixels and every recognizer returns nothing.
        const rows = await new Pipeline([
            new PdfEmbeddedImages({ resolution: 200, minCoveringBoxes: 0 }),
        ]).transform(await pdfBytes('/examples/pdfs/SampleWithRotatedText.pdf'))

        expect(rows).toHaveLength(3)

        for (const row of rows) {
            const bitmap = await decodeImage(imageOf(row).data)
            const { data } = toImageData(bitmap)
            bitmap.close()

            let dark = 0
            let opaque = 0
            for (let i = 0; i < data.length; i += 4) {
                const lum = ((data[i] as number) + (data[i + 1] as number) + (data[i + 2] as number)) / 3
                if (lum < 128) dark++
                if (data[i + 3] === 255) opaque++
            }
            const pixels = data.length / 4
            expect(opaque).toBe(pixels)
            // Ink on paper: a page of text is a minority of dark pixels.
            expect(dark / pixels).toBeLessThan(0.5)
        }
    })
})
