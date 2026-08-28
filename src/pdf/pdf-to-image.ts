/**
 * Port of `scaledp/pdf/PdfDataToImage.py`: a PDF into one `Image` row per page.
 *
 * Python renders with PyMuPDF at a DPI; pdf.js works in scale factors, so the
 * DPI converts through the PDF unit of 72 points per inch.
 */

import { ImageError } from '../core/errors.js'
import { createCanvas, encodeImage } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import { createImage, type ImageFormat, type ScaleDpImage } from '../schemas/image.js'
import { toBytes } from '../stages/data-to-image.js'
import { documentOptions, loadPdfjs } from './pdfjs.js'

/** PDF user space is defined in points; 72 of them make an inch. */
export const POINTS_PER_INCH = 72

export interface PdfToImageParams extends BaseStageParams {
    /** Render DPI. 300 matches ScaleDP's default and suits OCR. */
    resolution: number
    /** Maximum pages to render; 0 renders all of them. */
    pageLimit: number
    imageType: ImageFormat
}

export const PDF_TO_IMAGE_DEFAULTS: PdfToImageParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'content',
    outputCol: 'image',
    resolution: 300,
    pageLimit: 0,
    imageType: 'png' as ImageFormat,
})

const MIME: Record<ImageFormat, 'image/png' | 'image/webp' | 'image/jpeg'> = {
    png: 'image/png',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
}

export class PdfToImage extends Stage<PdfToImageParams> {
    readonly name = 'PdfToImage'

    constructor(options: Partial<PdfToImageParams> = {}) {
        super(
            resolveParams(PDF_TO_IMAGE_DEFAULTS, options, {
                resolution: (value) => {
                    if (!Number.isFinite(value) || value <= 0) {
                        throw new RangeError(`resolution must be positive, received ${value}`)
                    }
                },
                pageLimit: (value) => {
                    if (!Number.isInteger(value) || value < 0) {
                        throw new RangeError(`pageLimit must be a non-negative integer, received ${value}`)
                    }
                },
            })
        )
    }

    /** One input PDF becomes N rows, each carrying its page index. */
    protected override async expand(input: unknown, row: Row, ctx: StageContext): Promise<Row[]> {
        const { outputCol, pageCol, pathCol, resolution, pageLimit, imageType } = this.params
        const path = String(row[pathCol] ?? 'memory')

        const pdfjs = await loadPdfjs()
        const task = pdfjs.getDocument(documentOptions(toBytes(input)))
        const document = await task.promise

        try {
            const pageCount = pageLimit > 0 ? Math.min(pageLimit, document.numPages) : document.numPages
            const rows: Row[] = []

            for (let index = 0; index < pageCount; index++) {
                ctx.signal?.throwIfAborted()
                const image = await renderPage(document, index + 1, {
                    resolution,
                    imageType,
                    path,
                })
                rows.push({ ...row, [pageCol]: index, [outputCol]: image })
            }
            return rows
        } finally {
            // destroy() lives on the loading task, not the document proxy, and
            // is what releases the pdf.js worker's copy of the file.
            await task.destroy()
        }
    }

    protected async apply(): Promise<never> {
        throw new ImageError('unreachable: expand handles every row', this.name)
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({ path: String(row[this.params.pathCol] ?? 'memory'), exception: message })
    }
}

/** Rasterise a single 1-based page to encoded image bytes. */
export async function renderPage(
    document: Awaited<ReturnType<typeof import('pdfjs-dist').getDocument>['promise']>,
    pageNumber: number,
    opts: { resolution: number; imageType: ImageFormat; path: string }
): Promise<ScaleDpImage> {
    const page = await document.getPage(pageNumber)
    try {
        const viewport = page.getViewport({ scale: opts.resolution / POINTS_PER_INCH })
        const canvas = createCanvas(viewport.width, viewport.height)

        // pdf.js >= 5 takes `canvas`, not `canvasContext`. Passing the context
        // still works but is the documented legacy path.
        await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport,
        }).promise

        return createImage({
            path: opts.path,
            resolution: opts.resolution,
            data: await encodeImage(canvas, MIME[opts.imageType]),
            imageType: opts.imageType,
            width: canvas.width,
            height: canvas.height,
        })
    } finally {
        page.cleanup()
    }
}
