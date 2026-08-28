import { describe, expect, it } from 'vitest'
import {
    chunkText,
    dedupeSpans,
    isMostlyUppercase,
    normaliseCasing,
    rebaseSpan,
    titleCaseAllCapsWords,
} from '../../src/ner/chunking.js'
import { boxesForRange, buildCharToBoxMap } from '../../src/ner/gliner-ner.js'
import { DEFAULT_NER_MODEL_ID, getNerModel, NER_MODELS } from '../../src/ner/registry.js'
import { generateSpans } from '../../src/ner/vendor/gliner2-decoder.js'
import { sigmoid } from '../../src/ner/vendor/math.js'
import { decodeSpans } from '../../src/ner/vendor/span-decoder.js'
import { RICH_WORD_PATTERN, splitWords } from '../../src/ner/vendor/splitter.js'
import { type Box, createBox } from '../../src/schemas/box.js'

describe('chunkText', () => {
    it('returns a single chunk when the text fits', () => {
        expect(chunkText('short', 500, 480)).toEqual([{ text: 'short', offset: 0 }])
    })

    it('returns nothing for empty text', () => {
        expect(chunkText('', 500, 480)).toEqual([])
    })

    it('overlaps chunks so an entity on a seam survives', () => {
        const text = 'x'.repeat(1200)
        const chunks = chunkText(text, 500, 480)
        expect(chunks[0]).toMatchObject({ offset: 0 })
        expect(chunks[1]?.offset).toBe(480)
        // Each chunk starts 480 in but spans 500, so 20 chars are shared.
        expect((chunks[0]?.text.length ?? 0) - 480).toBe(20)
    })

    it('stops at the end rather than emitting shrinking tails', () => {
        const chunks = chunkText('x'.repeat(600), 500, 480)
        expect(chunks).toHaveLength(2)
        expect(chunks[1]?.text.length).toBe(120)
    })

    it('rejects a non-positive stride, which would loop forever', () => {
        expect(() => chunkText('abc', 500, 0)).toThrow(/stride must be positive/)
    })
})

describe('dedupeSpans', () => {
    const span = (start: number, end: number, label: string, score: number) => ({
        text: 'x',
        label,
        start,
        end,
        score,
    })

    it('keeps the highest score for a repeated span', () => {
        const out = dedupeSpans([span(0, 5, 'person', 0.7), span(0, 5, 'person', 0.9)])
        expect(out).toHaveLength(1)
        expect(out[0]?.score).toBeCloseTo(0.9, 9)
    })

    it('keeps distinct labels on the same range', () => {
        expect(dedupeSpans([span(0, 5, 'person', 0.7), span(0, 5, 'org', 0.7)])).toHaveLength(2)
    })

    it('sorts by start offset', () => {
        const out = dedupeSpans([span(10, 15, 'a', 0.9), span(0, 5, 'b', 0.8)])
        expect(out.map((s) => s.start)).toEqual([0, 10])
    })
})

describe('rebaseSpan', () => {
    it('shifts offsets onto the original text', () => {
        expect(rebaseSpan({ text: 'x', label: 'l', start: 3, end: 7, score: 1 }, 480)).toMatchObject({
            start: 483,
            end: 487,
        })
    })
})

describe('casing normalisation', () => {
    it('detects predominantly uppercase text', () => {
        expect(isMostlyUppercase('HOPE HAVEN HOSPITAL')).toBe(true)
        expect(isMostlyUppercase('Hope Haven Hospital')).toBe(false)
    })

    it('title-cases runs of capitals while preserving length', () => {
        const input = 'HOPE HAVEN HOSPITAL'
        const output = titleCaseAllCapsWords(input)
        expect(output).toBe('Hope Haven Hospital')
        // Length preservation is what keeps character offsets valid.
        expect(output.length).toBe(input.length)
    })

    it('leaves single capitals and mixed text alone', () => {
        expect(titleCaseAllCapsWords('A Bold Claim')).toBe('A Bold Claim')
    })

    it('only normalises when the text is mostly uppercase', () => {
        expect(normaliseCasing('Hope Haven HOSPITAL')).toBe('Hope Haven HOSPITAL')
        expect(normaliseCasing('HOPE HAVEN HOSPITAL')).toBe('Hope Haven Hospital')
    })
})

