/**
 * Parity against Python ScaleDP's text-reconstruction helpers.
 *
 * `text-goldens.json` comes from running the real Python code
 * (test/fixtures/generate-text-goldens.sh). These outputs feed NER character
 * offsets, so an off-by-one in spacing shifts every entity boundary.
 */
import { describe, expect, it } from 'vitest'
import {
    boxesToFormattedText,
    cluster,
    getCharacterWidth,
    getSize,
    groupBoxesIntoLines,
} from '../../src/core/text.js'
import { type Box, createBox } from '../../src/schemas/box.js'
import goldens from '../fixtures/text-goldens.json' with { type: 'json' }

type BoxArg = { text: string; x: number; y: number; width: number; height: number }

type Golden =
    | { fn: 'cluster'; args: { items: number[]; max_gap: number }; expected: number[][] }
    | { fn: 'get_size'; args: { items: number[] }; expected: number }
    | {
          fn: 'box_to_formatted_text'
          args: { boxes: BoxArg[]; line_tolerance: number }
          expected: string
      }
    | { fn: 'get_character_width'; args: { boxes: BoxArg[] }; expected: number }

const cases = goldens as unknown as Golden[]
const byFn = <T extends Golden['fn']>(fn: T) =>
    cases.filter((c): c is Extract<Golden, { fn: T }> => c.fn === fn)

const toBoxes = (args: BoxArg[]): Box[] => args.map((b) => createBox({ ...b, score: 1 }))

describe('text reconstruction parity with Python ScaleDP', () => {
    it('has goldens to check', () => {
        expect(cases.length).toBeGreaterThan(20)
    })

    describe('cluster', () => {
        for (const [i, c] of byFn('cluster').entries()) {
            it(`case ${i}: maxGap=${c.args.max_gap}`, () => {
                expect(cluster(c.args.items, c.args.max_gap)).toEqual(c.expected)
            })
        }
    })

    describe('get_size', () => {
        for (const [i, c] of byFn('get_size').entries()) {
            it(`case ${i}: n=${c.args.items.length}`, () => {
                expect(getSize(c.args.items)).toBe(c.expected)
            })
        }
    })

    describe('get_character_width', () => {
        for (const [i, c] of byFn('get_character_width').entries()) {
            it(`case ${i}`, () => {
                const lines = groupBoxesIntoLines(toBoxes(c.args.boxes))
                expect(getCharacterWidth(lines)).toBe(c.expected)
            })
        }
    })

    describe('box_to_formatted_text', () => {
        for (const [i, c] of byFn('box_to_formatted_text').entries()) {
            it(`case ${i}: lineTolerance=${c.args.line_tolerance}`, () => {
                expect(boxesToFormattedText(toBoxes(c.args.boxes), c.args.line_tolerance)).toBe(c.expected)
            })
        }
    })
})
