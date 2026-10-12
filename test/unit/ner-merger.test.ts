/**
 * DocumentDelta and NerMerger, alone and composed the way a two-pass PDF reader
 * uses them: NER on the text layer, NER again on only what the embedded-image
 * pass added, both readings merged onto the merged page's offsets.
 */
import { describe, expect, it } from 'vitest'
import { boxesForRange, buildCharToBoxMap } from '../../src/core/entities.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../../src/core/params.js'
import { Pipeline, type Row, Stage } from '../../src/core/pipeline.js'
import type { PipelineEvent } from '../../src/core/run.js'
import { type Box, createBox } from '../../src/schemas/box.js'
import { createDocument, type Document } from '../../src/schemas/document.js'
import { createNerOutput, type Entity, type EntitySource, type NerOutput } from '../../src/schemas/entity.js'
import { DocumentDelta, documentDelta } from '../../src/stages/document-delta.js'
import { NerMerger } from '../../src/stages/ner-merger.js'

/** One box per word, each line on its own row, laid out left to right. */
function page(lines: string[][]): { boxes: Box[]; byWord: Map<string, Box> } {
    const boxes: Box[] = []
    const byWord = new Map<string, Box>()
    lines.forEach((words, row) => {
        let x = 0
        for (const word of words) {
            const box = createBox({
                text: word,
                x,
                y: row * 40,
                width: word.length * 10,
                height: 20,
                score: 1,
            })
            boxes.push(box)
            byWord.set(word, box)
            x += word.length * 10 + 10
        }
    })
    return { boxes, byWord }
}

const docOf = (boxes: Box[]): Document =>
    createDocument({ path: 'p.pdf', type: 'pdf', bboxes: boxes, text: boxes.map((b) => b.text).join(' ') })

/** A stand-in NER: tags the given words wherever they occur, with real offsets and boxes. */
class WordNer extends Stage<BaseStageParams> {
    readonly name = 'WordNer'
    constructor(
        private readonly words: Record<string, string>,
        options: Partial<BaseStageParams>
    ) {
        super(resolveParams<BaseStageParams>(BASE_STAGE_DEFAULTS, { keepInputData: true, ...options }))
    }
    protected async apply(input: unknown): Promise<NerOutput> {
        const document = input as Document
        const mapping = buildCharToBoxMap(document.text, document.bboxes)
        const entities: Entity[] = []
        for (const [word, label] of Object.entries(this.words)) {
            let at = document.text.indexOf(word)
            while (at >= 0) {
                entities.push({
                    entity_group: label,
                    score: 0.9,
                    word,
                    start: at,
                    end: at + word.length,
                    boxes: boxesForRange(mapping, document.bboxes, at, at + word.length),
                })
                at = document.text.indexOf(word, at + 1)
            }
        }
        return createNerOutput({ path: document.path, entities })
    }
    protected onError(message: string): NerOutput {
        return createNerOutput({ exception: message })
    }
}

describe('documentDelta', () => {
    it('is the boxes the later reading added, and nothing when it added nothing', () => {
        const { boxes } = page([
            ['Name:', 'Freya'],
            ['ID', '4471'],
        ])
        const base = docOf([boxes[0], boxes[1]] as Box[])
        const merged = docOf(boxes)
        expect(documentDelta(base, merged).bboxes.map((b) => b.text)).toEqual(['ID', '4471'])
        expect(documentDelta(merged, merged).bboxes).toEqual([])
    })

    it('treats every box as new when the first reading failed', () => {
        const { boxes } = page([['a', 'b']])
        const failed = createDocument({ exception: 'no text layer' })
        expect(documentDelta(failed, docOf(boxes)).bboxes).toHaveLength(2)
    })

    it('records a failed merged reading instead of throwing', async () => {
        const rows = await new Pipeline([new DocumentDelta()]).run([
            { document: docOf([]), merged: createDocument({ exception: 'merge exploded' }) },
        ])
        expect(((rows[0] as Row).delta as Document).exception).toContain('merge exploded')
    })
})