describe('buildCharToBoxMap', () => {
    const boxes: Box[] = [
        createBox({ text: 'Hello', x: 0, y: 0, width: 50, height: 12 }),
        createBox({ text: 'world', x: 60, y: 0, width: 50, height: 12 }),
    ]

    it('maps every character back to its box', () => {
        const text = 'Hello world'
        const mapping = buildCharToBoxMap(text, boxes)
        expect(Array.from(mapping.slice(0, 5))).toEqual([0, 0, 0, 0, 0])
        expect(mapping[5]).toBe(-1) // the separator belongs to no box
        expect(Array.from(mapping.slice(6, 11))).toEqual([1, 1, 1, 1, 1])
    })

    it('survives multi-character separators, where a length-derived map drifts', () => {
        // keepFormatting inserts runs of spaces; a mapping built from
        // len(text)+1 (as Python does) would shift every later box by one.
        const text = 'Hello      world'
        const mapping = buildCharToBoxMap(text, boxes)
        expect(boxesForRange(mapping, boxes, 11, 16).map((b) => b.text)).toEqual(['world'])
    })

    it('handles repeated box text without aliasing to the first occurrence', () => {
        const repeated: Box[] = [
            createBox({ text: 'the', x: 0, y: 0, width: 30, height: 12 }),
            createBox({ text: 'cat', x: 40, y: 0, width: 30, height: 12 }),
            createBox({ text: 'the', x: 80, y: 0, width: 30, height: 12 }),
        ]
        const mapping = buildCharToBoxMap('the cat the', repeated)
        expect(boxesForRange(mapping, repeated, 8, 11).map((b) => b.x)).toEqual([80])
    })
})

describe('boxesForRange', () => {
    const boxes: Box[] = [
        createBox({ text: 'Hope', x: 0, y: 0, width: 40, height: 12 }),
        createBox({ text: 'Haven', x: 50, y: 0, width: 50, height: 12 }),
        createBox({ text: 'Hospital', x: 110, y: 0, width: 80, height: 12 }),
    ]
    const text = 'Hope Haven Hospital'
    const mapping = buildCharToBoxMap(text, boxes)

    it('returns every box an entity spans, in order and without repeats', () => {
        expect(boxesForRange(mapping, boxes, 0, 10).map((b) => b.text)).toEqual(['Hope', 'Haven'])
    })

    it('returns nothing for a range covering only separators', () => {
        expect(boxesForRange(mapping, boxes, 4, 5)).toEqual([])
    })

    it('clamps out-of-bounds ranges', () => {
        expect(boxesForRange(mapping, boxes, -10, 1000)).toHaveLength(3)
    })
})

describe('splitWords', () => {
    it('keeps accented words whole (JS \\w is ASCII-only, which would shatter them)', () => {
        expect(splitWords('Müller García').map(([w]) => w)).toEqual(['Müller', 'García'])
    })

    it('keeps hyphenated and underscored words together', () => {
        expect(splitWords('well-known snake_case').map(([w]) => w)).toEqual(['well-known', 'snake_case'])
    })

    it('reports character offsets that index back into the source', () => {
        const text = 'Hello world'
        for (const [word, start, end] of splitWords(text)) {
            expect(text.slice(start, end)).toBe(word)
        }
    })

    it('keeps emails and URLs whole under the rich pattern', () => {
        expect(splitWords('mail a@b.com or https://x.io/p', RICH_WORD_PATTERN).map(([w]) => w)).toEqual([
            'mail',
            'a@b.com',
            'or',
            'https://x.io/p',
        ])
    })

    it('does not skip matches when called repeatedly (regex lastIndex is stateful)', () => {
        expect(splitWords('a b c')).toHaveLength(3)
        expect(splitWords('a b c')).toHaveLength(3)
    })
})

