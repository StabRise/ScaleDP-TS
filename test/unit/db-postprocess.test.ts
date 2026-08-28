/**
 * Parity against Python's DBNet post-processing
 * (scaledp/models/detectors/paddle_onnx/db_postprocess.py).
 *
 * Goldens come from running the real Python code; see
 * test/fixtures/generate-db-goldens.py.
 */
import { describe, expect, it } from 'vitest'
import type { Point } from '../../src/core/geometry.js'
import {
    boxScore,
    miniBox,
    orderPointsClockwise,
    type ProbabilityMap,
    quadsFromProbabilityMap,
    unclipRect,
} from '../../src/ocr/db-postprocess.js'
import goldens from '../fixtures/db-goldens.json' with { type: 'json' }

type Golden =
    | { fn: 'get_mini_boxes'; args: { points: number[][] }; expected: { points: number[][]; sside: number } }
    | {
          fn: 'unclip_minibox'
          args: { points: number[][]; unclip_ratio: number }
          expected: { points: number[][]; sside: number }
      }
    | {
          fn: 'box_score_fast'
          args: { map: number[][]; width: number; height: number; points: number[][] }
          expected: number
      }
    | { fn: 'order_points_clockwise'; args: { points: number[][] }; expected: number[][] }
    | {
          fn: 'boxes_from_bitmap'
          args: { map: number[][]; width: number; height: number; dest_width: number; dest_height: number }
          expected: { boxes: number[][][]; scores: number[] }
      }

const cases = goldens as unknown as Golden[]
const byFn = <T extends Golden['fn']>(fn: T) =>
    cases.filter((c): c is Extract<Golden, { fn: T }> => c.fn === fn)

/** cv2 works in float32 and rounds at .5 boundaries; allow a pixel either way. */
const PIXEL_TOLERANCE = 1

function toMap(rows: number[][], width: number, height: number): ProbabilityMap {
    const data = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) data[y * width + x] = (rows[y] as number[])[x] as number
    }
    return { data, width, height }
}

/** Compare corner sets without depending on which corner is listed first. */
function expectSameCorners(actual: readonly Point[], expected: number[][]) {
    expect(actual).toHaveLength(expected.length)
    const remaining = expected.map((p) => [...p])
    for (const [ax, ay] of actual) {
        const i = remaining.findIndex(
            ([ex = 0, ey = 0]) => Math.abs(ax - ex) <= PIXEL_TOLERANCE && Math.abs(ay - ey) <= PIXEL_TOLERANCE
        )
        expect(i, `no match for corner [${ax}, ${ay}] in ${JSON.stringify(expected)}`).toBeGreaterThanOrEqual(
            0
        )
        remaining.splice(i, 1)
    }
}

describe('DBNet post-processing parity with Python', () => {
    it('has goldens to check', () => {
        expect(cases.length).toBeGreaterThan(10)
    })

    describe('get_mini_boxes', () => {
        for (const [i, c] of byFn('get_mini_boxes').entries()) {
            it(`case ${i}`, () => {
                const result = miniBox(c.args.points as Point[])
                expectSameCorners(result.points, c.expected.points)
                expect(Math.abs(result.sside - c.expected.sside)).toBeLessThanOrEqual(PIXEL_TOLERANCE)
            })
        }

        it('orders corners top-left, top-right, bottom-right, bottom-left', () => {
            const { points } = miniBox([
                [10, 10],
                [110, 10],
                [110, 50],
                [10, 50],
            ])
            const [tl, tr, br, bl] = points
            expect(tl[0]).toBeLessThan(tr[0])
            expect(bl[0]).toBeLessThan(br[0])
            expect(tl[1]).toBeLessThan(bl[1])
            expect(tr[1]).toBeLessThan(br[1])
        })
    })

    describe('unclip composed with get_mini_boxes', () => {
        for (const [i, c] of byFn('unclip_minibox').entries()) {
            it(`case ${i}: ratio=${c.args.unclip_ratio}`, () => {
                const expanded = miniBox(unclipRect(c.args.points as Point[], c.args.unclip_ratio))
                expectSameCorners(expanded.points, c.expected.points)
            })
        }

        it('always grows the box', () => {
            const original: Point[] = [
                [10, 10],
                [110, 10],
                [110, 50],
                [10, 50],
            ]
            expect(miniBox(unclipRect(original, 2.5)).sside).toBeGreaterThan(miniBox(original).sside)
        })
    })

    describe('box_score_fast', () => {
        for (const [i, c] of byFn('box_score_fast').entries()) {
            it(`case ${i}`, () => {
                const map = toMap(c.args.map, c.args.width, c.args.height)
                expect(boxScore(map, c.args.points as Point[])).toBeCloseTo(c.expected, 3)
            })
        }
    })

    describe('order_points_clockwise', () => {
        for (const [i, c] of byFn('order_points_clockwise').entries()) {
            it(`case ${i}`, () => {
                expect(orderPointsClockwise(c.args.points as Point[])).toEqual(
                    c.expected.map((p) => [p[0], p[1]])
                )
            })
        }
    })

    describe('full pipeline (boxes_from_bitmap)', () => {
        for (const [i, c] of byFn('boxes_from_bitmap').entries()) {
            it(`case ${i}: ${c.expected.boxes.length} box(es)`, () => {
                const map = toMap(c.args.map, c.args.width, c.args.height)
                const quads = quadsFromProbabilityMap(
                    map,
                    { width: c.args.dest_width, height: c.args.dest_height },
                    1
                )
                expect(quads).toHaveLength(c.expected.boxes.length)

                // cv2.findContours emits contours in its own scan order, which
                // is an implementation artifact rather than anything semantic.
                // Compare the box *sets*, keyed by top-left corner.
                const key = (p: readonly number[][]) => {
                    const x = Math.min(...p.map((q) => q[0] as number))
                    const y = Math.min(...p.map((q) => q[1] as number))
                    return `${x},${y}`
                }
                const actual = quads
                    .map((q, k) => ({ points: q.points, score: q.score, k }))
                    .sort((a, b) => key(a.points).localeCompare(key(b.points)))
                const expected = c.expected.boxes
                    .map((points, k) => ({ points, score: c.expected.scores[k] as number }))
                    .sort((a, b) => key(a.points).localeCompare(key(b.points)))

                for (const [k, quad] of actual.entries()) {
                    const want = expected[k] as { points: number[][]; score: number }
                    expectSameCorners(quad.points, want.points)
                    expect(quad.score).toBeCloseTo(want.score, 3)
                }
            })
        }
    })
})
