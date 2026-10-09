/**
 * Growing boxes to their ink, against hand-painted grayscale pages: a capital
 * standing apart from its word, a descender, a neighbouring line, an underline,
 * white text on black, a rotated line.
 */
import { describe, expect, it } from 'vitest'
import { boxPoints } from '../../src/core/geometry.js'
import { type Box, bbox, createBox, isRotated } from '../../src/schemas/box.js'
import {
    FitBoxesToInk,
    fitBands,
    fitBoxesToInk,
    fitBoxToInk,
    fitRegion,
    type Luma,
    toLuma,
} from '../../src/stages/fit-boxes-to-ink.js'

/** A white page with the given rectangles painted in `ink`. */
function page(rects: [x: number, y: number, w: number, h: number][], ink = 0, paper = 255): Luma {
    const width = 600
    const height = 400
    const data = new Uint8Array(width * height).fill(paper)
    for (const [x, y, w, h] of rects) {
        for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) data[r * width + c] = ink
    }
    return { data, width, height }
}

/** "reya" as four 10px-wide letters with 4px gaps, x 100..152, y 100..129. */
const word: [number, number, number, number][] = [
    [100, 100, 10, 30],
    [114, 100, 10, 30],
    [128, 100, 10, 30],
    [142, 100, 10, 30],
]
const box = createBox({ x: 100, y: 100, width: 52, height: 30, score: 1 })
const edges = (b: ReturnType<typeof fitBoxToInk>) => ({
    left: Math.round(b.x),
    top: Math.round(b.y),
    right: Math.round(b.x + b.width),
    bottom: Math.round(b.y + b.height),
})

describe('fitBoxToInk', () => {
    it('leaves a box that already covers its ink alone', () => {
        expect(fitBoxToInk(page(word), box)).toBe(box)
    })

    it('reaches a capital written a little apart from its word', () => {
        // The F: ends 4px before the box, inside the 0.15 * 30 word-gap tolerance.
        const fitted = fitBoxToInk(page([...word, [84, 96, 12, 34]]), box)
        expect(edges(fitted)).toMatchObject({ left: 84, right: 152 })
        // ...and then its top, which rises above the line.
        expect(edges(fitted).top).toBe(96)
    })

    it('does not cross a word space to the previous word', () => {
        // 10px gap: a third of the height, a word space, not a letter gap.
        expect(fitBoxToInk(page([...word, [60, 100, 30, 30]]), box)).toBe(box)
    })

    it('takes in a descender', () => {
        const fitted = fitBoxToInk(page([...word, [128, 100, 4, 38]]), box)
        expect(edges(fitted)).toMatchObject({ top: 100, bottom: 138 })
    })

    it('never grows into the line above', () => {
        // One blank row between the lines is enough to stop at.
        const fitted = fitBoxToInk(page([...word, [100, 68, 52, 31]]), box)
        expect(edges(fitted).top).toBe(100)
    })

    it('is not dragged along an underline', () => {
        const fitted = fitBoxToInk(page([...word, [0, 130, 600, 2]]), box)
        expect(edges(fitted)).toMatchObject({ left: 100, right: 152 })
    })

    it('caps the growth however far the ink runs', () => {
        // Solid ink to the left: at most 0.75 * 30 = 22.5px along the text.
        const fitted = fitBoxToInk(page([...word, [0, 100, 99, 30]]), box)
        expect(box.x - fitted.x).toBeLessThanOrEqual(23)
    })

    it('reads white text on black', () => {
        const dark = page([[60, 80, 140, 70]], 0)
        // White letters on the black block, with the F apart from the rest.
        for (const [x, y, w, h] of [...word, [84, 96, 12, 34]] as const) {
            for (let r = y; r < y + h; r++)
                for (let c = x; c < x + w; c++) dark.data[r * dark.width + c] = 255
        }
        expect(edges(fitBoxToInk(dark, box)).left).toBe(84)
    })

    it('leaves a box with no contrast in it alone', () => {
        expect(fitBoxToInk(page(word, 240), box)).toBe(box)
    })

    it('fits a rotated line along its own direction', () => {
        // The same word written top to bottom: a 52x30 box turned 90 degrees
        // about its centre (126, 115) spans x 111..141, y 89..141.
        const turned = createBox({ x: 100, y: 100, width: 52, height: 30, angle: 90, score: 1 })
        const ink = page([
            [111, 89, 30, 52],
            // A capital beyond its start, 4px past the top end.
            [113, 73, 26, 12],
        ])
        const fitted = fitBoxToInk(ink, turned)
        expect(fitted.angle).toBe(90)
        expect(fitted.height).toBe(30)
        expect(fitted.width).toBeGreaterThanOrEqual(52 + 12)
    })
})

describe('fitBoxesToInk', () => {
    it('never grows a box into the next word, however close it sits', () => {
        // A text layer's boxes run to the next word's start: 3px apart here,
        // inside the letter-gap tolerance, so ink alone would merge them.
        const next: [number, number, number, number][] = [
            [155, 100, 10, 30],
            [169, 100, 10, 30],
        ]
        const [first, second] = fitBoxesToInk(page([...word, ...next]), [
            box,
            createBox({ x: 155, y: 100, width: 24, height: 30, score: 1 }),
        ])
        expect(first).toBe(box)
        expect(second?.x).toBe(155)
    })

    it('still reaches a missed capital in free space', () => {
        const [fitted] = fitBoxesToInk(page([...word, [84, 96, 12, 34]]), [box])
        expect(fitted?.x).toBe(84)
    })

    it('is not pinned by a duplicate stacked on the same spot', () => {
        // An invisible text layer's box over the OCR box for the same word.
        const duplicate = createBox({ x: 101, y: 101, width: 50, height: 28, score: 1 })
        const [fitted] = fitBoxesToInk(page([...word, [84, 96, 12, 34]]), [box, duplicate])
        expect(fitted?.x).toBe(84)
    })
})

