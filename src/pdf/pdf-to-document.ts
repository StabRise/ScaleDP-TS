/**
 * Port of `scaledp/pdf/PdfDataToText.py`: a PDF's embedded text layer into one
 * `Document` row per page, with word-level boxes.
 *
 * Coordinates are emitted in the same pixel space `PdfToImage` renders at, so
 * boxes from this stage and boxes from OCR are directly comparable. Python
 * leaves PdfDataToText in PDF points and scales only in PdfDataToDocument; a
 * single consistent space is more useful and avoids a class of silent mismatch.
 *
 * The output feeds the `bypassCol` optimisation: a page that already has a text
 * layer does not need OCR.
 */

import { ImageError } from '../core/errors.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { createDocument, type Document } from '../schemas/document.js'
import { toBytes } from '../stages/data-to-image.js'
import { extractTextBoxes } from './extract-text.js'
import { POINTS_PER_INCH } from './pdf-to-image.js'
import { documentOptions, loadPdfjs } from './pdfjs.js'
import { splitRunsIntoWords } from './split-words.js'

export interface PdfToDocumentParams extends BaseStageParams {
    /** Pixel space the boxes are expressed in; match PdfToImage to align them. */
    resolution: number
    pageLimit: number
    /** Split pdf.js line runs into word boxes. Off yields run-level boxes. */
    splitWords: boolean
}

export const PDF_TO_DOCUMENT_DEFAULTS: PdfToDocumentParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'content',
    outputCol: 'document',
    keepInputData: true,
    resolution: 300,
    pageLimit: 0,
    splitWords: true,
})

export class PdfToDocument extends Stage<PdfToDocumentParams> {
    readonly name = 'PdfToDocument'

    constructor(options: Partial<PdfToDocumentParams> = {}) {
        super(resolveParams(PDF_TO_DOCUMENT_DEFAULTS, options))
    }

    protected override async expand(input: unknown, row: Row, ctx: StageContext): Promise<Row[]> {
        const { outputCol, pageCol, pathCol, resolution, pageLimit, splitWords } = this.params
        const path = String(row[pathCol] ?? 'memory')

        const pdfjs = await loadPdfjs()
        const task = pdfjs.getDocument(documentOptions(toBytes(input)))
        const pdf = await task.promise

        try {
            const pageCount = pageLimit > 0 ? Math.min(pageLimit, pdf.numPages) : pdf.numPages
            const rows: Row[] = []

            for (let index = 0; index < pageCount; index++) {
                ctx.signal?.throwIfAborted()
                const page = await pdf.getPage(index + 1)
                try {
                    const viewport = page.getViewport({ scale: resolution / POINTS_PER_INCH })
                    const runs = await extractTextBoxes(page, viewport)
                    const bboxes = splitWords ? splitRunsIntoWords(runs) : runs

                    rows.push({
                        ...row,
                        [pageCol]: index,
                        [outputCol]: createDocument({
                            path,
                            type: 'pdf',
                            text: runs.map((r) => r.text).join('\n'),
                            bboxes,
                        }),
                    })
                } finally {
                    page.cleanup()
                }
            }
            return rows
        } finally {
            await task.destroy()
        }
    }

    protected async apply(): Promise<never> {
        throw new ImageError('unreachable: expand handles every row', this.name)
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({
            path: String(row[this.params.pathCol] ?? 'memory'),
            type: 'pdf',
            exception: message,
        })
    }
}

/** True when a page's text layer is substantive enough to skip OCR. */
export function hasUsableTextLayer(document: Document, minimumBoxes = 1): boolean {
    return document.exception === '' && document.bboxes.length >= minimumBoxes
}
