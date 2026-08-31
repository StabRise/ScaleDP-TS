/**
 * Reading a line, then cutting the reading into words.
 *
 * The order matters and was learned the hard way. Cutting the crop first and
 * reading each word on its own gives markedly worse text: PP-OCR's recogniser
 * is a CTC model trained on full text lines, and a three-character crop
 * stretched to its fixed input height is nothing like what it saw in training.
 * It also throws away the line's context, which is where the model's accuracy
 * comes from.
 *
 * So the line is read whole -- one inference, at full quality -- and the words
 * are recovered afterwards by pairing the recognised text's own spaces with the
 * ink gaps a vertical projection of the crop finds. That is both better and
 * cheaper: one inference per line instead of one per word.
 *
 * Shared, because `PaddleRecognizer` and `PaddleTextRecognizer` want identical
 * words out of identical pixels, whichever detector found the line.
 */

import type { Point } from '../core/geometry.js'
import {
    type CropGeometry,
    context2d,
    createCanvas,
    cropBox,
    cropGeometry,
    resize,
    rotate180,
} from '../core/image.js'
import type { StageContext } from '../core/pipeline.js'
import { type Box, boxFromBBox, boxFromPolygon, isRotated } from '../schemas/box.js'
import type { LineOrientationClassifier } from './line-orientation.js'
import type { PaddleRecognitionService } from './paddle-service.js'

/**
 * ppu batches within one `run()` call and `run()` cuts from one canvas, so the
 * crops are stacked onto sheets. A sheet past this is refused by the canvas.
 */
const MAX_SHEET_HEIGHT = 8192

export interface ReadRegionsOptions {
    /** Resize the page by this factor before cropping. */
    scaleFactor: number
    /** Grow each box before cropping. */
    padding: number
    /** 'word' splits each region's reading into words; 'region' keeps it whole. */
    boxLevel: 'region' | 'word'
    /** How wide a blank run must be, relative to crop height, to be a space. */
    wordGapRatio: number
    /** Classify each crop 0/180 degrees and turn the inverted ones. */
    orientation?: LineOrientationClassifier | null
    /** Skip boxes that are neither rotated nor came back inverted. */
    onlyRotated?: boolean
}

/**
 * Crop every region off the page, read each whole, and split into words if asked.
 *
 * Returns one box per result, in the page's own coordinates, carrying the text
 * and score. Nothing is filtered here -- the calling stage owns its threshold.
 */
export async function readRegions(
    recognition: PaddleRecognitionService,
    page: ImageBitmap | OffscreenCanvas,
    boxes: readonly Box[],
    options: ReadRegionsOptions,
    ctx: StageContext
): Promise<Box[]> {
    const { scaleFactor, padding, boxLevel, wordGapRatio, orientation, onlyRotated } = options

    // ScaleDP resizes the *page* and scales each box to index into it, which is
    // how a small line is handed to the model at a readable size. The boxes it
    // reports back are the originals, untouched.
    const canvas = scaleFactor === 1 ? page : resize(page, scaleFactor)

    // Kept index-aligned with `crops`: one entry per region actually read.
    const regions: Region[] = []
    const crops: OffscreenCanvas[] = []

    for (const box of boxes) {
        ctx.signal?.throwIfAborted()

        // Straightens rotated boxes rather than taking their envelope, which is
        // what makes a skewed line readable at all -- and what ppu's own
        // cropping, being axis-aligned, cannot do.
        const geometry = cropGeometry(box, { scaleFactor, padding })
        let crop = cropBox(canvas, box, { scaleFactor, padding })

        let inverted = false
        if (orientation) {
            inverted = (await orientation.classify(crop)) === '180_degree'
            if (inverted) crop = rotate180(crop)
        }

        // ScaleDP's onlyRotated: an upright, right-way-up box was already
        // handled by whatever pass produced it.
        if (onlyRotated && !isRotated(box) && !inverted) continue

        regions.push({ box, crop, geometry, inverted, rotated: isRotated(box) })
        crops.push(crop)
    }

    // One inference per region, whatever the box level asked for. The line is
    // the unit the model reads best, so it is the unit it is handed.
    const read = await recognizeCrops(recognition, crops, ctx)

    const out: Box[] = []
    for (const [i, region] of regions.entries()) {
        const result = read[i]
        if (!result?.text) continue

        if (boxLevel === 'region') {
            out.push({ ...region.box, text: result.text, score: result.score })
            continue
        }
        out.push(...splitIntoWords(region, result, wordGapRatio, scaleFactor))
    }
    return out
}