describe('decodeSpans', () => {
    // Two words, maxWidth 2, one label. Logit layout is
    // [start][width][label], so index 0 = word 0 alone.
    const batchWords: [string, number, number][][] = [
        [
            ['Raja', 0, 4],
            ['Raman', 5, 10],
        ],
    ]

    function logitsWith(overrides: Record<number, number>): Float32Array {
        const data = new Float32Array(2 * 2 * 1).fill(-10)
        for (const [i, v] of Object.entries(overrides)) data[Number(i)] = v
        return data
    }

    const params = {
        batchSize: 1,
        inputLength: 2,
        maxWidth: 2,
        entityCount: 1,
        texts: ['Raja Raman'],
        batchWords,
        idToClass: { 1: 'person' },
    }

    it('decodes a single-word span', () => {
        const [spans = []] = decodeSpans(logitsWith({ 0: 5 }), params, { threshold: 0.5 })
        expect(spans).toHaveLength(1)
        expect(spans[0]).toMatchObject({ text: 'Raja', label: 'person', start: 0, end: 4 })
        expect(spans[0]?.score).toBeCloseTo(sigmoid(5), 6)
    })

    it('decodes a two-word span from the width axis', () => {
        const [spans = []] = decodeSpans(logitsWith({ 1: 5 }), params, { threshold: 0.5 })
        expect(spans[0]).toMatchObject({ text: 'Raja Raman', start: 0, end: 10 })
    })

    it('drops everything below threshold', () => {
        const [spans = []] = decodeSpans(logitsWith({ 0: -5 }), params, { threshold: 0.5 })
        expect(spans).toHaveLength(0)
    })

    it('suppresses the lower-scoring of two overlapping spans', () => {
        // Word 0 alone (score 5) vs words 0-1 (score 6): the wider wins.
        const [spans = []] = decodeSpans(logitsWith({ 0: 5, 1: 6 }), params, { threshold: 0.5 })
        expect(spans).toHaveLength(1)
        expect(spans[0]?.text).toBe('Raja Raman')
    })

    it('ignores spans running past the end of the text', () => {
        // Word 1 with width 2 would end at word 2, which does not exist.
        const [spans = []] = decodeSpans(logitsWith({ 3: 5 }), params, { threshold: 0.5 })
        expect(spans).toHaveLength(0)
    })
})

describe('generateSpans', () => {
    it('emits seqLen * maxWidth slots, padding out-of-range ones with (0,0)', () => {
        const { spanStart, spanEnd, spanCount } = generateSpans(3, 2)
        // The fixed shape is required by the ONNX graph; the decoder re-checks bounds.
        expect(spanCount).toBe(6)
        expect(spanStart).toEqual([0, 0, 1, 1, 2, 0])
        expect(spanEnd).toEqual([0, 1, 1, 2, 2, 0])
    })
})

describe('NER model registry', () => {
    it('defaults to a public model so npm i works with no configuration', () => {
        const model = getNerModel(DEFAULT_NER_MODEL_ID)
        expect(model).toBeDefined()
        expect(model?.private).toBeFalsy()
    })

    it('marks StabRise repos as private', () => {
        expect(getNerModel('stabrise-pii-multi')?.private).toBe(true)
    })

    it('pins GLiNER2 to wasm, since WebGPU silently drops entities there', () => {
        expect(getNerModel('stabrise-pii-multi-g2')?.executionProviders).toEqual(['wasm'])
    })

    it('has unique ids', () => {
        expect(new Set(NER_MODELS.map((m) => m.id)).size).toBe(NER_MODELS.length)
    })
})
