/**
 * The consistency pass is pure text work -- no engine, no model -- so every
 * assertion here runs against hand-built documents and entities.
 */
import { describe, expect, it } from 'vitest'
import { findWholeWordOccurrences, foldForMatching } from '../../src/core/entities.js'
import { BASE_STAGE_DEFAULTS, resolveParams } from '../../src/core/params.js'
import { Pipeline, type Row, Stage } from '../../src/core/pipeline.js'
import { createBox } from '../../src/schemas/box.js'
import { createDocument, type Document } from '../../src/schemas/document.js'
import { createNerOutput, type Entity, type NerOutput } from '../../src/schemas/entity.js'
import { applyVocabulary, buildVocabulary, NerConsistency } from '../../src/stages/ner-consistency.js'

const entity = (word: string, group: string, start: number, end: number, score = 0.9): Entity => ({
    entity_group: group,
    score,
    word,
    start,
    end,
    boxes: [],
})

/** A document whose boxes are one per word, laid out left to right. */
function wordDocument(text: string): Document {
    let cursor = 0
    const bboxes = text.split(' ').map((word, index) => {
        cursor += index === 0 ? 0 : 1
        const box = createBox({ text: word, x: cursor * 10, y: 0, width: word.length * 10, height: 10 })
        cursor += word.length
        return box
    })
    return createDocument({ text, type: 'ocr', bboxes })
}

describe('foldForMatching', () => {
    it('lower-cases and collapses every run of whitespace', () => {
        expect(foldForMatching('JOHN   Smith').folded).toBe('john smith')
        expect(foldForMatching('John\nSmith').folded).toBe('john smith')
        expect(foldForMatching('  John Smith  ').folded).toBe('john smith')
    })

    it('maps every folded index back onto the source text', () => {
        const { folded, offsets } = foldForMatching('A  b\nC')
        expect(folded).toBe('a b c')
        expect(offsets).toHaveLength(folded.length)
        // The collapsed space reports the index of the character that ended the
        // run, so a span never reaches back past its own first character.
        expect(offsets.map((i) => 'A  b\nC'[i])).toEqual(['A', 'b', 'b', 'C', 'C'])
    })

    it('stays aligned when lowercasing lengthens a character', () => {
        // 'İ'.toLowerCase() is two characters; a blanket toLowerCase would shift
        // every offset after it.
        const source = 'İx'
        const { folded, offsets } = foldForMatching(source)
        expect(folded.length).toBeGreaterThan(2)
        expect(offsets).toHaveLength(folded.length)
        expect(offsets[offsets.length - 1]).toBe(source.indexOf('x'))
    })
})

describe('findWholeWordOccurrences', () => {
    it('finds every occurrence', () => {
        expect(findWholeWordOccurrences('ann and ann', 'ann')).toEqual([
            { start: 0, end: 3 },
            { start: 8, end: 11 },
        ])
    })

    it('rejects a match inside a longer word', () => {
        expect(findWholeWordOccurrences('announcement', 'ann')).toEqual([])
        expect(findWholeWordOccurrences('john smithson', 'john smith')).toEqual([])
    })

    it('matches across what was a line break', () => {
        const { folded } = foldForMatching('signed by JOHN\nSMITH today')
        expect(findWholeWordOccurrences(folded, 'john smith')).toHaveLength(1)
    })
})

describe('buildVocabulary', () => {
    it('drops seeds below minLength or minScore', () => {
        const seeds = [entity('Al', 'PERSON', 0, 2, 0.9), entity('Bobby', 'PERSON', 3, 8, 0.2)]
        const vocabulary = buildVocabulary(seeds, { minLength: 3, minScore: 0.5 })
        expect([...vocabulary.keys()]).toEqual([])
    })

    it('resolves a conflicting label to the best-scoring one', () => {
        const seeds = [entity('Acme Ltd', 'ORG', 0, 8, 0.88), entity('ACME LTD', 'PERSON', 20, 28, 0.52)]
        const vocabulary = buildVocabulary(seeds)
        expect(vocabulary.get('acme ltd')?.labels.map((l) => l.label)).toEqual(['ORG'])
    })

    it('keeps both labels when told not to resolve', () => {
        const seeds = [entity('Acme Ltd', 'ORG', 0, 8, 0.88), entity('ACME LTD', 'PERSON', 20, 28, 0.52)]
        const vocabulary = buildVocabulary(seeds, { resolveConflicts: false })
        expect(vocabulary.get('acme ltd')?.labels.map((l) => l.label)).toEqual(['ORG', 'PERSON'])
    })
})

