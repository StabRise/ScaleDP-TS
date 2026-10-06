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
import { type Box, bbox, boxCoverage, isRotated } from '../schemas/box.js'
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
    /**
     * Drop a covered box only when the box covering it says the same thing.
     * Default true; false is Python ScaleDP's coverage-only rule.
     */
    matchText?: boolean
}

/** Case, accents, spacing and punctuation folded away: what is left is what was read. */
function foldText(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Whether two readings of one place on the page are readings of the same words.
 *
 * The shorter is looked for inside the longer -- an OCR word sits inside the
 * line a text layer reports -- allowing about one edit in three characters, for
 * OCR's misreads. A box with nothing readable in it cannot disagree with
 * anything, and is treated as agreeing, which keeps punctuation deduplicated
 * the way it always was.
 */
export function textsAgree(a: string, b: string): boolean {
    const x = foldText(a)
    const y = foldText(b)
    if (x.length === 0 || y.length === 0) return true
    const [short, long] = x.length <= y.length ? [x, y] : [y, x]
    const allowed = Math.max(1, Math.floor(short.length / 3))

    // Sellers' approximate substring match: edit distance from `short` to the
    // best-matching stretch of `long`, with free start and end in `long`.
    let previous = new Array<number>(long.length + 1).fill(0)
    for (let i = 1; i <= short.length; i++) {
        const current = new Array<number>(long.length + 1)
        current[0] = i
        for (let j = 1; j <= long.length; j++) {
            const cost = short[i - 1] === long[j - 1] ? 0 : 1
            current[j] = Math.min(
                (previous[j - 1] as number) + cost,
                (previous[j] as number) + 1,
                (current[j - 1] as number) + 1
            )
        }
        previous = current
    }
    return Math.min(...previous) <= allowed
}

/**
 * Drop the boxes in `losers` that the winning source already covers -- and,
 * with `matchText`, already reads the same way.
 *
 * Coverage alone trusts the winner blindly. On a searchable scan that is
 * right: its invisible layer is an OCR of the very picture beneath it. But a
 * layer that does not match what is printed -- stale after an edit, a stamp
 * laid over a scan, or planted on purpose -- would then hide the visible words
 * entirely, and for redaction the visible words are the ones that leak. Where
 * the two sources disagree, both are kept.
 *
 * Coverage, not IoU: an OCR word sits wholly inside the line-level box a text
 * layer reports for the same words, and their IoU is small. An IoU test would
 * keep both -- see `boxCoverage` in `src/schemas/box.ts`.
 *
 * The maximum over candidates rather than the sum, because two overlapping
 * winners would otherwise double-count and evict a box neither really covers.
 */
export function dropCovered(
    losers: readonly Box[],
    winners: readonly Box[],
    threshold: number,
    matchText = true
): Box[] {
    if (winners.length === 0) return [...losers]
    return losers.filter((box) => {
        for (const winner of winners) {
            if (boxCoverage(box, winner) < threshold) continue
            if (!matchText || textsAgree(box.text, winner.text)) return false
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
    const { strategy, coverageThreshold, matchText = true } = options

    if (strategy === 'union') return [...textBoxes, ...ocrBoxes]
    const ocr = dedupeReadings(ocrBoxes, coverageThreshold, matchText)
    if (strategy === 'ocr-wins') {
        return [...dropCovered(textBoxes, ocr, coverageThreshold, matchText), ...ocr]
    }
    return [...textBoxes, ...dropCovered(ocr, textBoxes, coverageThreshold, matchText)]
}

/**
 * Drop OCR readings that repeat a larger reading of the same spot.
 *
 * Pictures overlap: a page can draw a framed photo and then a second picture
 * over part of it, and each is read on its own, so the same handwritten name
 * comes back twice -- once as `Freya`, once as a stray `T` from the other
 * picture's crop. Fragments of one picture read separately do the same. These
 * duplicates are among the OCR readings themselves, which `dropCovered` against
 * the text layer never compares.
 *
 * The rule is `dropCovered`'s: a reading is dropped when a larger one covers it
 * and, with `matchText`, reads the same words -- so two readings that disagree
 * about a spot, a stamp over a scan, are both kept. Larger first, then the more
 * confident, so it is always the fragment that goes. Order is preserved.
 */
export function dedupeReadings(boxes: readonly Box[], threshold: number, matchText = true): Box[] {
    const order = boxes
        .map((_, index) => index)
        .sort((a, b) => {
            const A = boxes[a] as Box
            const B = boxes[b] as Box
            return B.width * B.height - A.width * A.height || B.score - A.score || a - b
        })
    const kept: Box[] = []
    const keep = new Set<number>()
    for (const index of order) {
        const box = boxes[index] as Box
        const duplicate = kept.some(
            (other) =>
                boxCoverage(box, other) >= threshold && (!matchText || textsAgree(box.text, other.text))
        )
        if (duplicate) continue
        kept.push(box)
        keep.add(index)
    }
    return boxes.filter((_, index) => keep.has(index))
}

/**
 * Glue the pieces of a word an OCR detector split apart back together.
 *
 * Detectors routinely cut a word's first letter off as its own region -- a
 * larger initial, a letter with a gap after it -- and recognise `F` and `reya`
 * separately. Line grouping then sorts by a truncated x, so the letter can even
 * land after the rest of the word. Neither reading is the word, and a name split
 * that way is a name NER cannot find.
 *
 * Two boxes are pieces of one word when they sit on the same line and touch:
 * a gap of under 15% of the text height (a word space is closer to 25-30%),
 * or an outright overlap. Two guards keep whole words apart -- one side must be
 * a fragment of at most three characters unless the boxes truly overlap, and
 * the overlap must stay under half the narrower box, so a duplicate stacked on
 * the same spot is never fused into it. Rotated boxes are left alone: their
 * reading direction is not the x axis this measures along.
 *
 * Fragments are joined without a space, and the result keeps the lower score.
 */
export function joinWordFragments(boxes: readonly Box[]): Box[] {
    const upright = boxes.filter((box) => !isRotated(box)).sort((a, b) => a.x - b.x)
    const rest = boxes.filter((box) => isRotated(box))
    const used = new Array<boolean>(upright.length).fill(false)
    const out: Box[] = []

    for (let i = 0; i < upright.length; i++) {
        if (used[i]) continue
        let current = upright[i] as Box
        for (let j = i + 1; j < upright.length; j++) {
            if (used[j]) continue
            const next = upright[j] as Box
            if (!areFragments(current, next)) continue
            current = joinTwo(current, next)
            used[j] = true
        }
        out.push(current)
    }
    return [...out, ...rest]
}

function areFragments(left: Box, right: Box): boolean {
    const [lx0, ly0, lx1, ly1] = bbox(left)
    const [rx0, ry0, rx1, ry1] = bbox(right)
    const height = Math.min(ly1 - ly0, ry1 - ry0)
    if (height <= 0) return false

    const verticalOverlap = Math.min(ly1, ry1) - Math.max(ly0, ry0)
    if (verticalOverlap < height * 0.5) return false

    const gap = rx0 - lx1
    if (gap > height * 0.15) return false
    // Overlapping by more than half the narrower box is one box read twice.
    const narrower = Math.min(lx1 - lx0, rx1 - rx0)
    if (-gap > narrower * 0.5) return false

    const shortest = Math.min(left.text.trim().length, right.text.trim().length)
    return gap < 0 || shortest <= 3
}

function joinTwo(left: Box, right: Box): Box {
    const [lx0, ly0, lx1, ly1] = bbox(left)
    const [rx0, ry0, rx1, ry1] = bbox(right)
    const x = Math.min(lx0, rx0)
    const y = Math.min(ly0, ry0)
    return {
        text: `${left.text.trim()}${right.text.trim()}`,
        score: Math.min(left.score, right.score),
        x,
        y,
        width: Math.max(lx1, rx1) - x,
        height: Math.max(ly1, ry1) - y,
        angle: 0,
    }
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