describe('NerMerger', () => {
    it('merges a text-layer pass and a delta pass onto the merged page', async () => {
        // The text layer reads the header and the footer; the scan in between
        // is only in the merged page, which puts it in reading order.
        const { boxes } = page([
            ['Contract', 'for', 'Freya'],
            ['Signed', 'Freya', 'Yamamoto', 'freya@ex.com'],
            ['Footer', 'Freya'],
        ])
        const layer = boxes.filter((b) => b.y !== 40)
        const merged = docOf(boxes)

        const tags = { Freya: 'person', Yamamoto: 'person', 'freya@ex.com': 'email' }
        const rows = await new Pipeline([
            new WordNer(tags, { inputCol: 'document', outputCol: 'ner' }),
            new DocumentDelta({ inputCols: ['document', 'merged'], outputCol: 'delta' }),
            {
                stage: new WordNer(tags, { inputCol: 'delta', outputCol: 'delta_ner' }),
                when: { path: 'delta.bboxes.length', gt: 0 },
            },
            new NerMerger({ inputCols: ['ner', 'delta_ner'], documentCol: 'merged' }),
        ]).run([{ document: docOf(layer), merged, path: 'p.pdf' }])

        const ner = rows[0]?.ner as NerOutput
        expect(ner.exception).toBe('')
        // Every entity now points into the merged page's text.
        for (const entity of ner.entities)
            expect(merged.text.slice(entity.start, entity.end)).toBe(entity.word)
        expect(ner.entities.map((e) => e.word)).toEqual([
            'Freya',
            'Freya',
            'Yamamoto',
            'freya@ex.com',
            'Freya',
        ])
        // In reading order, the scan's entities between the header's and the footer's.
        const starts = ner.entities.map((e) => e.start)
        expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    })

    it('skips the delta pass on a page the later reading added nothing to', async () => {
        const { boxes } = page([['Freya', 'Yamamoto']])
        const events: PipelineEvent[] = []
        const rows = await new Pipeline([
            new WordNer({ Freya: 'person' }, { inputCol: 'document', outputCol: 'ner' }),
            new DocumentDelta(),
            {
                stage: new WordNer({ Freya: 'person' }, { inputCol: 'delta', outputCol: 'delta_ner' }),
                id: 'delta-ner',
                when: { path: 'delta.bboxes.length', gt: 0 },
            },
            new NerMerger(),
        ]).run([{ document: docOf(boxes), merged: docOf(boxes) }], { onEvent: (e) => events.push(e) })

        expect(events.some((e) => e.type === 'stage:skip' && e.stageId === 'delta-ner')).toBe(true)
        expect(((rows[0] as Row).ner as NerOutput).entities.map((e) => e.word)).toEqual(['Freya'])
    })

    it('keeps an entity two recognisers both found once, at its best score', async () => {
        const { boxes } = page([['mail', 'freya@ex.com']])
        const document = docOf(boxes)
        const email = (score: number, source: EntitySource): Entity => ({
            entity_group: 'email',
            score,
            word: 'freya@ex.com',
            start: 5,
            end: 17,
            boxes: [boxes[1] as Box],
            source,
        })
        const rows = await new Pipeline([
            new NerMerger({ inputCols: ['model', 'pattern'], documentCol: 'document' }),
        ]).run([
            {
                document,
                model: createNerOutput({ entities: [email(0.7, 'model')] }),
                pattern: createNerOutput({ entities: [email(0.95, 'pattern')] }),
            },
        ])
        const entities = ((rows[0] as Row).ner as NerOutput).entities
        expect(entities).toHaveLength(1)
        expect(entities[0]).toMatchObject({ score: 0.95, source: 'pattern' })

        const all = await new Pipeline([
            new NerMerger({ inputCols: ['model', 'pattern'], documentCol: 'document', dedupe: 'none' }),
        ]).run([
            {
                document,
                model: createNerOutput({ entities: [email(0.7, 'model')] }),
                pattern: createNerOutput({ entities: [email(0.95, 'pattern')] }),
            },
        ])
        expect(((all[0] as Row).ner as NerOutput).entities).toHaveLength(2)
    })

    it('keeps the readings it has when one of them failed', async () => {
        const { boxes } = page([['Freya']])
        const ok = createNerOutput({
            entities: [
                {
                    entity_group: 'person',
                    score: 0.9,
                    word: 'Freya',
                    start: 0,
                    end: 5,
                    boxes: [boxes[0] as Box],
                },
            ],
        })
        const rows = await new Pipeline([new NerMerger({ documentCol: 'merged' })]).run([
            { merged: docOf(boxes), ner: ok, delta_ner: createNerOutput({ exception: 'service down' }) },
        ])
        const ner = rows[0]?.ner as NerOutput
        expect(ner.exception).toBe('')
        expect(ner.entities).toHaveLength(1)
    })

    it('fails, without throwing, when every reading failed', async () => {
        const rows = await new Pipeline([new NerMerger({ documentCol: '' })]).run([
            { ner: createNerOutput({ exception: 'service down' }) } as Row,
        ])
        expect(((rows[0] as Row).ner as NerOutput).exception).toContain('service down')
    })

    it('rejects an empty column list', () => {
        expect(() => new NerMerger({ inputCols: [] })).toThrow(/at least one/)
    })
})