describe('applyVocabulary', () => {
    it('tags a missed occurrence and marks where it came from', () => {
        const document = wordDocument('JOHN SMITH signed. John Smith paid.')
        const found = [entity('John Smith', 'PERSON', 19, 29)]
        const entities = applyVocabulary(document, buildVocabulary(found), found)

        expect(entities.map((e) => [e.word, e.source])).toEqual([
            ['JOHN SMITH', 'propagated'],
            ['John Smith', 'model'],
        ])
    })

    it('gives each occurrence the boxes it actually sits on', () => {
        const document = wordDocument('JOHN SMITH signed. John Smith paid.')
        const found = [entity('John Smith', 'PERSON', 19, 29)]
        const [first, second] = applyVocabulary(document, buildVocabulary(found), found)

        expect(first?.boxes.map((b) => b.text)).toEqual(['JOHN', 'SMITH'])
        expect(second?.boxes.map((b) => b.text)).toEqual(['John', 'Smith'])
        expect(first?.boxes[0]?.x).not.toBe(second?.boxes[0]?.x)
    })

    it('prefers the longer phrase where two overlap', () => {
        const document = wordDocument('John Smith paid')
        const found = [entity('John', 'PERSON', 0, 4, 0.7), entity('John Smith', 'PERSON', 0, 10, 0.6)]
        const entities = applyVocabulary(document, buildVocabulary(found), found)

        expect(entities).toHaveLength(1)
        expect(entities[0]?.word).toBe('John Smith')
    })

    it('keeps a model span that is not a whole word rather than filtering it out', () => {
        // The stage adds recall; it must never cost any.
        const document = wordDocument('Contact Smithson today')
        const found = [entity('Smith', 'PERSON', 8, 13)]
        const entities = applyVocabulary(document, buildVocabulary(found), found)

        expect(entities).toEqual([{ ...found[0], source: 'model' }])
    })

    it('does not let a losing label back in beside the winner', () => {
        const document = wordDocument('Acme Ltd invoiced Acme Ltd')
        const found = [entity('Acme Ltd', 'ORG', 0, 8, 0.88), entity('Acme Ltd', 'PERSON', 18, 26, 0.52)]
        const entities = applyVocabulary(document, buildVocabulary(found), found)

        expect(entities.map((e) => e.entity_group)).toEqual(['ORG', 'ORG'])
    })

    it('keeps the model score on the occurrence the model reported', () => {
        const document = wordDocument('Ada Lovelace and Ada Lovelace')
        const found = [entity('Ada Lovelace', 'PERSON', 0, 12, 0.42)]
        const [first, second] = applyVocabulary(document, buildVocabulary(found), found)

        expect(first?.score).toBeCloseTo(0.42, 9)
        expect(second?.score).toBeCloseTo(0.42, 9)
        expect(second?.source).toBe('propagated')
    })
})

/** Feeds pre-built rows in, so the stage can be exercised without a model. */
class Rows extends Stage {
    readonly name = 'Rows'
    constructor(private readonly rows: Row[]) {
        super(resolveParams(BASE_STAGE_DEFAULTS))
    }
    protected override async expand(): Promise<Row[]> {
        return this.rows.map((row) => ({ ...row }))
    }
    protected async apply(): Promise<never> {
        throw new Error('unreachable')
    }
    protected onError(message: string): unknown {
        return message
    }
}

/** The NER output of one row, cast past the optional index. */
const nerOf = (row: Row | undefined): NerOutput => (row as Row).ner as NerOutput

/** A row shaped like one a recognizer plus GlinerNer would leave behind. */
const page = (text: string, entities: Entity[]): Row => ({
    path: 'memory',
    text: wordDocument(text),
    ner: createNerOutput({ entities, json: JSON.stringify(entities) }),
})

describe('overrideModelLabels', () => {
    // 'Smith' read as a person in one place and a location in another. Conflict
    // resolution picks PERSON everywhere, which is the whole point of the pass
    // -- and the thing you sometimes need to opt out of.
    const document = () => wordDocument('Smith signed. Visited Smith yesterday.')
    const found = () => [entity('Smith', 'PERSON', 0, 5, 0.9), entity('Smith', 'LOCATION', 22, 27, 0.4)]

    it('writes the resolved label over the model own by default', () => {
        const entities = applyVocabulary(document(), buildVocabulary(found()), found())

        expect(entities.map((e) => [e.start, e.entity_group, e.source])).toEqual([
            [0, 'PERSON', 'model'],
            [22, 'PERSON', 'propagated'],
        ])
    })

    it('leaves the model own label alone when told not to override', () => {
        const entities = applyVocabulary(document(), buildVocabulary(found()), found(), {
            overrideModelLabels: false,
        })

        // The model tagged both spans itself, so both keep what it said.
        expect(entities.map((e) => [e.start, e.entity_group, e.source])).toEqual([
            [0, 'PERSON', 'model'],
            [22, 'LOCATION', 'model'],
        ])
        // And the model's own score survives with it.
        expect(entities[1]?.score).toBe(0.4)
    })

    it('still fills the occurrences the model missed', () => {
        // Three occurrences, two tagged. The untagged one is the recall this
        // stage exists for, and it must survive with overriding off.
        const doc = wordDocument('Smith signed. Visited Smith yesterday. Ask Smith again.')
        const entities = applyVocabulary(doc, buildVocabulary(found()), found(), {
            overrideModelLabels: false,
        })

        expect(entities.map((e) => [e.start, e.entity_group, e.source])).toEqual([
            [0, 'PERSON', 'model'],
            [22, 'LOCATION', 'model'],
            [43, 'PERSON', 'propagated'],
        ])
    })

    it('keeps the boxes of the position it was found at, not the seed own', () => {
        const doc = document()
        const entities = applyVocabulary(doc, buildVocabulary(found()), found(), {
            overrideModelLabels: false,
        })

        // The model entities carry no boxes; re-tagging attaches this position's.
        expect(entities[1]?.boxes.map((b) => b.text)).toEqual(['Smith'])
        expect(entities[1]?.word).toBe('Smith')
    })
})

