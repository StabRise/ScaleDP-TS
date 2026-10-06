/**
 * Growing boxes to their ink, against hand-painted grayscale pages: a capital
 * standing apart from its word, a descender, a neighbouring line, an underline,
 * white text on black, a rotated line.
 */
import { describe, expect, it } from 'vitest'
import { createBox } from '../../src/schemas/box.js'
import { FitBoxesToInk, fitBoxesToInk, fitBoxToInk, type Luma } from '../../src/stages/fit-boxes-to-ink.js'

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
