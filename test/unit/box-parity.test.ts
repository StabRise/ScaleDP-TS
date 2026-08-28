/**
 * Parity against the real Python ScaleDP `Box` implementation.
 *
 * `box-goldens.json` is produced by running the actual Python code
 * (test/fixtures/generate-box-goldens.sh), so a divergence here means the port
 * drifted from ScaleDP, not that a hand-written expectation was wrong.
 */
import { describe, expect, it } from 'vitest'
import type { Point } from '../../src/core/geometry.js'
import {
    type Box,
    boxFromPolygon,
    boxIou,
    isOnSameLine,
    mergeOverlappingBoxes,
    scaleBox,
} from '../../src/schemas/box.js'
import goldens from '../fixtures/box-goldens.json' with { type: 'json' }

type Golden =
    | { fn: 'from_polygon'; args: { points: number[][]; padding: number }; expected: Box }
    | { fn: 'iou'; args: { a: Box; b: Box }; expected: number }
    | { fn: 'scale'; args: { box: Box; factor: number; padding: number }; expected: Box }
    | { fn: 'is_on_same_line'; args: { a: Box; b: Box }; expected: boolean }
    | {
          fn: 'merge_overlapping_boxes'
          args: { boxes: Box[]; iou_threshold: number }
          expected: Box[]
      }

const cases = goldens as unknown as Golden[]
const byFn = <T extends Golden['fn']>(fn: T) =>
    cases.filter((c): c is Extract<Golden, { fn: T }> => c.fn === fn)

/**
 * cv2 computes minAreaRect in float32 while we use float64, so a value landing
 * exactly on a .5 rounding boundary can round the other way. Allow 1px on the
 * integer fields and a small absolute angle tolerance; anything larger is a
 * genuine divergence from ScaleDP.
 */
const PIXEL_TOLERANCE = 1
const ANGLE_TOLERANCE_DEGREES = 1e-3

function expectWithin(actual: number, expected: number, tolerance: number, field: string) {
    expect(
        Math.abs(actual - expected),
        `${field}: expected ${expected}, received ${actual}`
    ).toBeLessThanOrEqual(tolerance)
}

function expectBoxEqual(actual: Box, expected: Box) {
    expectWithin(actual.x, expected.x, PIXEL_TOLERANCE, 'x')
    expectWithin(actual.y, expected.y, PIXEL_TOLERANCE, 'y')
    expectWithin(actual.width, expected.width, PIXEL_TOLERANCE, 'width')
    expectWithin(actual.height, expected.height, PIXEL_TOLERANCE, 'height')

    // A rectangle is invariant under a 180-degree rotation about its own centre,
    // so `angle` and `angle + 180` describe the identical box and cv2 picks
    // between them arbitrarily for axis-aligned input (it returns -0.0 for one
    // orientation and 90 for the other). A square is invariant under 90 degrees
    // as well. Compare within the shape's own symmetry group rather than
    // pretending the representation cv2 happened to choose is meaningful.
    const period = Math.abs(expected.width - expected.height) <= PIXEL_TOLERANCE ? 90 : 180
    const delta = (((actual.angle - expected.angle) % period) + period) % period
    expect(
        Math.min(delta, period - delta),
        `angle: expected ${expected.angle} (mod ${period}), received ${actual.angle}`
    ).toBeLessThanOrEqual(ANGLE_TOLERANCE_DEGREES)
}

describe('Box parity with Python ScaleDP', () => {
    it('has goldens to check', () => {
        expect(cases.length).toBeGreaterThan(50)
    })

    describe('from_polygon', () => {
        for (const [i, c] of byFn('from_polygon').entries()) {
            it(`case ${i}: padding=${c.args.padding}`, () => {
                const box = boxFromPolygon(c.args.points as Point[], { padding: c.args.padding })
                expectBoxEqual(box, c.expected)
            })
        }
    })

    describe('iou', () => {
        for (const [i, c] of byFn('iou').entries()) {
            it(`case ${i}`, () => {
                expect(boxIou(c.args.a, c.args.b)).toBeCloseTo(c.expected, 9)
            })
        }
    })

    describe('scale', () => {
        for (const [i, c] of byFn('scale').entries()) {
            it(`case ${i}: factor=${c.args.factor} padding=${c.args.padding}`, () => {
                expectBoxEqual(scaleBox(c.args.box, c.args.factor, c.args.padding), c.expected)
            })
        }
    })

    describe('is_on_same_line', () => {
        for (const [i, c] of byFn('is_on_same_line').entries()) {
            it(`case ${i}`, () => {
                expect(isOnSameLine(c.args.a, c.args.b)).toBe(c.expected)
            })
        }
    })

    describe('merge_overlapping_boxes', () => {
        for (const [i, c] of byFn('merge_overlapping_boxes').entries()) {
            it(`case ${i}: threshold=${c.args.iou_threshold}`, () => {
                const merged = mergeOverlappingBoxes(c.args.boxes, c.args.iou_threshold)
                expect(merged).toHaveLength(c.expected.length)
                for (const [k, box] of merged.entries()) {
                    expectBoxEqual(box, c.expected[k] as Box)
                }
            })
        }
    })
})
