/**
 * The hybrid reader with a real recognizer, against a real PDF.
 *
 * `SampleWithFaceImage.pdf` is exactly the case the feature exists for: six
 * items of vector text in the footer, and a 1524x2014 scan above it that the
 * text layer cannot see a word of. Neither reader alone produces this page.
 */
import { describe, expect, it } from 'vitest'
import { configure } from '../../src/core/config.js'
import { Pipeline } from '../../src/core/pipeline.js'
import { DbnetOnnxDetector, PaddleRecognizer, PaddleTextRecognizer } from '../../src/ocr/index.js'
import { PdfEmbeddedImages, PdfMergeImageText, PdfToDocument } from '../../src/pdf/index.js'
import type { Document } from '../../src/schemas/document.js'

configure({ pdf: { workerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs' } })

describe('text layer plus embedded images', () => {
    it('reads both sources into one Document per page', async () => {
        const response = await fetch('/examples/pdfs/SampleWithFaceImage.pdf')
        const content = new Uint8Array(await response.arrayBuffer())

        const rows = await new Pipeline([
            new PdfToDocument({ resolution: 300 }),
            new PdfEmbeddedImages({ resolution: 300 }),
            new PaddleTextRecognizer({ inputCol: 'image', outputCol: 'image_text' }),
            new PdfMergeImageText(),
        ]).transform(content)

        // One page in, one page out -- the images expanded and folded back.
        expect(rows).toHaveLength(1)

        const document = rows[0]?.document as Document
        expect(document.exception).toBe('')
        expect(document.type).toBe('pdf+ocr')

        // The emoji is in the footer's vector text and nowhere else, so its
        // presence proves the text layer survived the merge.
        expect(document.text).toContain('📞')

        // "Apache Spark" appears only inside the scan, so its presence proves
        // the image was read and its boxes were put back on the page.
        expect(document.text).toContain('Apache Spark')

        const inScan = document.bboxes.filter(
            (box) => box.x >= 325 && box.x <= 2306 && box.y >= 306 && box.y <= 2925
        )
        expect(inScan.length).toBeGreaterThan(20)
    }, 180000)
})

describe('a page whose only extra text is a transparent overlay image', () => {
    it('reads the rotated text the text layer cannot see', async () => {
        // Every rotated "info@stabrise.com" on this page lives inside one image
        // with a transparent ground, and none of it is in the text layer. Whole-
        // page recognition mangles rotated lines, so this is the detector path:
        // DBNet finds the six regions and PaddleRecognizer straightens each.
        const response = await fetch('/examples/pdfs/SampleWithRotatedText.pdf')
        const content = new Uint8Array(await response.arrayBuffer())

        const rows = await new Pipeline([
            new PdfToDocument({ resolution: 200 }),
            new PdfEmbeddedImages({ resolution: 200 }),
            new DbnetOnnxDetector({ inputCol: 'image', outputCol: 'detected' }),
            new PaddleRecognizer({
                inputCols: ['image', 'detected'],
                outputCol: 'image_text',
                detectLineOrientation: true,
            }),
            new PdfMergeImageText(),
        ]).transform(content)

        expect(rows).toHaveLength(1)
        const document = rows[0]?.document as Document
        expect(document.exception).toBe('')

        // The rotated block sits in the middle of the page, clear of the header
        // and the footer, both of which the text layer supplies.
        const rotatedBlock = document.bboxes.filter((box) => box.y > 900 && box.y < 1600)
        expect(rotatedBlock.length).toBeGreaterThanOrEqual(6)
        expect(rotatedBlock.filter((box) => box.text.includes('stabrise')).length).toBeGreaterThanOrEqual(4)
    }, 240000)
})
