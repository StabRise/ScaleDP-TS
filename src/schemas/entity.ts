/** Port of `scaledp/schemas/Entity.py` and `NerOutput.py`. */

import type { Box } from './box.js'

export interface Entity {
    entity_group: string
    score: number
    word: string
    /** Character offset into the source document text. */
    start: number
    end: number
    /** Boxes the entity's characters fall inside; empty when there is no OCR layer. */
    boxes: Box[]
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
