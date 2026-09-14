import { describe, expect, it } from 'vitest'
import { assembleDocument, coveringBoxes, dropCovered, mergeBoxSets } from '../../src/pdf/merge-text.js'
import { boxCoverage, createBox } from '../../src/schemas/box.js'

const box = (text: string, x: number, y: number, width = 40, height = 10) =>
    createBox({ text, x, y, width, height, score: 1 })

describe('boxCoverage', () => {
    it('is asymmetric, which is why it is not boxIou', () => {
        const word = box('Total', 100, 100, 40, 10)
        const line = box('Total due on receipt', 100, 100, 200, 12)

        // The word is wholly inside the line; the line is mostly outside the word.
        expect(boxCoverage(word, line)).toBeCloseTo(1, 6)
        expect(boxCoverage(line, word)).toBeCloseTo(40 / 200 / 1.2, 6)
    })

    it('is zero for boxes that do not touch', () => {
        expect(boxCoverage(box('a', 0, 0), box('b', 500, 500))).toBe(0)
    })
})

describe('dropCovered', () => {
    it('evicts a box the winning source already covers', () => {
        const ocr = [box('Total', 100, 100), box('Elsewhere', 100, 900)]
        const textLayer = [box('Total', 100, 100)]

        expect(dropCovered(ocr, textLayer, 0.5).map((b) => b.text)).toEqual(['Elsewhere'])
    })

    it('keeps everything when the winning source is empty', () => {
        const ocr = [box('Total', 100, 100)]
        expect(dropCovered(ocr, [], 0.5)).toHaveLength(1)
    })

    it('takes the best single overlap, not the sum of several', () => {
        // Two winners each covering a third would sum past the threshold and
        // evict a box that neither actually covers.
        const target = box('wide', 0, 0, 90, 10)
        const winners = [box('l', 0, 0, 30, 10), box('r', 60, 0, 30, 10)]

        expect(dropCovered([target], winners, 0.5)).toHaveLength(1)
    })
})

describe('mergeBoxSets', () => {
    const textLayer = [box('INVOICE', 100, 50)]
    const ocr = [box('INVOICE', 100, 50), box('1,240.00', 400, 500)]
    const options = { coverageThreshold: 0.5 }

    it('keeps the text layer and drops its OCR duplicate by default', () => {
        const merged = mergeBoxSets(textLayer, ocr, { ...options, strategy: 'text-layer-wins' })
        expect(merged.map((b) => b.text)).toEqual(['INVOICE', '1,240.00'])
    })

    it('keeps the OCR reading instead when the text layer is not trusted', () => {
        const merged = mergeBoxSets(textLayer, ocr, { ...options, strategy: 'ocr-wins' })
        expect(merged.map((b) => b.text)).toEqual(['INVOICE', '1,240.00'])
        // Same words, but now they are the OCR boxes, not the text layer's.
        expect(merged[0]).toBe(ocr[0])
    })

    it('keeps both readings under union, for comparing them', () => {
        const merged = mergeBoxSets(textLayer, ocr, { ...options, strategy: 'union' })
        expect(merged).toHaveLength(3)
    })
})

describe('coveringBoxes', () => {
    const region = box('', 300, 300, 1000, 1000)

    it('counts a searchable scan’s invisible text layer', () => {
        const inside = Array.from({ length: 5 }, (_, i) => box('w', 400, 400 + i * 20))
        expect(coveringBoxes(inside, region)).toBe(5)
    })

    it('does not count a header sitting just above the image', () => {
        expect(coveringBoxes([box('INVOICE', 400, 200)], region)).toBe(0)
    })
})

describe('assembleDocument', () => {
    const options = {
        path: 'memory',
        strategy: 'text-layer-wins' as const,
        coverageThreshold: 0.5,
        keepFormatting: false,
        lineTolerance: 0,
    }

    it('interleaves the two sources in reading order, not by source', () => {
        // The header is vector text; the table body was read out of an image
        // that sits above it in the source order. Concatenating by source would
        // put the header last.
        const textLayer = [box('INVOICE', 100, 50)]
        const ocr = [box('Total', 100, 400), box('1,240.00', 400, 400)]

        const document = assembleDocument(textLayer, ocr, options)
        expect(document.text).toBe('INVOICE Total 1,240.00')
    })

    it('returns bboxes in the same order the text was built from', () => {
        const textLayer = [box('second', 100, 400)]
        const ocr = [box('first', 100, 50)]

        const document = assembleDocument(textLayer, ocr, options)
        expect(document.bboxes.map((b) => b.text)).toEqual(['first', 'second'])
        expect(document.text).toBe('first second')
    })

    it('records where the text came from', () => {
        expect(assembleDocument([box('a', 0, 0)], [], options).type).toBe('pdf')
        expect(assembleDocument([], [box('a', 0, 0)], options).type).toBe('pdf+ocr')
    })

    it('preserves layout when asked', () => {
        const document = assembleDocument([box('a', 0, 0), box('b', 0, 300)], [], {
            ...options,
            keepFormatting: true,
        })
        expect(document.text.split('\n').length).toBeGreaterThan(1)
    })
})