interface Region {
    box: Box
    crop: OffscreenCanvas
    geometry: CropGeometry
    inverted: boolean
    rotated: boolean
}

/**
 * One box per word in a line that has already been read.
 *
 * Two independent readings of the same line have to be reconciled: the words
 * the model reported, and the ink gaps the image actually has. The ink decides
 * *how many* boxes there are, because it was measured rather than inferred; the
 * text decides what is *in* them. Nothing here invents geometry -- every box
 * returned is an ink span the projection actually found.
 *
 * Every word inherits the line's confidence, because that is the only score
 * that was ever computed: the model scored the line, not its parts.
 */
function splitIntoWords(
    region: Region,
    result: ReadResult,
    wordGapRatio: number,
    scaleFactor: number
): Box[] {
    const { crop, geometry, inverted, rotated } = region
    const tokens = result.text.split(/\s+/).filter((token) => token.length > 0)
    if (tokens.length === 0) return []

    const spans = wordSpans(crop, wordGapRatio)
    const paired = alignSpans(tokens, spans)

    return paired.map(({ span, text }) => ({
        ...spanBox(span, crop, geometry, inverted, scaleFactor, rotated),
        text,
        score: result.score,
    }))
}

interface Paired {
    span: Span
    text: string
}

/**
 * Pair the words the model read with the ink spans the image shows.
 *
 * Equal counts is the ordinary case and needs no cleverness -- the model put a
 * space exactly where the ink did, and the two zip together.
 *
 * More spans than words means the ink gapped where the model read no space: a
 * wide letter gap, or a space the greedy CTC decode dropped. The narrowest gaps
 * are the least likely to be real, so adjacent spans merge smallest-gap-first
 * until the counts meet.
 *
 * More words than spans means the model read a space the ink does not show --
 * routine on a scribble or a signature, where it emits a scatter of single
 * letters for one continuous stroke. Those words are *joined back together*
 * onto the spans they fall on. Splitting a span to match instead would hand
 * back a row of boxes with identical widths and heights, which is not geometry
 * at all: it is the character count drawn as a rectangle, and it looked exactly
 * like per-symbol boxes because that is what it was.
 */
function alignSpans(tokens: readonly string[], spans: readonly Span[]): Paired[] {
    if (spans.length === 0) return []

    const measured = tokens.length < spans.length ? mergeSpans(spans, tokens.length) : spans
    if (tokens.length <= measured.length) {
        return measured.map((span, i) => ({ span, text: tokens[i] as string }))
    }
    return joinTokens(tokens, measured)
}

/** Merge adjacent spans, smallest gap first, until `count` remain. */
function mergeSpans(spans: readonly Span[], count: number): Span[] {
    const out = spans.map((span) => ({ ...span }))
    while (out.length > count) {
        let at = 0
        let smallest = Number.POSITIVE_INFINITY
        for (let i = 0; i < out.length - 1; i++) {
            const gap = (out[i + 1] as Span).x0 - (out[i] as Span).x1
            if (gap < smallest) {
                smallest = gap
                at = i
            }
        }
        const left = out[at] as Span
        const right = out[at + 1] as Span
        out.splice(at, 2, {
            x0: left.x0,
            x1: right.x1,
            y0: Math.min(left.y0, right.y0),
            y1: Math.max(left.y1, right.y1),
        })
    }
    return out
}

/**
 * Share more words than there are spans out across them, by ink width.
 *
 * A span's share of the characters is its share of the ink, which is the best
 * available guess at where the text sits. Every span keeps at least one word,
 * so no measured ink is dropped, and words stay in reading order.
 */
function joinTokens(tokens: readonly string[], spans: readonly Span[]): Paired[] {
    const widths = spans.map((span) => Math.max(1, span.x1 - span.x0))
    const ink = widths.reduce((total, width) => total + width, 0)
    const chars = tokens.reduce((total, token) => total + token.length, 0) || 1
    const share = widths.map((width) => (width / ink) * chars)

    const groups: string[][] = spans.map(() => [])
    let at = 0
    let used = 0

    for (const [i, token] of tokens.entries()) {
        const tokensLeft = tokens.length - i
        // Move on once this span has had its share -- or sooner, if every span
        // after it still needs a word of its own.
        while (
            at < spans.length - 1 &&
            (groups[at] as string[]).length > 0 &&
            (used >= (share[at] as number) || tokensLeft <= spans.length - at - 1)
        ) {
            at++
            used = 0
        }
        ;(groups[at] as string[]).push(token)
        used += token.length
    }

    return groups
        .map((group, i) => ({ span: spans[i] as Span, text: group.join(' ') }))
        .filter((paired) => paired.text.length > 0)
}

