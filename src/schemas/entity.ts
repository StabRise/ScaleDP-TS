/** Port of `scaledp/schemas/Entity.py` and `NerOutput.py`. */

import type { Box } from './box.js'

/**
 * Where an entity came from.
 *
 * A producer that does not track provenance leaves this unset, so the field is
 * additive -- Python's `Entity` has no such column.
 */
export type EntitySource = 'model' | 'propagated'

export interface Entity {
    entity_group: string
    score: number
    word: string
    /** Character offset into the source document text. */
    start: number
    end: number
    /** Boxes the entity's characters fall inside; empty when there is no OCR layer. */
    boxes: Box[]
    /** Set by `NerConsistency`: whether a model found this occurrence or it was propagated onto it. */
    source?: EntitySource
}

export interface NerOutput {
    path: string
    entities: Entity[]
    exception: string
    json: string
}

export function createNerOutput(init: Partial<NerOutput> = {}): NerOutput {
    return {
        path: init.path ?? 'memory',
        entities: init.entities ?? [],
        exception: init.exception ?? '',
        json: init.json ?? '',
    }
}
