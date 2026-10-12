/**
 * Several NER readings of one page, merged into one, with offsets into one
 * document.
 *
 * Two shapes of pipeline need it:
 *
 * - **Two passes over a page.** NER runs on the text layer, then on just the
 *   text an embedded-image pass added (`DocumentDelta`). Each reading's
 *   offsets point into the document *it* read -- neither is the merged page --
 *   so they cannot simply be concatenated: `NerConsistency` matches entities by
 *   `start`/`end`, and would propagate over spans the model already tagged.
 * - **Two recognisers over one text.** `GlinerNer` and `RegexNer` both find an
 *   e-mail address, and the page should carry it once.
 *
 * Entities are put back into `documentCol`'s coordinates by their boxes, not
 * by searching their text: a string usually occurs several times on a page,
 * and the boxes say which occurrence an entity is. Boxes are absolute page
 * coordinates, so they survive every pass intact. Then the same span with the
 * same label, found twice, is kept once, at its best score.
 *
 * This stage has no equivalent in Python ScaleDP.
 */

import { buildCharToBoxMap } from '../core/entities.js'
import { isSkipped, NerError, upstreamError } from '../core/errors.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import type { Box } from '../schemas/box.js'
import type { Document } from '../schemas/document.js'
import { createNerOutput, type Entity, type NerOutput } from '../schemas/entity.js'
import { boxIdentity } from './document-delta.js'

export type NerMergeDedupe = 'span' | 'none'

export const NER_MERGE_DEDUPE: readonly NerMergeDedupe[] = Object.freeze(['span', 'none'])

export interface NerMergerParams extends BaseStageParams {
    /**
     * The `NerOutput` columns to merge. A column a skipped stage never wrote is
     * read as no entities.
     */
    inputCols: string[]
    /**
     * The `Document` the merged offsets should point into: the page as it
     * finally stands. Empty keeps every entity's offsets as they came, for
     * readings that were all taken over one document already.
     */
    documentCol: string
    /**
     * `span` keeps an entity found twice -- same start, end and label -- once,
     * at its higher score. `none` keeps every reading.
     */
    dedupe: NerMergeDedupe
}

export const NER_MERGER_DEFAULTS: NerMergerParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'ner',
    inputCols: ['ner', 'delta_ner'],
    documentCol: 'merged',
    outputCol: 'ner',
    keepInputData: true,
    dedupe: 'span' as NerMergeDedupe,
})

/** The character range each box occupies in `document.text`, by box index. */
function rangesByBox(document: Document): ({ start: number; end: number } | undefined)[] {
    const mapping = buildCharToBoxMap(document.text, document.bboxes)
    const ranges: ({ start: number; end: number } | undefined)[] = new Array(document.bboxes.length)
    for (let i = 0; i < mapping.length; i++) {
        const index = mapping[i] as number
        if (index < 0) continue
        const range = ranges[index]
        if (range) range.end = i + 1
        else ranges[index] = { start: i, end: i + 1 }
    }
    return ranges
}

/**
 * Put entity offsets into `document`'s coordinates.
 *
 * By boxes first: the span runs from the first to the last character of the
 * boxes the entity covers. An entity whose boxes are not on `document` falls
 * back to the first occurrence of its word, and failing that keeps what it
 * had -- a wrong offset costs a consistency propagation, never a redaction,
 * because the boxes are what get drawn.
 */
export function rebaseEntities(entities: readonly Entity[], document: Document): Entity[] {
    const ranges = rangesByBox(document)
    const indexByBox = new Map(document.bboxes.map((box, index) => [boxIdentity(box), index]))

    return entities.map((entity) => {
        let start = Number.POSITIVE_INFINITY
        let end = -1
        for (const box of entity.boxes as readonly Box[]) {
            const index = indexByBox.get(boxIdentity(box))
            const range = index === undefined ? undefined : ranges[index]
            if (!range) continue
            start = Math.min(start, range.start)
            end = Math.max(end, range.end)
        }
        if (end >= 0) {
            // The text between the boxes' extremes, which is the entity's own
            // word when the boxes are exactly its own.
            return { ...entity, start, end, word: entity.word || document.text.slice(start, end) }
        }

        const found = entity.word ? document.text.indexOf(entity.word) : -1
        return found >= 0 ? { ...entity, start: found, end: found + entity.word.length } : entity
    })
}

/** The same span with the same label once, at its best score. */
export function dedupeEntities(entities: readonly Entity[]): Entity[] {
    const best = new Map<string, Entity>()
    for (const entity of entities) {
        const key = `${entity.start}:${entity.end}:${entity.entity_group}`
        const seen = best.get(key)
        if (!seen || entity.score > seen.score) best.set(key, entity)
    }
    return [...best.values()]
}

export class NerMerger extends Stage<NerMergerParams> {
    readonly name = 'NerMerger'

    constructor(options: Partial<NerMergerParams> = {}) {
        super(
            resolveParams(NER_MERGER_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length === 0)
                        throw new RangeError('inputCols must name at least one NER column')
                },
                dedupe: (value) => {
                    if (!NER_MERGE_DEDUPE.includes(value)) {
                        throw new RangeError(`dedupe must be one of ${NER_MERGE_DEDUPE.join(', ')}`)
                    }
                },
            })
        )
    }

    override reads(): string[] {
        return [...this.params.inputCols, ...(this.params.documentCol ? [this.params.documentCol] : [])]
    }

    protected async apply(_input: unknown, row: Row): Promise<NerOutput> {
        const { inputCols, documentCol, dedupe, pathCol } = this.params

        const readings: NerOutput[] = []
        const failures: string[] = []
        for (const col of inputCols) {
            const value = row[col] as NerOutput | undefined
            // A stage skipped by `when` wrote nothing: no entities, not a failure.
            if (value === undefined) continue
            if (!Array.isArray(value?.entities)) {
                throw new NerError(`Expected NER output in "${col}"`, this.name)
            }
            if (value.exception && !isSkipped(value.exception)) failures.push(value.exception)
            else if (!value.exception) readings.push(value)
        }
        // One reading failing does not cost the page the others: the delta pass
        // over a picture can fail while the text layer's entities stand. Only
        // when nothing was read is the page a failure.
        if (readings.length === 0 && failures.length > 0) {
            throw upstreamError(failures.join('; '), this.name, (message) => new NerError(message, this.name))
        }

        let entities = readings.flatMap((reading) => reading.entities)
        let path = String(row[pathCol] ?? readings[0]?.path ?? 'memory')

        if (documentCol) {
            const document = row[documentCol] as Document | undefined
            if (!document || typeof document.text !== 'string') {
                throw new NerError(`Expected a Document in "${documentCol}"`, this.name)
            }
            if (document.exception) {
                throw upstreamError(
                    document.exception,
                    this.name,
                    (message) => new NerError(message, this.name)
                )
            }
            entities = rebaseEntities(entities, document)
            path = String(row[pathCol] ?? document.path ?? path)
        }

        if (dedupe === 'span') entities = dedupeEntities(entities)
        entities.sort(
            (a, b) => a.start - b.start || a.end - b.end || a.entity_group.localeCompare(b.entity_group)
        )

        return createNerOutput({ path, entities, json: JSON.stringify(entities) })
    }

    protected onError(message: string, row: Row): NerOutput {
        return createNerOutput({ path: String(row[this.params.pathCol] ?? 'memory'), exception: message })
    }
}
