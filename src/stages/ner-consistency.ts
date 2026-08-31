/**
 * Make NER output consistent: every occurrence of an entity found *anywhere*
 * gets tagged, not just the occurrences the model happened to score.
 *
 * A model scores each mention independently, so the same name is tagged in the
 * body and missed in a heading set in caps, or missed in a dense table, or
 * missed because OCR broke it across a line. For redaction that is a
 * correctness problem: one missed occurrence leaks what the other one hid.
 *
 * This stage has no equivalent in Python ScaleDP. The nearest prior art is
 * `LLMNer.transform_udf`, which re-matches an entity string case-insensitively
 * against every box because the LLM returns no offsets.
 */

import {
    boxesForRange,
    buildCharToBoxMap,
    findWholeWordOccurrences,
    foldForMatching,
} from '../core/entities.js'
import { NerError } from '../core/errors.js'
import {
    assertInRange,
    assertPositiveInt,
    BASE_STAGE_DEFAULTS,
    type BaseStageParams,
    resolveParams,
} from '../core/params.js'
import { type Row, Stage, type StageContext } from '../core/pipeline.js'
import type { Document } from '../schemas/document.js'
import { createNerOutput, type Entity, type NerOutput } from '../schemas/entity.js'

/** How wide a net the collection pass casts. */
export type ConsistencyScope = 'document' | 'row'

export const CONSISTENCY_SCOPES: readonly ConsistencyScope[] = Object.freeze(['document', 'row'])

export interface NerConsistencyParams extends BaseStageParams {
    /**
     * [nerColumn, documentColumn].
     *
     * The document column is `text` because that is where every recognizer puts
     * its `Document` and what `GlinerNer` reads; `PdfToDocument` is the one
     * stage that writes `document` instead.
     */
    inputCols: string[]
    /** 'document' pools entities across every row; 'row' keeps pages independent. */
    scope: ConsistencyScope
    /** Shortest entity string allowed to propagate. Guards against noise. */
    minLength: number
    /** Only entities at or above this score seed the vocabulary. */
    minScore: number
    /** Resolve a string tagged two ways to its best-scoring label everywhere. */
    resolveConflicts: boolean
    /**
     * Let a propagated label replace the model's own, where the model tagged
     * that exact span itself.
     *
     * On by default, which is what makes the pass *consistent*: one string
     * resolves to one label everywhere, including the occurrence the model read
     * differently. That is usually what you want -- the outlier is normally the
     * mistake.
     *
     * Turn it off to treat the model's judgement as final wherever it made one.
     * Propagation then only fills spans the model left untagged, so the stage
     * adds occurrences without ever changing one. Worth it when the model is
     * trusted and the same string genuinely means different things in different
     * places -- a surname that is also a city, say.
     */
    overrideModelLabels: boolean
}

export const NER_CONSISTENCY_DEFAULTS: NerConsistencyParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'ner',
    inputCols: ['ner', 'text'],
    // Rewriting the column in place means an existing pipeline gains
    // consistency by inserting one stage, with nothing downstream rewired.
    outputCol: 'ner',
    keepInputData: true,
    scope: 'document' as ConsistencyScope,
    minLength: 3,
    minScore: 0,
    resolveConflicts: true,
    overrideModelLabels: true,
})

/** What the collection pass learned about one folded phrase. */
export interface VocabularyEntry {
    /** The folded form, as searched for. */
    phrase: string
    /** Labels to tag it with, best-scoring first. */
    labels: { label: string; score: number; count: number }[]
}

/** Folded phrase -> what to tag it as. */
export type Vocabulary = Map<string, VocabularyEntry>

/**
 * Pool entities into a vocabulary of phrases to look for.
 *
 * Ordering within an entry is deterministic -- best score, then most sightings,
 * then the label itself -- so the same input always resolves the same way.
 */