/** A word's extent within a crop, in crop pixels. Half-open on both axes. */
interface Span {
    x0: number
    x1: number
    /** The word's own ink rows, so its box hugs the glyphs not the line. */
    y0: number
    y1: number
}

/**
 * Where the words are in a straightened line crop.
 *
 * A vertical projection of the ink: columns darker than the midpoint between
 * the crop's lightest and darkest column are "ink", and a run of blank columns
 * at least `gapRatio` of the crop's height wide is a space. Anything narrower
 * is letter spacing.
 *
 * The threshold is taken from the crop's own range rather than a fixed value,
 * so a grey scan and a black-on-white one both split at the same place, and a
 * light-on-dark crop is handled by the same comparison. A crop with no gaps --
 * one word, or a script that does not use spaces -- comes back as a single
 * span, which is exactly the region-level result.
 */
export function wordSpans(crop: OffscreenCanvas, gapRatio: number): Span[] {
    const { width, height } = crop
    const whole: Span[] = [{ x0: 0, x1: width, y0: 0, y1: height }]
    if (width < 2) return whole

    const { data } = context2d(crop).getImageData(0, 0, width, height)

    // Per-pixel luminance, composited over white. Padding can push a crop past
    // the edge of the page, and those pixels are transparent *black* -- read
    // raw they would be the darkest ink on the crop, and every line would
    // "start" with a word made of its own margin.
    const luminance = new Float32Array(width * height)
    let lightest = Number.POSITIVE_INFINITY
    let darkest = Number.NEGATIVE_INFINITY
    for (let i = 0, p = 0; p < width * height; p++, i += 4) {
        const alpha = (data[i + 3] as number) / 255
        const lum =
            0.299 * (data[i] as number) + 0.587 * (data[i + 1] as number) + 0.114 * (data[i + 2] as number)
        const value = alpha * lum + (1 - alpha) * 255
        luminance[p] = value
        if (value < lightest) lightest = value
        if (value > darkest) darkest = value
    }

    // A crop of one flat tone has nothing to cut on.
    if (darkest - lightest < 32) return whole

    // Count ink *pixels* per column, not the column's average darkness. A
    // column crossing a glyph is mostly background -- a stem is thin and the
    // text is shorter than the crop -- so its mean sits near white and a
    // mean-based test only ever fires on the densest stems, tearing words apart
    // between their own letters.
    const ink = (lightest + darkest) / 2
    const counts = new Int32Array(width)
    for (let y = 0, p = 0; y < height; y++) {
        for (let x = 0; x < width; x++, p++) {
            if ((luminance[p] as number) < ink) counts[x] = (counts[x] as number) + 1
        }
    }

    // One stray pixel is noise; two is a stroke.
    const floor = Math.max(1, Math.round(height * 0.02))
    const inked = (x: number) => (counts[x] as number) > floor

    const minGap = Math.max(2, Math.round(height * gapRatio))
    const columns: [number, number][] = []
    let start = -1
    let blank = 0
    for (let x = 0; x < width; x++) {
        if (inked(x)) {
            // Close the previous word only once the blank run was wide enough;
            // a narrower one was letter spacing and belongs to the same word.
            if (start >= 0 && blank >= minGap) {
                columns.push([start, x - blank])
                start = x
            } else if (start < 0) {
                start = x
            }
            blank = 0
        } else if (start >= 0) {
            columns.push([start, x])
            start = -1
            blank = 0
        }
    }
    if (start >= 0) columns.push([start, width])
    if (columns.length === 0) return whole

    // Merge back the runs that were only separated by letter spacing, then trim
    // each word to the rows it actually inks. Without the trim a word narrower
    // than the line is tall becomes a *tall* rectangle, and since `Box` keeps
    // width as the longer side it would be reported upright-but-rotated-90.
    const merged: [number, number][] = []
    for (const run of columns) {
        const last = merged[merged.length - 1]
        if (last && run[0] - last[1] < minGap) last[1] = run[1]
        else merged.push([...run] as [number, number])
    }

    return merged.map(([x0, x1]) => {
        let y0 = -1
        let y1 = 0
        for (let y = 0; y < height; y++) {
            let count = 0
            for (let x = x0; x < x1; x++) {
                if ((luminance[y * width + x] as number) < ink) count++
            }
            if (count > 0) {
                if (y0 < 0) y0 = y
                y1 = y + 1
            }
        }
        return y0 < 0 ? { x0, x1, y0: 0, y1: height } : { x0, x1, y0, y1 }
    })
}