describe('FitBoxesToInk', () => {
    it('rejects params it cannot honour', () => {
        expect(() => new FitBoxesToInk({ inputCols: ['image'] })).toThrow(/inputCols/)
        expect(() => new FitBoxesToInk({ gapRatio: 2 })).toThrow(/gapRatio/)
    })
})

/**
 * The fast path -- a region of the page instead of all of it, neighbours from
 * a grid instead of every pair -- against the straightforward version it
 * replaced, on random pages. They must agree box for box, bit for bit.
 */
describe('fitBoxesToInk, optimised', () => {
    /** The original: every pair compared, over a luma of the whole page. */
    function reference(luma: Luma, boxes: readonly Box[]): Box[] {
        const frame = (b: Box): [number, number, number, number] => {
            if (!isRotated(b)) return bbox(b)
            const corners = boxPoints({
                center: [b.x + b.width / 2, b.y + b.height / 2],
                size: [b.width, b.height],
                angle: b.angle,
            })
            const xs = corners.map(([x]) => x)
            const ys = corners.map(([, y]) => y)
            return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        }
        const frames = boxes.map(frame)
        return boxes.map((b, index) => {
            if (isRotated(b)) return fitBoxToInk(luma, b)
            const [x0, y0, x1, y1] = frames[index] as [number, number, number, number]
            let left = Number.POSITIVE_INFINITY
            let right = Number.POSITIVE_INFINITY
            let top = Number.POSITIVE_INFINITY
            let bottom = Number.POSITIVE_INFINITY
            for (const [other, [nx0, ny0, nx1, ny1]] of frames.entries()) {
                if (other === index) continue
                const ncx = (nx0 + nx1) / 2
                const ncy = (ny0 + ny1) / 2
                const sameLine = Math.min(y1, ny1) - Math.max(y0, ny0) >= Math.min(y1 - y0, ny1 - ny0) * 0.5
                const sameColumn = Math.min(x1, nx1) - Math.max(x0, nx0) > 0
                if (sameLine && ncx < x0) left = Math.min(left, Math.max(0, x0 - nx1))
                if (sameLine && ncx > x1) right = Math.min(right, Math.max(0, nx0 - x1))
                if (sameColumn && ncy < y0) top = Math.min(top, Math.max(0, y0 - ny1))
                if (sameColumn && ncy > y1) bottom = Math.min(bottom, Math.max(0, ny0 - y1))
            }
            return fitBoxToInk(luma, b, { limits: { left, right, top, bottom } })
        })
    }

    function lcg(seed: number): () => number {
        let state = seed
        return () => {
            state = (state * 1664525 + 1013904223) % 2 ** 32
            return state / 2 ** 32
        }
    }

    it('agrees with comparing every pair over the whole page', () => {
        const random = lcg(7)
        for (let trial = 0; trial < 25; trial++) {
            const width = 500
            const height = 400
            const data = new Uint8Array(width * height).fill(240)
            const boxes: Box[] = []
            const count = 5 + Math.floor(random() * 60)
            for (let i = 0; i < count; i++) {
                const w = 10 + Math.floor(random() * 80)
                const h = 8 + Math.floor(random() * 30)
                // Some boxes run off the page, some overlap, some are rotated.
                const x = Math.floor(random() * (width + 40)) - 20
                const y = Math.floor(random() * (height + 40)) - 20
                const ink = random() > 0.2 ? 20 : 250
                for (let r = Math.max(0, y - 3); r < Math.min(height, y + h + 3); r++) {
                    for (let c = Math.max(0, x - 4); c < Math.min(width, x + w + 4); c++) {
                        if ((c - x) % 7 < 4) data[r * width + c] = ink
                    }
                }
                const angle = random() > 0.85 ? Math.round((random() - 0.5) * 60) : 0
                boxes.push(createBox({ x: x + 2, y: y + 2, width: w - 4, height: h - 4, angle, score: 1 }))
            }
            const page: Luma = { data, width, height }

            const region = fitRegion(boxes, width, height)
            expect(region).not.toBeNull()
            const [left, top, right, bottom] = region as [number, number, number, number]
            // Only the bands the boxes reach are filled; the rest stay zero --
            // ink, were anything to sample them, which is what this checks.
            const crop = new Uint8Array((right - left) * (bottom - top))
            for (const [bandTop, bandBottom] of fitBands(boxes, [left, top, right, bottom])) {
                for (let r = bandTop; r < bandBottom; r++) {
                    crop.set(data.subarray(r * width + left, r * width + right), (r - top) * (right - left))
                }
            }
            const regional: Luma = { data: crop, width: right - left, height: bottom - top, left, top }

            expect(fitBoxesToInk(regional, boxes), `trial ${trial}`).toEqual(reference(page, boxes))
        }
    })

    it('converts RGBA to brightness exactly as the formula does', () => {
        const pixels = new Uint8ClampedArray(4 * 512)
        const random = lcg(3)
        for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(random() * 256)
        for (let i = 3; i < pixels.length; i += 8) pixels[i] = 255 // half opaque
        const luma = toLuma({ data: pixels, width: 512, height: 1 } as unknown as ImageData)
        for (let p = 0; p < 512; p++) {
            const i = p * 4
            const alpha = (pixels[i + 3] as number) / 255
            const y =
                0.299 * (pixels[i] as number) +
                0.587 * (pixels[i + 1] as number) +
                0.114 * (pixels[i + 2] as number)
            expect(luma.data[p]).toBe(Math.round(y * alpha + 255 * (1 - alpha)))
        }
    })
})
