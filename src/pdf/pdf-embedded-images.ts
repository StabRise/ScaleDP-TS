/**
 * The raster images embedded in a PDF, one row each, at their own pixel size.
 *
 * A page's text layer covers only its vector text, so anything scanned or
 * pasted in as a bitmap is invisible to `PdfToDocument`. This stage finds those
 * bitmaps and hands them to an ordinary recognizer; `PdfMergeImageText` puts the
 * results back together with the text layer.
 *
 * The pixels come from the PDF's own image objects rather than from a crop of
 * the rendered page, so they are never resampled -- a 231 DPI scan inside a page
 * rendered at 300 is read at 231, not interpolated up to 300 and read from that.
 *
 * Unlike the other two PDF readers, this one *honours* an already-set page
 * column: placed after `PdfToDocument` it extracts only that row's page, which
 * is what lets the text layer and the images travel one pipeline without the two
 * page explosions multiplying.
 */

import { ImageError } from '../core/errors.js'
import { encodeImage } from '../core/image.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import type { Box } from '../schemas/box.js'
import type { Document } from '../schemas/document.js'
import { createImage, type ImageFormat, type ScaleDpImage } from '../schemas/image.js'
import { toBytes } from '../stages/data-to-image.js'
import { type EmbeddedImage, extractEmbeddedImages, type ImagePlacement } from './extract-images.js'
import { coveringBoxes } from './merge-text.js'
import { POINTS_PER_INCH, pageIndexes } from './pdf-to-image.js'
import { describePdfError, withPdfDocument } from './pdfjs.js'

export interface PdfEmbeddedImagesParams extends BaseStageParams {
    /** Pixel space the placement boxes are expressed in. Match PdfToDocument. */
    resolution: number
    pageLimit: number
    imageType: ImageFormat
    /** Column the placement is written to, alongside the image. */
    placementCol: string
    /** Ignore images with fewer native pixels than this. */
    minPixels: number
    /** Most images per page, largest first; 0 takes all of them. */
    imageLimit: number
    /** Upscale an image placed below this DPI before it is read. 0 disables. */
    minEffectiveResolution: number
    /** How long to wait for pdf.js to decode one image object. */
    objectTimeoutMs: number
    /**
     * A text-layer `Document` column, used to skip images that are already
     * readable. Empty disables the check.
     */
    textLayerCol: string
    /**
     * Text-layer boxes inside an image's placement that mark it already read.
     *
     * A searchable scan -- a photograph with an invisible OCR layer over it --
     * has hundreds, and re-reading it costs seconds to arrive at a worse answer
     * than the layer already holds. A bare scan has none. 0 disables the skip.
     */
    minCoveringBoxes: number
    /** Emit the page row with an errored Image when a page has no images. */
    returnEmpty: boolean
}

export const PDF_EMBEDDED_IMAGES_DEFAULTS: PdfEmbeddedImagesParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'content',
    outputCol: 'image',
    keepInputData: true,
    resolution: 300,
    pageLimit: 0,
    imageType: 'png' as ImageFormat,
    placementCol: 'placement',
    minPixels: 64 * 64,
    imageLimit: 0,
    minEffectiveResolution: 150,
    objectTimeoutMs: 10_000,
    textLayerCol: 'document',
    minCoveringBoxes: 8,
    returnEmpty: true,
})

/** Recorded on the emitted image when a page painted no readable raster. */
export const NO_EMBEDDED_IMAGES = 'This page has no embedded images to read.'

export class PdfEmbeddedImages extends Stage<PdfEmbeddedImagesParams> {
    readonly name = 'PdfEmbeddedImages'

    constructor(options: Partial<PdfEmbeddedImagesParams> = {}) {
        super(
            resolveParams(PDF_EMBEDDED_IMAGES_DEFAULTS, options, {
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

    protected override async expand(input: unknown, row: Row, ctx: StageContext): Promise<Row[]> {
        const { pageCol, pathCol, pageLimit } = this.params
        const path = String(row[pathCol] ?? 'memory')

        try {
            // pdf.js defers worker setup, so a missing worker surfaces on first
            // page access rather than from task.promise.
            return await withPdfDocument(toBytes(input), async (pdf) => {
                const rows: Row[] = []
                for (const index of pageIndexes(row[pageCol], pdf.numPages, pageLimit)) {
                    ctx.signal?.throwIfAborted()
                    rows.push(...(await this.readPage(pdf, index, row, path, ctx)))
                }
                return rows
            })
        } catch (error) {
            throw describePdfError(error)
        }
    }

    private async readPage(
        pdf: Awaited<ReturnType<typeof import('pdfjs-dist').getDocument>['promise']>,
        index: number,
        row: Row,
        path: string,
        ctx: StageContext
    ): Promise<Row[]> {
        const {
            outputCol,
            pageCol,
            placementCol,
            resolution,
            imageType,
            minPixels,
            imageLimit,
            minEffectiveResolution,
            objectTimeoutMs,
            textLayerCol,
            minCoveringBoxes,
            returnEmpty,
        } = this.params

        const page = await pdf.getPage(index + 1)
        try {
            const viewport = page.getViewport({ scale: resolution / POINTS_PER_INCH })
            let found = await extractEmbeddedImages(page as never, viewport, {
                resolution,
                minPixels,
                limit: imageLimit,
                minEffectiveResolution,
                objectTimeoutMs,
                signal: ctx.signal,
            })

            const textBoxes = textLayerBoxes(row[textLayerCol])
            if (minCoveringBoxes > 0 && textBoxes.length > 0) {
                found = found.filter(
                    (image) => coveringBoxes(textBoxes, image.placement.box) < minCoveringBoxes
                )
            }

            if (found.length === 0) {
                if (!returnEmpty) return []
                return [
                    {
                        ...row,
                        [pageCol]: index,
                        [outputCol]: createImage({ path, resolution, exception: NO_EMBEDDED_IMAGES }),
                        [placementCol]: null,
                    },
                ]
            }

            const rows: Row[] = []
            for (const image of found) {
                ctx.signal?.throwIfAborted()
                rows.push({
                    ...row,
                    [pageCol]: index,
                    [outputCol]: await toScaleDpImage(image, path, imageType),
                    [placementCol]: image.placement,
                })
            }
            return rows
        } finally {
            // Only safe after extraction: cleanup() closes the bitmaps pdf.js
            // handed out, and extractEmbeddedImages copies them.
            page.cleanup()
        }
    }

    protected async apply(): Promise<never> {
        throw new ImageError('unreachable: expand handles every row', this.name)
    }

    protected onError(message: string, row: Row): ScaleDpImage {
        return createImage({ path: String(row[this.params.pathCol] ?? 'memory'), exception: message })
    }
}

async function toScaleDpImage(
    image: EmbeddedImage,
    path: string,
    imageType: ImageFormat
): Promise<ScaleDpImage> {
    const { canvas, placement } = image
    return createImage({
        path,
        // The DPI the pixels actually carry, not the page's render DPI -- a
        // recognizer choosing a scale wants the former.
        resolution: Math.round(placement.effectiveResolution * placement.scaleFactor),
        data: await encodeImage(canvas, `image/${imageType}` as never),
        imageType,
        width: canvas.width,
        height: canvas.height,
    })
}

/** Boxes off whatever the text-layer column holds, or none. */
function textLayerBoxes(source: unknown): Box[] {
    if (typeof source !== 'object' || source === null) return []
    return (source as Document).bboxes ?? []
}

export type { ImagePlacement }