export function buildVocabulary(
    entities: Iterable<Entity>,
    options: { minLength?: number; minScore?: number; resolveConflicts?: boolean } = {}
): Vocabulary {
    const minLength = options.minLength ?? 1
    const minScore = options.minScore ?? 0
    const vocabulary: Vocabulary = new Map()

    for (const entity of entities) {
        if (entity.score < minScore) continue
        const { folded } = foldForMatching(entity.word)
        if (folded.length < minLength) continue

        let entry = vocabulary.get(folded)
        if (!entry) {
            entry = { phrase: folded, labels: [] }
            vocabulary.set(folded, entry)
        }
        const seen = entry.labels.find((l) => l.label === entity.entity_group)
        if (seen) {
            seen.score = Math.max(seen.score, entity.score)
            seen.count += 1
        } else {
            entry.labels.push({ label: entity.entity_group, score: entity.score, count: 1 })
        }
    }

    for (const entry of vocabulary.values()) {
        entry.labels.sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label))
        if (options.resolveConflicts !== false) entry.labels = entry.labels.slice(0, 1)
    }
    return vocabulary
}

/**
 * Re-tag one document from a vocabulary.
 *
 * Phrases are tried longest-first and a match that overlaps an already-claimed
 * span is skipped, so "John Smith" wins over "John" on the same text rather
 * than both being emitted.
 *
 * `overrideModelLabels: false` keeps the model's own label wherever it tagged
 * the exact span being written, so the pass only ever adds occurrences.
 */
export function applyVocabulary(
    document: Document,
    vocabulary: Vocabulary,
    found: readonly Entity[],
    options: { overrideModelLabels?: boolean } = {}
): Entity[] {
    if (document.text.length === 0 || vocabulary.size === 0) return []

    const { folded, offsets } = foldForMatching(document.text)
    const mapping = buildCharToBoxMap(document.text, document.bboxes)
    // Scores and provenance for spans the model actually reported here.
    const bySpan = new Map(found.map((entity) => [`${entity.start}:${entity.end}`, entity]))

    const claimed: { start: number; end: number }[] = []
    const overlaps = (start: number, end: number) =>
        claimed.some((span) => start < span.end && end > span.start)

    const entities: Entity[] = []
    const phrases = [...vocabulary.values()].sort((a, b) => b.phrase.length - a.phrase.length)

    for (const entry of phrases) {
        for (const span of findWholeWordOccurrences(folded, entry.phrase)) {
            if (overlaps(span.start, span.end)) continue
            claimed.push(span)

            const start = offsets[span.start] as number
            // The last folded character can stand for several source ones, so
            // the end is its source index plus one, not the next span's start.
            const end = (offsets[span.end - 1] as number) + 1
            const model = bySpan.get(`${start}:${end}`)
            const boxes = boxesForRange(mapping, document.bboxes, start, end)
            // Re-slice from the original text so the reported word keeps the
            // casing it has at *this* position, not the one the seed had.
            const word = document.text.slice(start, end)

            // The model tagged this exact span itself and is being trusted, so
            // its label stands and the vocabulary's is not written over it.
            if (model && options.overrideModelLabels === false) {
                entities.push({ ...model, word, boxes, source: 'model' })
                continue
            }

            for (const { label, score } of entry.labels) {
                const fromModel = model?.entity_group === label
                entities.push({
                    entity_group: label,
                    score: fromModel ? model.score : score,
                    word,
                    start,
                    end,
                    boxes,
                    source: fromModel ? 'model' : 'propagated',
                })
            }
        }
    }

    // This stage adds recall; it must never cost any. A model span that is not
    // a whole word -- 'Smith' inside 'Smithson' -- matches nothing on the way
    // back and would otherwise vanish, turning a consistency pass into a filter.
    // Matched on the span alone, not on span-and-label: a model entity whose
    // label lost the conflict resolution must not sneak back in beside the
    // winner, and one nested inside a longer phrase has already been decided.
    const covered = entities.map((e) => ({ start: e.start, end: e.end }))
    for (const entity of found) {
        if (covered.some((span) => entity.start < span.end && entity.end > span.start)) continue
        entities.push({ ...entity, source: 'model' })
    }

    return entities.sort((a, b) => a.start - b.start || a.entity_group.localeCompare(b.entity_group))
}

