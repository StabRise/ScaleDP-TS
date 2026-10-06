/**
 * Lengthening regions along their lines: far enough to take in a capital the
 * detector left off, never into the next region on the line.
 */
import { describe, expect, it } from 'vitest'
import { extendAlongText } from '../../src/ocr/extend-regions.js'
import { type Box, createBox } from '../../src/schemas/box.js'

/** The boxes, which the input always has as many of. */
const grown = (boxes: Box[], ratio: number) => extendAlongText(boxes, ratio) as [Box, Box, ...Box[]]

const box = (x: number, y: number, width: number, height: number, angle = 0) =>
    createBox({ x, y, width, height, angle, score: 1 })

describe('extendAlongText', () => {
    it('extends both ends by a fraction of the height', () => {
        // A 40px-tall line gains 12px at each end, enough for a looping capital.
        const [line] = grown([box(100, 100, 200, 40)], 0.3)
        expect(line).toMatchObject({ x: 88, width: 224, y: 100, height: 40 })
    })

    it('stops at the next region on the same line', () => {
        // Two table cells 5px apart: each may grow into the gap, not across it.
        const [left, right] = grown([box(100, 100, 100, 40), box(205, 100, 100, 40)], 0.3)
        expect(left.x + left.width).toBe(205)
        expect(right.x).toBe(200)
        expect(left.x).toBe(88)
    })

    it('ignores regions on other lines', () => {
        const [line] = grown([box(100, 100, 200, 40), box(310, 200, 100, 40)], 0.3)
        expect(line.width).toBe(224)
    })

    it('never shrinks a region that already overlaps its neighbour', () => {
        const [line] = grown([box(100, 100, 200, 40), box(290, 100, 100, 40)], 0.3)
        expect(line.x + line.width).toBe(300)
    })

    it('grows a rotated region about its centre, keeping its angle', () => {
        const turned = box(100, 100, 200, 40, 90)
        const [turnedGrown] = grown([turned], 0.3)
        expect(turnedGrown).toMatchObject({ angle: 90, width: 224, height: 40 })
        expect(turnedGrown.x + turnedGrown.width / 2).toBe(turned.x + turned.width / 2)
    })

    it('does nothing at 0', () => {
        const boxes = [box(100, 100, 200, 40)]
        expect(extendAlongText(boxes, 0)).toEqual(boxes)
    })
})
