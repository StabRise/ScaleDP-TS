/**
 * Grow boxes until they cover the ink they belong to.
 *
 * Every source of boxes reports them a little short of the glyphs. A text
 * detector misses the thin, isolated strokes at a line's ends -- the looping
 * capital of handwriting, a swash -- because they score low on its probability
 * map. A PDF text layer sizes boxes from font metrics, which a script font's
 * flourishes and a descender routinely overrun. For reading, a clipped capital
 * turns `Freya` into `reya`; for redaction, a box short of its text leaves the
 * edge of a name showing.
 *
 * So each box is checked against the pixels. Ink is told from background
 * locally -- the background is the median brightness of a thin ring just
 * outside the box, ink is what differs from it by at least half the contrast
 * the box's own ink has -- which handles
 * dark-on-light, light-on-dark and coloured highlights alike, and leaves a
 * low-contrast box alone rather than guessing. Then each edge steps outwards
 * while the line of pixels just past it still has ink:
 *
 * - along the text, across blank gaps narrower than a word space, which is what
 *   reaches a capital written a little apart from the rest of its word;
 * - across the text, to the first blank row only, so two lines never merge.
 *
 * Growth is capped per side, so a table rule or an underline running out of a
 * box cannot drag it across the page. The scan runs in the box's own frame,
 * along and across its line, so a rotated box is fitted as well as an upright
 * one. Boxes only ever grow.
 *
 * This stage has no equivalent in Python ScaleDP.
 */

import { ImageError, upstreamError } from '../core/errors.js'
import { boxPoints } from '../core/geometry.js'
import { decodeImage, toImageData } from '../core/image.js'
import { assertInRange, BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import { type Box, bbox, isRotated } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import { createDocument, type Document } from '../schemas/document.js'
import type { ScaleDpImage } from '../schemas/image.js'

export interface FitBoxesToInkParams extends BaseStageParams {
    /** `[imageColumn, boxColumn]`. The boxes must be in that image's pixels. */
    inputCols: string[]
    /** Most a box may grow along its text, per side, as a fraction of its height. */
    maxGrowAlong: number
    /** Most a box may grow across its text, per side, as a fraction of its height. */
    maxGrowAcross: number
    /** Blank gap along the text that is still crossed, as a fraction of height. A word space is about 0.25. */
    gapRatio: number
}

export const FIT_BOXES_TO_INK_DEFAULTS: FitBoxesToInkParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'image',
    inputCols: ['image', 'boxes'],
    // Fitted in place by default, so the stage drops in after a detector or a
    // merge with nothing downstream rewired. Set it to the box column you read.
    outputCol: 'boxes',
    keepInputData: true,
    maxGrowAlong: 0.75,
    maxGrowAcross: 0.5,
    gapRatio: 0.15,
})

/** A grayscale image: one byte of brightness per pixel, row-major. */
export interface Luma {
    data: Uint8Array
    width: number
    height: number
}

/** Rec. 601 brightness of an RGBA image, with transparent pixels read as white. */
export function toLuma(image: ImageData): Luma {
    const { data, width, height } = image
    const out = new Uint8Array(width * height)
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
        const alpha = (data[i + 3] as number) / 255
        const y =
            0.299 * (data[i] as number) + 0.587 * (data[i + 1] as number) + 0.114 * (data[i + 2] as number)
        out[p] = Math.round(y * alpha + 255 * (1 - alpha))
    }
    return { data: out, width, height }
}

export interface FitOptions {
    maxGrowAlong?: number
    maxGrowAcross?: number
    gapRatio?: number
    /**
     * Most each edge may move, in pixels, in the box's own frame: left and
     * right along the text, top and bottom across it. `fitBoxesToInk` sets these
     * to the gaps to the neighbouring boxes, so a box never grows into ink that
     * belongs to another one.
     */
    limits?: { left?: number; right?: number; top?: number; bottom?: number }
}

/** Pixels of ink a line must hold to count, so a speck of noise does not. */
const MIN_INK_PIXELS = 2
/** Contrast below which a box is left alone: there is no ink to tell apart. */
const MIN_CONTRAST = 24

