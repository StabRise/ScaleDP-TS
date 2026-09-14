/**
 * Combining a PDF's own text layer with text read out of the images on the
 * same page.
 *
 * Both sides arrive in page pixels -- `PdfToDocument` emits its boxes in the
 * space `PdfToImage` renders at, and `boxToPage` puts an image's boxes in the
 * same one -- so merging is a question of policy, not of coordinates.
 *
 * The policy exists because of the *searchable scan*: a page that is a
 * photograph of a document with an invisible OCR text layer laid over it. Both
 * sources then describe the same words, and a naive concatenation says
 * everything twice. Which source to believe is a property of the corpus, not
 * something that can be decided here, so it is a parameter.
 *
 * Pure -- no pdf.js, no canvas.
 */

import { boxesToText, getSize, groupBoxesIntoLines, linesToFormattedText } from '../core/text.js'
import { type Box, boxCoverage } from '../schemas/box.js'
import { createDocument, type Document } from '../schemas/document.js'

export type MergeStrategy = 'text-layer-wins' | 'ocr-wins' | 'union'

export const MERGE_STRATEGIES: readonly MergeStrategy[] = Object.freeze([
    'text-layer-wins',
    'ocr-wins',
    'union',
])

export interface MergeOptions {
    strategy: MergeStrategy
    /** How much of a box the other source must cover before it is dropped. */
    coverageThreshold: number
}

/**
 * Drop the boxes in `losers` that the winning source already covers.
 *
 * Coverage, not IoU: an OCR word sits wholly inside the line-level box a text
 * layer reports for the same words, and their IoU is small. An IoU test would
 * keep both -- see `boxCoverage` in `src/schemas/box.ts`.
 *
 * The maximum over candidates rather than the sum, because two overlapping
 * winners would otherwise double-count and evict a box neither really covers.
 */
export function dropCovered(losers: readonly Box[], winners: readonly Box[], threshold: number): Box[] {
    if (winners.length === 0) return [...losers]
    return losers.filter((box) => {
        let best = 0
        for (const winner of winners) {
            const covered = boxCoverage(box, winner)
            if (covered > best) best = covered
            if (best >= threshold) return false
        }
        return true
    })
}

/** Apply a strategy to two box sets that describe the same page. */
export function mergeBoxSets(
    textBoxes: readonly Box[],
    ocrBoxes: readonly Box[],
    options: MergeOptions
): Box[] {
    const { strategy, coverageThreshold } = options

    if (strategy === 'union') return [...textBoxes, ...ocrBoxes]
    if (strategy === 'ocr-wins') {
        return [...dropCovered(textBoxes, ocrBoxes, coverageThreshold), ...ocrBoxes]
    }
    return [...textBoxes, ...dropCovered(ocrBoxes, textBoxes, coverageThreshold)]
}

/**
 * How many of a page's text-layer boxes sit inside one region.
 *
 * The cheap test for "this image has already been read": a scan with an
 * invisible text layer over it has hundreds, a bare scan has none. Centres
 * rather than overlap, so a header sitting just above an image is not counted
 * as being inside it.
 */
export function coveringBoxes(textBoxes: readonly Box[], region: Box): number {
    const x0 = region.x
    const y0 = region.y
    const x1 = region.x + region.width
    const y1 = region.y + region.height

    let count = 0
    for (const box of textBoxes) {
        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) count++
    }
    return count
}

export interface AssembleOptions extends MergeOptions {
    path: string
    keepFormatting: boolean
    lineTolerance: number
    exception?: string
}

/**
 * One page's two sources into one `Document`.
 *
 * `text` and `bboxes` come out of a *single* line grouping, so the two agree:
 * the boxes are in the order the text was built from. That matters because
 * `buildCharToBoxMap` walks both together to turn NER character offsets back
 * into boxes.
 *
 * Interleaving is the whole point of grouping the merged set rather than each
 * source separately. A vector-text header above an OCR'd table reads header
 * first; concatenating by source would put it after the table whenever the
 * image happens to sit at the top of the page.
 */
export function assembleDocument(
    textBoxes: readonly Box[],
    ocrBoxes: readonly Box[],
    options: AssembleOptions
): Document {
    const { path, keepFormatting, lineTolerance, exception } = options
    const merged = mergeBoxSets(textBoxes, ocrBoxes, options)
    const lines = groupBoxesIntoLines(merged, lineTolerance)
    const ordered = lines.flat()

    return createDocument({
        path,
        // Provenance without a schema change: a page whose images contributed
        // nothing is indistinguishable from one PdfToDocument would produce.
        type: ocrBoxes.length > 0 ? 'pdf+ocr' : 'pdf',
        text: keepFormatting
            ? linesToFormattedText(
                  lines,
                  getSize(merged, (b) => b.height)
              )
            : boxesToText(ordered),
        bboxes: ordered,
        exception: exception ?? '',
    })
}
