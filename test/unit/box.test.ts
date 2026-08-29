import { describe, expect, it } from 'vitest'
import type { Point } from '../../src/core/geometry.js'
import {
    type Box,
    bbox,
    boxFromBBox,
    boxFromPolygon,
    boxIou,
    createBox,
    isOnSameLine,
    isRotated,
    mergeBoxes,
    mergeOverlappingBoxes,
    scaleBox,
    shape,
} from '../../src/schemas/box.js'

/** Rotate an axis-aligned rect about its centre; returns 4 corner points. */
function rotatedCorners(cx: number, cy: number, w: number, h: number, deg: number): Point[] {
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    return (
        [
            [-w / 2, -h / 2],
            [w / 2, -h / 2],
            [w / 2, h / 2],
            [-w / 2, h / 2],
        ] as Point[]
    ).map(([x, y]) => [x * cos - y * sin + cx, x * sin + y * cos + cy] as Point)
}

describe('boxFromPolygon', () => {
    it('rejects anything other than 4 points', () => {
        expect(() =>
            boxFromPolygon([
                [0, 0],
                [1, 1],
                [2, 2],
            ])
        ).toThrow(/exactly 4 points/)
    })

    it('derives x/y from the centre, not the polygon bounding box', () => {
        // A 45-degree diamond of side ~14.14: its axis-aligned envelope is 20x20,
        // but the min-area rect is 14.14x14.14 centred at (10, 10).
        const box = boxFromPolygon([
            [10, 0],
            [20, 10],
            [10, 20],
            [0, 10],
        ])
        expect(box.width).toBe(14)
        expect(box.height).toBe(14)
        expect(box.x).toBe(3)
        expect(box.y).toBe(3)
    })

    it('forces width to be the longer side', () => {
        // Tall, upright rect: width/height must come back swapped.
        const box = boxFromPolygon(rotatedCorners(100, 100, 20, 80, 0))
        expect(box.width).toBe(80)
        expect(box.height).toBe(20)
    })

    it('normalises the angle into (-90, 270]', () => {
        for (const deg of [0, 10, 45, 89, 91, 135, 180, 269, 350]) {
            const box = boxFromPolygon(rotatedCorners(200, 300, 100, 20, deg))
            expect(box.angle).toBeGreaterThan(-90)
            expect(box.angle).toBeLessThanOrEqual(270)
            expect(box.width).toBe(100)
            expect(box.height).toBe(20)
        }
    })

    it('clamps degenerate boxes to at least 1px', () => {
        const box = boxFromPolygon([
            [5, 5],
            [5, 5],
            [5, 5],
            [5, 5],
        ])
        expect(box.width).toBeGreaterThanOrEqual(1)
        expect(box.height).toBeGreaterThanOrEqual(1)
    })

    it('applies padding symmetrically', () => {
        const plain = boxFromPolygon(rotatedCorners(100, 100, 40, 20, 0))
        const padded = boxFromPolygon(rotatedCorners(100, 100, 40, 20, 0), { padding: 5 })
        expect(padded.width).toBe(plain.width + 10)
        expect(padded.height).toBe(plain.height + 10)
        expect(padded.x).toBe(plain.x - 5)
        expect(padded.y).toBe(plain.y - 5)
    })
})

describe('geometry accessors', () => {
    const box: Box = createBox({ x: 10, y: 20, width: 100, height: 40 })

    it('computes bbox and shape with padding', () => {
        expect(bbox(box)).toEqual([10, 20, 110, 60])
        expect(bbox(box, 5)).toEqual([5, 15, 115, 65])
        expect(shape(box)).toEqual([
            [10, 20],
            [110, 60],
        ])
    })

    it('scales origin inward and size outward, as Python does', () => {
        const scaled = scaleBox(box, 2, 5)
        expect(scaled.x).toBe(15) // 10*2 - 5
        expect(scaled.y).toBe(35) // 20*2 - 5
        expect(scaled.width).toBe(205) // 100*2 + 5
        expect(scaled.height).toBe(85) // 40*2 + 5
    })

    it('treats angles below 3 degrees as upright', () => {
        expect(isRotated(createBox({ angle: 2.9 }))).toBe(false)
        expect(isRotated(createBox({ angle: 3 }))).toBe(true)
        expect(isRotated(createBox({ angle: -3 }))).toBe(true)
    })

    it('builds from an xyxy bbox', () => {
        expect(boxFromBBox([10, 20, 110, 60])).toMatchObject({
            x: 10,
            y: 20,
            width: 100,
            height: 40,
            angle: 0,
        })
    })
})

describe('boxIou', () => {
    it('is 1 for identical boxes and 0 for disjoint ones', () => {
        const a = createBox({ x: 0, y: 0, width: 10, height: 10 })
        expect(boxIou(a, a)).toBeCloseTo(1, 9)
        expect(boxIou(a, createBox({ x: 100, y: 100, width: 10, height: 10 }))).toBe(0)
    })

    it('computes partial overlap', () => {
        const a = createBox({ x: 0, y: 0, width: 10, height: 10 })
        const b = createBox({ x: 5, y: 0, width: 10, height: 10 })
        // intersection 50, union 150
        expect(boxIou(a, b)).toBeCloseTo(50 / 150, 9)
    })

    it('ignores angle, matching Python', () => {
        const a = createBox({ x: 0, y: 0, width: 10, height: 10, angle: 0 })
        const b = createBox({ x: 0, y: 0, width: 10, height: 10, angle: 45 })
        expect(boxIou(a, b)).toBeCloseTo(1, 9)
    })
})

describe('merging', () => {
    it('unions geometry and resets angle to 0', () => {
        const merged = mergeBoxes(
            createBox({ x: 0, y: 0, width: 10, height: 10, angle: 30, text: 'a', score: 0.9 }),
            createBox({ x: 20, y: 5, width: 10, height: 10, angle: 30, text: 'b', score: 0.5 })
        )
        expect(merged).toMatchObject({ x: 0, y: 0, width: 30, height: 15, angle: 0, text: 'a b' })
        expect(merged.score).toBeCloseTo(0.5, 9)
    })

    it('groups boxes on the same line by vertical centre', () => {
        const a = createBox({ x: 0, y: 0, width: 20, height: 10 })
        const sameLine = createBox({ x: 25, y: 2, width: 20, height: 10 })
        const otherLine = createBox({ x: 25, y: 40, width: 20, height: 10 })
        expect(isOnSameLine(a, sameLine)).toBe(true)
        expect(isOnSameLine(a, otherLine)).toBe(false)
    })

    it('rejects boxes whose angles differ beyond the threshold', () => {
        const a = createBox({ x: 0, y: 0, width: 20, height: 10, angle: 0 })
        const b = createBox({ x: 0, y: 0, width: 20, height: 10, angle: 45 })
        expect(isOnSameLine(a, b)).toBe(false)
    })

    it('collapses a chain of overlapping boxes in one pass', () => {
        const boxes = [
            createBox({ x: 0, y: 0, width: 20, height: 10, text: 'a' }),
            createBox({ x: 10, y: 0, width: 20, height: 10, text: 'b' }),
            createBox({ x: 20, y: 0, width: 20, height: 10, text: 'c' }),
        ]
        const merged = mergeOverlappingBoxes(boxes, 0.02)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.width).toBe(40)
    })

    it('leaves non-overlapping boxes alone', () => {
        const boxes = [
            createBox({ x: 0, y: 0, width: 10, height: 10 }),
            createBox({ x: 100, y: 0, width: 10, height: 10 }),
        ]
        expect(mergeOverlappingBoxes(boxes)).toHaveLength(2)
    })
})
