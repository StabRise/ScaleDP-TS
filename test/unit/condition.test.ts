import { describe, expect, it } from 'vitest'
import { evaluate, readPath, validateCondition } from '../../src/core/condition.js'
import { usableTextLayer } from '../../src/pdf/pdf-to-document.js'

const row = {
    document: { exception: '', bboxes: [{ text: 'a' }, { text: 'b' }], text: 'a b' },
    page: 3,
    flag: false,
    tags: ['x', 'y'],
}

describe('readPath', () => {
    it('follows objects, array indexes and length', () => {
        expect(readPath(row, 'document.bboxes.length')).toBe(2)
        expect(readPath(row, 'document.bboxes.1.text')).toBe('b')
        expect(readPath(row, 'document.text.length')).toBe(3)
    })

    it('distinguishes a missing path from a stored value', () => {
        expect(readPath(row, 'document.nope')).not.toBeUndefined()
        expect(readPath(row, 'flag')).toBe(false)
    })
})

describe('evaluate', () => {
    it('runs every listed test', () => {
        expect(evaluate({ path: 'page', gte: 3, lt: 4 }, row)).toBe(true)
        expect(evaluate({ path: 'page', gte: 3, lt: 3 }, row)).toBe(false)
        expect(evaluate({ path: 'page', in: [1, 3] }, row)).toBe(true)
        expect(evaluate({ path: 'flag', eq: false }, row)).toBe(true)
        expect(evaluate({ path: 'flag', truthy: true }, row)).toBe(false)
        expect(evaluate({ path: 'tags.length', eq: 2 }, row)).toBe(true)
    })

    it('fails every test on a missing value except exists: false', () => {
        expect(evaluate({ path: 'missing', ne: 1 }, row)).toBe(false)
        expect(evaluate({ path: 'missing', truthy: false }, row)).toBe(false)
        expect(evaluate({ path: 'missing', exists: false }, row)).toBe(true)
        expect(evaluate({ path: 'page', exists: false }, row)).toBe(false)
        expect(evaluate({ path: 'page', exists: true }, row)).toBe(true)
    })

    it('combines with all, any and not', () => {
        expect(
            evaluate(
                {
                    all: [
                        { path: 'page', eq: 3 },
                        { path: 'flag', eq: false },
                    ],
                },
                row
            )
        ).toBe(true)
        expect(
            evaluate(
                {
                    any: [
                        { path: 'page', eq: 9 },
                        { path: 'flag', eq: false },
                    ],
                },
                row
            )
        ).toBe(true)
        expect(evaluate({ not: { path: 'page', eq: 3 } }, row)).toBe(false)
    })

    it('reads run variables', () => {
        expect(evaluate({ var: 'forceOcr', truthy: true }, row, { forceOcr: true })).toBe(true)
        expect(evaluate({ var: 'forceOcr', truthy: true }, row, {})).toBe(false)
    })

    it('mirrors hasUsableTextLayer through usableTextLayer()', () => {
        expect(evaluate(usableTextLayer(), row)).toBe(true)
        expect(evaluate(usableTextLayer('document', 3), row)).toBe(false)
        expect(evaluate(usableTextLayer(), { document: { exception: 'x', bboxes: [{}] } })).toBe(false)
        expect(evaluate(usableTextLayer(), {})).toBe(false)
    })
})

describe('validateCondition', () => {
    it('accepts well-formed conditions', () => {
        expect(() => validateCondition({ not: usableTextLayer() })).not.toThrow()
        expect(() => validateCondition({ var: 'x', truthy: true })).not.toThrow()
    })

    it('rejects malformed ones with the place they occur', () => {
        expect(() => validateCondition({ path: 'a' })).toThrow(/at least one/)
        expect(() => validateCondition({ path: 'a', var: 'b', eq: 1 })).toThrow(/exactly one/)
        expect(() => validateCondition({ path: 'a', eqq: 1 })).toThrow(/unexpected key "eqq"/)
        expect(() => validateCondition({ all: [] })).toThrow(/non-empty/)
        expect(() => validateCondition({ any: [{ path: 'a', gt: '1' }] }, 'ocr.when')).toThrow(
            /ocr\.when\.any\[0\]\.gt must be a number/
        )
        expect(() => validateCondition('x')).toThrow(/must be an object/)
    })
})