describe('NerConsistency', () => {
    const rows = () => [
        page('Invoice for John Smith', [entity('John Smith', 'PERSON', 12, 22)]),
        page('Paid by John Smith today', []),
    ]

    it('propagates across rows in document scope', async () => {
        const out = await new Pipeline([new Rows(rows()), new NerConsistency()]).transform([{}])
        const second = nerOf(out[1])

        expect(second.entities).toHaveLength(1)
        expect(second.entities[0]).toMatchObject({
            entity_group: 'PERSON',
            word: 'John Smith',
            source: 'propagated',
        })
        expect(second.entities[0]?.boxes.map((b) => b.text)).toEqual(['John', 'Smith'])
    })

    it('carries overrideModelLabels through to the rewrite', async () => {
        // Two pages, the same string read two ways. Document scope pools them,
        // so page two is exactly where the override would land.
        const conflicting = () => [
            page('Contact Smith today', [entity('Smith', 'PERSON', 8, 13, 0.9)]),
            page('Visited Smith once', [entity('Smith', 'LOCATION', 8, 13, 0.4)]),
        ]

        const overridden = await new Pipeline([new Rows(conflicting()), new NerConsistency()]).transform([{}])
        expect(nerOf(overridden[1]).entities[0]).toMatchObject({
            entity_group: 'PERSON',
            source: 'propagated',
        })

        const kept = await new Pipeline([
            new Rows(conflicting()),
            new NerConsistency({ overrideModelLabels: false }),
        ]).transform([{}])
        expect(nerOf(kept[1]).entities[0]).toMatchObject({
            entity_group: 'LOCATION',
            source: 'model',
        })
    })

    it('leaves other rows alone in row scope', async () => {
        const stage = new NerConsistency({ scope: 'row' })
        const out = await new Pipeline([new Rows(rows()), stage]).transform([{}])

        expect(nerOf(out[0]).entities).toHaveLength(1)
        expect(nerOf(out[1]).entities).toEqual([])
    })

    it('rewrites the json field alongside the entities', async () => {
        const out = await new Pipeline([new Rows(rows()), new NerConsistency()]).transform([{}])
        const second = nerOf(out[1])
        expect(JSON.parse(second.json)).toEqual(second.entities)
    })

    it('records an upstream failure without losing the other rows', async () => {
        const broken = rows()
        broken[0] = { ...broken[0], ner: createNerOutput({ exception: 'GlinerNer: model missing' }) }
        const out = await new Pipeline([new Rows(broken), new NerConsistency()]).transform([{}])

        expect(nerOf(out[0]).exception).toMatch(/NerConsistency.*model missing/)
        expect(nerOf(out[1]).exception).toBe('')
    })

    it('reads the document from the column recognizers actually write', async () => {
        // Every recognizer writes its Document to `text`; only PdfToDocument
        // uses `document`. Getting this wrong fails every row at run time.
        const out = await new Pipeline([new Rows(rows()), new NerConsistency()]).transform([{}])
        expect(nerOf(out[0]).exception).toBe('')
    })

    it('names the column it could not find', async () => {
        const stage = new NerConsistency({ inputCols: ['ner', 'document'] })
        const out = await new Pipeline([new Rows(rows()), stage]).transform([{}])
        expect(nerOf(out[0]).exception).toMatch(/Expected a Document in "document"/)
    })

    it('rejects params it cannot honour', () => {
        expect(() => new NerConsistency({ scope: 'page' as never })).toThrow(/scope must be one of/)
        expect(() => new NerConsistency({ minLength: 0 })).toThrow(/minLength/)
        expect(() => new NerConsistency({ minScore: 2 })).toThrow(/minScore/)
        expect(() => new NerConsistency({ inputCols: ['ner'] })).toThrow(/inputCols/)
    })
})