export class NerConsistency extends Stage<NerConsistencyParams> {
    readonly name = 'NerConsistency'

    /**
     * The document-scope vocabulary, live only for the duration of one
     * `transform`. Stages run one at a time within a pipeline, and it is
     * cleared in a `finally`, so a re-used instance cannot leak one run's
     * vocabulary into the next.
     */
    private vocabulary: Vocabulary | null = null

    constructor(options: Partial<NerConsistencyParams> = {}) {
        super(
            resolveParams(NER_CONSISTENCY_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2) {
                        throw new RangeError('inputCols must be [nerColumn, documentColumn]')
                    }
                },
                scope: (value) => {
                    if (!CONSISTENCY_SCOPES.includes(value)) {
                        throw new RangeError(`scope must be one of ${CONSISTENCY_SCOPES.join(', ')}`)
                    }
                },
                minLength: (value) => assertPositiveInt('minLength', value),
                minScore: (value) => assertInRange('minScore', value, 0, 1),
            })
        )
    }

    /**
     * Collect first, rewrite second.
     *
     * The whole point of document scope is that a row is rewritten using
     * entities found in *other* rows, so the collection pass must see every row
     * before any of them is touched. Delegating to `super.transform` keeps the
     * error capture, `keepInputData` handling and per-row timing every stage
     * shares.
     */
    override async transform(rows: Row[], ctx: StageContext): Promise<Row[]> {
        this.vocabulary = this.params.scope === 'document' ? this.collect(rows) : null
        try {
            return await super.transform(rows, ctx)
        } finally {
            this.vocabulary = null
        }
    }

    /** Pool the entities of every given row into one vocabulary. */
    private collect(rows: readonly Row[]): Vocabulary {
        const { minLength, minScore, resolveConflicts } = this.params
        const entities: Entity[] = []
        for (const row of rows) {
            const ner = row[this.nerCol] as NerOutput | undefined
            // A row that failed upstream contributes nothing; `apply` is where
            // that failure is reported, once, on the row it belongs to.
            if (!ner || ner.exception) continue
            entities.push(...ner.entities)
        }
        return buildVocabulary(entities, { minLength, minScore, resolveConflicts })
    }

    private get nerCol(): string {
        return this.params.inputCols[0] as string
    }

    private get documentCol(): string {
        return this.params.inputCols[1] as string
    }

    protected async apply(_input: unknown, row: Row): Promise<NerOutput> {
        const ner = row[this.nerCol] as NerOutput | undefined
        const document = row[this.documentCol] as Document | undefined

        if (!ner || !Array.isArray(ner.entities)) {
            throw new NerError(`Expected NER output in "${this.nerCol}"`, this.name)
        }
        if (ner.exception) {
            throw new NerError(`Upstream stage failed: ${ner.exception}`, this.name)
        }
        if (!document || typeof document.text !== 'string') {
            throw new NerError(`Expected a Document in "${this.documentCol}"`, this.name)
        }
        if (document.exception) {
            throw new NerError(`Upstream stage failed: ${document.exception}`, this.name)
        }

        const vocabulary = this.vocabulary ?? this.collect([row])
        const entities = applyVocabulary(document, vocabulary, ner.entities, {
            overrideModelLabels: this.params.overrideModelLabels,
        })

        return createNerOutput({
            path: String(row[this.params.pathCol] ?? ner.path ?? 'memory'),
            entities,
            json: JSON.stringify(entities),
        })
    }

    protected onError(message: string, row: Row): NerOutput {
        return createNerOutput({
            path: String(row[this.params.pathCol] ?? 'memory'),
            exception: message,
        })
    }
}
