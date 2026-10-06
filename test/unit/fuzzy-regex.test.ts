/**
 * The approximate engine must first be a correct exact one, so its maxCost-0
 * results are diffed against the host RegExp; the edit behaviour is then
 * checked case by case.
 */
import { describe, expect, it } from 'vitest'
import { FuzzyRegex } from '../../src/core/fuzzy-regex.js'

const spans = (pattern: string, text: string, options = {}, flags = '') =>
    new FuzzyRegex(pattern, flags).matchAll(text, options).map((m) => text.slice(m.start, m.end))

describe('FuzzyRegex, exact', () => {
    // Patterns where leftmost-longest and a backtracker's leftmost-greedy agree.
    it.each([
        ['\\d{3}-\\d{2}-\\d{4}', 'SSN 123-45-6789 and 987-65-4321.'],
        ['[A-Z][a-z]+', 'Hello there World, again Mr Smith'],
        ['(?:\\+\\d{1,3} )?\\(?\\d{3}\\)? ?\\d{3}-\\d{4}', 'call (555) 123-4567 or +1 555 123-4567'],
        ['[^\\s@]+@[^\\s@]+\\.[a-z]{2,}', 'mail a.b@c.com, x@y.org'],
        ['\\p{Lu}\\p{Ll}+', 'Łódź and Kraków'],
        ['a.c', 'abc a\nc axc'],
        ['[\\d.]+', '1.2.3 and 45'],
        ['x*y', 'xxy y xy'],
        ['(?:ab)+', 'ababab ab a'],
        ['colou?r', 'color colour colr'],
        ['\\w{2,3}', 'abcdefg h ij'],
    ])('agrees with RegExp on /%s/', (pattern, text) => {
        const native = [...text.matchAll(new RegExp(pattern, 'gu'))].map((m) => m[0])
        expect(spans(pattern, text)).toEqual(native)
    })

    it('honours the i flag', () => {
        expect(spans('march', 'MARCH March march', {}, 'i')).toEqual(['MARCH', 'March', 'march'])
    })

    it('reports offsets into the original text', () => {
        const [m] = new FuzzyRegex('\\d+').matchAll('ab 123 cd')
        expect(m).toMatchObject({ start: 3, end: 6, cost: 0, edits: [] })
    })

    it('rejects syntax it does not implement rather than misreading it', () => {
        expect(() => new FuzzyRegex('(?<=a)b')).toThrow(/Lookarounds/)
        expect(() => new FuzzyRegex('^a')).toThrow(/Anchors/)
        expect(() => new FuzzyRegex('\\bword')).toThrow(/boundaries/)
        expect(() => new FuzzyRegex('(a)\\1')).toThrow(/Back-references/)
        expect(() => new FuzzyRegex('[abc')).toThrow(/Unclosed/)
        expect(() => new FuzzyRegex('a', 'm')).toThrow(/flag/)
    })
})

describe('FuzzyRegex, approximate', () => {
    const ssn = new FuzzyRegex('\\d{3}-\\d{2}-\\d{4}')

    it('finds nothing extra at maxCost 0', () => {
        expect(ssn.matchAll('123-45-678X')).toEqual([])
    })

    it('substitutes', () => {
        const [m] = ssn.matchAll('123-45-678X', { maxCost: 1 })
        expect(m).toMatchObject({ start: 0, end: 11, cost: 1, edits: [{ kind: 'substitute', index: 10 }] })
    })

    it('inserts', () => {
        const [m] = ssn.matchAll('123-45-67,89', { maxCost: 1 })
        expect(m).toMatchObject({ start: 0, end: 12, cost: 1, edits: [{ kind: 'insert', index: 9 }] })
    })

    it('deletes', () => {
        const [m] = ssn.matchAll('123-45-678 ', { maxCost: 1, costs: { substitute: 9, insert: 9 } })
        // Which of the equal digits went missing is ambiguous; that one did is not.
        expect(m).toMatchObject({ start: 0, end: 10, cost: 1 })
        expect(m?.edits.map((e) => e.kind)).toEqual(['delete'])
    })

    it('stays within budget', () => {
        expect(ssn.matchAll('12X-45-67Y9', { maxCost: 1 })).toEqual([])
        expect(ssn.matchAll('12X-45-67Y9', { maxCost: 2 })[0]?.cost).toBe(2)
    })

    it('prices edits per character', () => {
        // A stray comma is cheap; a stray digit is forbidden.
        const costs = { insert: (c: string) => (/\d/.test(c) ? Number.POSITIVE_INFINITY : 1) }
        expect(ssn.matchAll('123-45-67,89', { maxCost: 1, costs })).toHaveLength(1)
        const text = '123-45-67089'
        const canEnd = (i: number) => !/\d/.test(text[i] ?? '')
        expect(
            ssn.matchAll(text, { maxCost: 1, canEnd, costs: { ...costs, substitute: 9, delete: 9 } })
        ).toEqual([])
    })

    it('prefers an exact match to a fuzzy one over the same text', () => {
        const [m] = ssn.matchAll('x 123-45-6789 y', { maxCost: 2 })
        expect(m).toMatchObject({ start: 2, end: 13, cost: 0 })
    })

    it('never pads a match with junk at either end', () => {
        const [m] = ssn.matchAll('..123-45-6789..', { maxCost: 2 })
        expect(m).toMatchObject({ start: 2, end: 13, cost: 0 })
    })

    it('respects canStart and canEnd', () => {
        const text = '9123-45-67890'
        const isDigit = (i: number) => /\d/.test(text[i] ?? '')
        const bounded = { canStart: (i: number) => !isDigit(i - 1), canEnd: (i: number) => !isDigit(i) }
        expect(ssn.matchAll(text)).toHaveLength(1)
        expect(ssn.matchAll(text, bounded)).toEqual([])
    })

    it('reports every end it can reach through search', () => {
        const ends = new FuzzyRegex('\\d{2,4}').search('12345').map((m) => m.end)
        expect(ends).toEqual([2, 3, 4, 5])
    })
})