/**
 * One word's box, in the page's coordinates.
 *
 * The span is in the crop's own space: straightened, padded, scaled, and turned
 * the right way up if the line was upside down. Undo the turn, then push the
 * four corners back through the crop's own transform, so a word inside a skewed
 * line comes back skewed the same way.
 */
function spanBox(
    span: Span,
    crop: OffscreenCanvas,
    geometry: CropGeometry,
    inverted: boolean,
    scaleFactor: number,
    rotated: boolean
): Box {
    // rotate180 maps (x, y) to (w - x, h - y), so the span's corners swap.
    const [left, right] = inverted ? [crop.width - span.x1, crop.width - span.x0] : [span.x0, span.x1]
    const [top, bottom] = inverted ? [crop.height - span.y1, crop.height - span.y0] : [span.y0, span.y1]

    const toPage = (x: number, y: number): Point => {
        const [px, py] = geometry.map(x, y)
        return [px / scaleFactor, py / scaleFactor]
    }

    // An unrotated line maps by translation alone, so the word is axis-aligned
    // and its bounds say so directly. Going through `boxFromPolygon` would put
    // it through minAreaRect, which keeps width as the *longer* side -- turning
    // any word narrower than it is tall into a 90-degree rotation of itself.
    if (!rotated) {
        const [x0, y0] = toPage(left, top)
        const [x1, y1] = toPage(right, bottom)
        return boxFromBBox([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
    }

    const corners: Point[] = [
        toPage(left, top),
        toPage(right, top),
        toPage(right, bottom),
        toPage(left, bottom),
    ]
    return boxFromPolygon(corners, {})
}

interface ReadResult {
    text: string
    score: number
}

/**
 * Read every crop, batching across them.
 *
 * ppu batches `recBatchSize` crops into a single inference, but only within one
 * `run()` call, and `run()` cuts its crops out of the one canvas it is given. So
 * the crops are stacked onto sheet canvases -- each at x 0, one below the last --
 * and handed back as the boxes to read. ppu re-crops exactly those rects, so the
 * unused width beside a narrow crop is never sampled. Calling `run()` once per
 * box would instead pay one inference, and one main-thread yield, per line.
 *
 * Results come back index-aligned to `crops`; a crop ppu rejected or did not
 * return is left `undefined`. `run()` sorts what it returns into reading order,
 * so results are matched on the slot's y offset, never on array position.
 */
async function recognizeCrops(
    recognition: PaddleRecognitionService,
    crops: readonly OffscreenCanvas[],
    ctx: StageContext
): Promise<(ReadResult | undefined)[]> {
    const out: (ReadResult | undefined)[] = new Array(crops.length)

    for (let start = 0; start < crops.length; ) {
        ctx.signal?.throwIfAborted()

        // Take as many crops as fit on one sheet, but always at least one, so a
        // crop taller than the ceiling is still read.
        let end = start
        let height = 0
        let width = 0
        while (end < crops.length) {
            const crop = crops[end] as OffscreenCanvas
            if (end > start && height + crop.height > MAX_SHEET_HEIGHT) break
            height += crop.height
            width = Math.max(width, crop.width)
            end++
        }

        const sheet = createCanvas(width, height)
        const sheetCtx = context2d(sheet)
        const slots: { x: number; y: number; width: number; height: number }[] = []
        const atOffset = new Map<number, number>()
        let offset = 0
        for (let i = start; i < end; i++) {
            const crop = crops[i] as OffscreenCanvas
            sheetCtx.drawImage(crop, 0, offset)
            slots.push({ x: 0, y: offset, width: crop.width, height: crop.height })
            atOffset.set(offset, i)
            offset += crop.height
        }

        const results = await recognition.run(sheet as never, slots, undefined, 'per-box')
        for (const result of results) {
            const index = atOffset.get(result.box.y)
            if (index !== undefined) out[index] = { text: result.text.trim(), score: result.confidence }
        }

        start = end
    }

    return out
}