/**
 * One box, grown to its ink.
 *
 * Local frame: `u` runs along the text (the box's width), `v` across it, both
 * from the box centre; page = centre + u * along + v * across, the same turn
 * `boxOverlay` and `boxPoints` give a box.
 */
export function fitBoxToInk(luma: Luma, box: Box, options: FitOptions = {}): Box {
    const height = box.height
    if (height < 2 || box.width < 2) return box
    const maxAlong = (options.maxGrowAlong ?? FIT_BOXES_TO_INK_DEFAULTS.maxGrowAlong) * height
    const maxAcross = (options.maxGrowAcross ?? FIT_BOXES_TO_INK_DEFAULTS.maxGrowAcross) * height
    const gap = Math.round((options.gapRatio ?? FIT_BOXES_TO_INK_DEFAULTS.gapRatio) * height)

    const rad = (box.angle * Math.PI) / 180
    const along: [number, number] = [Math.cos(rad), Math.sin(rad)]
    const across: [number, number] = [-Math.sin(rad), Math.cos(rad)]
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    const sample = (u: number, v: number): number => {
        // Floored: a sample at a pixel's centre lands on that pixel.
        const x = Math.floor(cx + u * along[0] + v * across[0])
        const y = Math.floor(cy + u * along[1] + v * across[1])
        if (x < 0 || y < 0 || x >= luma.width || y >= luma.height) return -1
        return luma.data[y * luma.width + x] as number
    }

    let u0 = -box.width / 2
    let u1 = box.width / 2
    let v0 = -height / 2
    let v1 = height / 2

    // The background from a thin ring just outside the box: there it is the
    // great majority even where a stroke escapes, while inside a tight box
    // around bold text the ink can be the majority and would be read as paper.
    const ring: number[] = []
    for (const d of [2, 3]) {
        const stepU = Math.max(1, box.width / 40)
        const stepV = Math.max(1, height / 10)
        for (let u = u0 - d; u <= u1 + d; u += stepU) ring.push(sample(u, v0 - d), sample(u, v1 + d))
        for (let v = v0 - d; v <= v1 + d; v += stepV) ring.push(sample(u0 - d, v), sample(u1 + d, v))
    }
    const outside = ring.filter((value) => value >= 0).sort((a, b) => a - b)
    if (outside.length === 0) return box
    const background = outside[outside.length >> 1] as number

    // The ink's contrast from inside the box, on a grid of ~400 samples.
    const deviations: number[] = []
    const stepU = Math.max(1, box.width / 20)
    const stepV = Math.max(1, height / 20)
    for (let u = u0; u <= u1; u += stepU) {
        for (let v = v0; v <= v1; v += stepV) {
            const value = sample(u, v)
            if (value >= 0) deviations.push(Math.abs(value - background))
        }
    }
    if (deviations.length === 0) return box
    deviations.sort((a, b) => a - b)
    const contrast = deviations[Math.floor(deviations.length * 0.95)] as number
    if (contrast < MIN_CONTRAST) return box
    const threshold = Math.max(MIN_CONTRAST, contrast / 2)
    const isInk = (value: number) => value >= 0 && Math.abs(value - background) >= threshold

    /** Ink pixels on the line `u = at`, across the current extent, or the line `v = at`. */
    const inkAcrossAt = (u: number) => {
        let n = 0
        for (let v = v0 + 0.5; v < v1; v++) if (isInk(sample(u, v))) n++
        return n
    }
    const inkAlongAt = (v: number) => {
        let n = 0
        for (let u = u0 + 0.5; u < u1; u++) if (isInk(sample(u, v))) n++
        return n
    }

    /** How far past `edge`, stepping by `dir`, the ink reaches -- crossing gaps up to `tolerance`. */
    const reach = (
        edge: number,
        dir: 1 | -1,
        limit: number,
        tolerance: number,
        count: (at: number) => number,
        minInk: number
    ) => {
        let last = 0
        let blank = 0
        for (let d = 1; d <= limit; d++) {
            // The centre of the d-th pixel line past the edge.
            if (count(edge + dir * (d - 0.5)) >= minInk) {
                last = d
                blank = 0
            } else if (++blank > tolerance) {
                break
            }
        }
        return last
    }

    // A column needs a tenth of the line's height in ink to carry the box along:
    // a capital's stroke has that, an underline or a table rule running out of
    // the box -- one or two pixels thick -- does not, and so cannot drag it.
    const minInkAcross = Math.max(MIN_INK_PIXELS, Math.ceil(height * 0.1))

    // Twice round: a swash that leaves the box at a corner is reached along the
    // text first, then its top across it.
    const limits = options.limits ?? {}
    const budget = (cap: number, limit: number | undefined, used: number) =>
        Math.floor(Math.min(cap, limit ?? Number.POSITIVE_INFINITY) - used)

    for (let pass = 0; pass < 2; pass++) {
        const grownLeft = reach(
            u0,
            -1,
            budget(maxAlong, limits.left, -box.width / 2 - u0),
            gap,
            inkAcrossAt,
            minInkAcross
        )
        const grownRight = reach(
            u1,
            1,
            budget(maxAlong, limits.right, u1 - box.width / 2),
            gap,
            inkAcrossAt,
            minInkAcross
        )
        u0 -= grownLeft
        u1 += grownRight
        const grownTop = reach(
            v0,
            -1,
            budget(maxAcross, limits.top, -height / 2 - v0),
            0,
            inkAlongAt,
            MIN_INK_PIXELS
        )
        const grownBottom = reach(
            v1,
            1,
            budget(maxAcross, limits.bottom, v1 - height / 2),
            0,
            inkAlongAt,
            MIN_INK_PIXELS
        )
        v0 -= grownTop
        v1 += grownBottom
        if (grownLeft + grownRight + grownTop + grownBottom === 0) break
    }

    if (u0 === -box.width / 2 && u1 === box.width / 2 && v0 === -height / 2 && v1 === height / 2) return box
    const width = u1 - u0
    const grownHeight = v1 - v0
    const mu = (u0 + u1) / 2
    const mv = (v0 + v1) / 2
    const ncx = cx + mu * along[0] + mv * across[0]
    const ncy = cy + mu * along[1] + mv * across[1]
    const x = ncx - width / 2
    const y = ncy - grownHeight / 2
    if (box.angle !== 0) return { ...box, x, y, width, height: grownHeight }
    // Upright boxes stay on whole pixels, rounded outwards so the ink stays
    // inside: the trigonometry above leaves 158.99836... where 159 was meant.
    const x0 = Math.floor(x + 1e-6)
    const y0 = Math.floor(y + 1e-6)
    const x1 = Math.ceil(x + width - 1e-6)
    const y1 = Math.ceil(y + grownHeight - 1e-6)
    return { ...box, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Every box, grown to its ink. */
/** The axis-aligned bounds of a box, rotated or not. */
function envelope(box: Box): [number, number, number, number] {
    if (!isRotated(box)) return bbox(box)
    const corners = boxPoints({
        center: [box.x + box.width / 2, box.y + box.height / 2],
        size: [box.width, box.height],
        angle: box.angle,
    })
    const xs = corners.map(([x]) => x)
    const ys = corners.map(([, y]) => y)
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * Every box, grown to its ink -- and never into another box.
 *
 * Without that guard a box takes its neighbour's ink for its own: in a PDF
 * text layer each word's box runs to the next word's start, so the gap between
 * them is a few pixels, well within the letter-gap tolerance, and every word
 * would grow into the next. So each edge may move at most to the nearest box
 * beyond it -- along the line for left and right, among boxes overlapping it
 * horizontally for top and bottom. A box counts as beyond an edge only when its
 * centre is, so a duplicate stacked on the same spot does not pin the box in
 * place. A rotated box is fitted without neighbour limits, its sides not being
 * the page's -- but it still limits the upright boxes around it.
 */
export function fitBoxesToInk(luma: Luma, boxes: readonly Box[], options: FitOptions = {}): Box[] {
    // Every box is a neighbour by the page area it covers -- a rotated one by
    // its axis-aligned envelope -- since a turned word's ink is ink all the same.
    const frames = boxes.map(envelope)
    return boxes.map((box, index) => {
        if (isRotated(box)) return fitBoxToInk(luma, box, options)
        const [x0, y0, x1, y1] = frames[index] as [number, number, number, number]
        let left = Number.POSITIVE_INFINITY
        let right = Number.POSITIVE_INFINITY
        let top = Number.POSITIVE_INFINITY
        let bottom = Number.POSITIVE_INFINITY
        for (const [other, frame] of frames.entries()) {
            if (other === index) continue
            const [nx0, ny0, nx1, ny1] = frame
            const ncx = (nx0 + nx1) / 2
            const ncy = (ny0 + ny1) / 2
            const sameLine = Math.min(y1, ny1) - Math.max(y0, ny0) >= Math.min(y1 - y0, ny1 - ny0) * 0.5
            const sameColumn = Math.min(x1, nx1) - Math.max(x0, nx0) > 0
            if (sameLine && ncx < x0) left = Math.min(left, Math.max(0, x0 - nx1))
            if (sameLine && ncx > x1) right = Math.min(right, Math.max(0, nx0 - x1))
            if (sameColumn && ncy < y0) top = Math.min(top, Math.max(0, y0 - ny1))
            if (sameColumn && ncy > y1) bottom = Math.min(bottom, Math.max(0, ny0 - y1))
        }
        return fitBoxToInk(luma, box, { ...options, limits: { left, right, top, bottom } })
    })
}

type WithBoxes = (Document | DetectorOutput) & { bboxes: Box[] }

export class FitBoxesToInk extends Stage<FitBoxesToInkParams> {
    readonly name = 'FitBoxesToInk'

    constructor(options: Partial<FitBoxesToInkParams> = {}) {
        super(
            resolveParams(FIT_BOXES_TO_INK_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) throw new RangeError('inputCols must be [imageColumn, boxColumn]')
                },
                maxGrowAlong: (value) => assertInRange('maxGrowAlong', value, 0, 5),
                maxGrowAcross: (value) => assertInRange('maxGrowAcross', value, 0, 5),
                gapRatio: (value) => assertInRange('gapRatio', value, 0, 1),
            })
        )
    }

    protected async apply(_input: unknown, row: Row): Promise<WithBoxes> {
        const [imageCol, boxCol] = this.params.inputCols as [string, string]
        const image = row[imageCol] as ScaleDpImage | undefined
        const source = row[boxCol] as WithBoxes | undefined

        if (!source || !Array.isArray(source.bboxes)) {
            throw new ImageError(`Expected boxes in "${boxCol}"`, this.name)
        }
        // Either side failing upstream is reported once, as it came in.
        if (source.exception) {
            throw upstreamError(source.exception, this.name, (message) => new ImageError(message, this.name))
        }
        if (image?.exception) {
            throw upstreamError(image.exception, this.name, (message) => new ImageError(message, this.name))
        }
        if (!image || !(image.data instanceof Uint8Array) || image.data.byteLength === 0) {
            throw new ImageError(`Expected an Image with decoded bytes in "${imageCol}"`, this.name)
        }
        if (source.bboxes.length === 0) return source

        const bitmap = await decodeImage(image.data)
        let luma: Luma
        try {
            luma = toLuma(toImageData(bitmap))
        } finally {
            bitmap.close()
        }
        const { maxGrowAlong, maxGrowAcross, gapRatio } = this.params
        return {
            ...source,
            bboxes: fitBoxesToInk(luma, source.bboxes, { maxGrowAlong, maxGrowAcross, gapRatio }),
        }
    }

    protected onError(message: string, row: Row): WithBoxes {
        const [, boxCol] = this.params.inputCols as [string, string]
        const source = row[boxCol] as WithBoxes | undefined
        // The boxes as they came, with the failure recorded: a fitting pass that
        // cannot run must not cost the pipeline its reading.
        if (source && Array.isArray(source.bboxes)) return { ...source, exception: message }
        return createDocument({ path: String(row[this.params.pathCol] ?? 'memory'), exception: message })
    }
}
