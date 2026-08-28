import { describe, expect, it } from 'vitest'
import {
    boxPoints,
    convexHull,
    minAreaRect,
    type Point,
    polygonArea,
    polygonPerimeter,
} from '../../src/core/geometry.js'

describe('convexHull', () => {
    it('drops interior points', () => {
        const pts: Point[] = [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [5, 5],
        ]
        expect(convexHull(pts)).toHaveLength(4)
    })

    it('handles duplicates and degenerate input', () => {
        expect(
            convexHull([
                [1, 1],
                [1, 1],
            ])
        ).toEqual([[1, 1]])
        expect(convexHull([])).toEqual([])
    })
})

describe('minAreaRect', () => {
    it('recovers an axis-aligned rectangle', () => {
        const rect = minAreaRect([
            [0, 0],
            [100, 0],
            [100, 20],
            [0, 20],
        ])
        expect(rect.center[0]).toBeCloseTo(50, 6)
        expect(rect.center[1]).toBeCloseTo(10, 6)
        expect(Math.max(...rect.size)).toBeCloseTo(100, 6)
        expect(Math.min(...rect.size)).toBeCloseTo(20, 6)
        expect(rect.angle).toBeGreaterThan(0)
        expect(rect.angle).toBeLessThanOrEqual(90)
    })

    it('normalises the angle into (0, 90] like cv2', () => {
        for (const deg of [0, 15, 30, 45, 60, 75, 100, 170, -30]) {
            const rad = (deg * Math.PI) / 180
            const cos = Math.cos(rad)
            const sin = Math.sin(rad)
            const corners: Point[] = [
                [-50, -10],
                [50, -10],
                [50, 10],
                [-50, 10],
            ].map(([x, y]) => [
                (x as number) * cos - (y as number) * sin + 200,
                (x as number) * sin + (y as number) * cos + 300,
            ]) as Point[]

            const rect = minAreaRect(corners)
            expect(rect.angle).toBeGreaterThan(0)
            expect(rect.angle).toBeLessThanOrEqual(90)
            expect(rect.center[0]).toBeCloseTo(200, 5)
            expect(rect.center[1]).toBeCloseTo(300, 5)
            expect(Math.max(...rect.size)).toBeCloseTo(100, 5)
            expect(Math.min(...rect.size)).toBeCloseTo(20, 5)
        }
    })

    it('finds the tight rect for a rotated square, not the axis-aligned envelope', () => {
        // A 45-degree diamond: the axis-aligned envelope has area 200,
        // the true minimum-area rect has area 100.
        const rect = minAreaRect([
            [10, 0],
            [20, 10],
            [10, 20],
            [0, 10],
        ])
        expect(rect.size[0] * rect.size[1]).toBeCloseTo(200, 4)
    })
})

describe('boxPoints', () => {
    it('round-trips through minAreaRect', () => {
        const original: Point[] = [
            [10, 5],
            [110, 5],
            [110, 45],
            [10, 45],
        ]
        const pts = boxPoints(minAreaRect(original))
        expect(pts).toHaveLength(4)
        // Same corner set, order aside.
        const key = (p: Point) => `${Math.round(p[0])},${Math.round(p[1])}`
        expect(new Set(pts.map(key))).toEqual(new Set(original.map(key)))
    })
})

describe('polygon measures', () => {
    it('computes area and perimeter regardless of winding', () => {
        const square: Point[] = [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]
        expect(polygonArea(square)).toBeCloseTo(100, 9)
        expect(polygonArea([...square].reverse())).toBeCloseTo(100, 9)
        expect(polygonPerimeter(square)).toBeCloseTo(40, 9)
    })
})
