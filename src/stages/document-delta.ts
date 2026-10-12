/**
 * The text a later reading of a page added, as a document of its own.
 *
 * A PDF page is often read twice: the text layer first, so results come in
 * at once, then again with the text found inside embedded images merged in
 * (`PdfMergeImageText`). Sending the merged page to NER a second time
 * re-analyses -- and, with a cloud service, pays for -- every word the first
 * pass already read. With `strategy: 'text-layer-wins'` the merge only ever
 * adds boxes, so the difference between the two documents is exactly the new
 * text, and this is that difference.
 *
 * Pair it with `NerMerger`: run NER on the delta only, then merge both
 * readings back onto the merged page's offsets.
 *
 * This stage has no equivalent in Python ScaleDP.
 */

import { ImageError, upstreamError } from '../core/errors.js'
import { BASE_STAGE_DEFAULTS, type BaseStageParams, resolveParams } from '../core/params.js'
import { type Row, Stage } from '../core/pipeline.js'
import type { Box } from '../schemas/box.js'
import { createDocument, type Document } from '../schemas/document.js'

export interface DocumentDeltaParams extends BaseStageParams {
    /** `[baseColumn, mergedColumn]`: the first reading, then the reading that may have added to it. */
    inputCols: string[]
}

export const DOCUMENT_DELTA_DEFAULTS: DocumentDeltaParams = Object.freeze({
    ...BASE_STAGE_DEFAULTS,
    inputCol: 'document',
    inputCols: ['document', 'merged'],
    outputCol: 'delta',
    keepInputData: true,
})

/**
 * A box's identity across two documents.
 *
 * Rounded, because a box that went out to a service as JSON and came back may
 * differ in its last float digit and is still the same box. The text is part
 * of it so two boxes of one size at one spot can still be told apart.
 */
export function boxIdentity(box: Box): string {
    return `${box.text} ${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`
}

/**
 * The boxes `merged` has and `base` does not, as a document.
 *
 * Empty when the later reading added nothing -- the page had no readable
 * picture, or the text layer covered everything in it -- which is the common
 * case on a born-digital PDF. Gate the NER that reads the delta with
 * `when: { path: 'delta.bboxes.length', gt: 0 }` and that case costs nothing.
 *
 * The text is the boxes' text, one per line: NER needs some separator, and a
 * box is the unit that reading added.
 */
export function documentDelta(base: Document | undefined, merged: Document): Document {
    const known = new Set((base?.exception ? [] : (base?.bboxes ?? [])).map(boxIdentity))
    const added = merged.bboxes.filter((box) => !known.has(boxIdentity(box)))
    return createDocument({
        path: merged.path,
        type: merged.type,
        bboxes: added,
        text: added.map((box) => box.text).join('\n'),
    })
}

export class DocumentDelta extends Stage<DocumentDeltaParams> {
    readonly name = 'DocumentDelta'

    constructor(options: Partial<DocumentDeltaParams> = {}) {
        super(
            resolveParams(DOCUMENT_DELTA_DEFAULTS, options, {
                inputCols: (value) => {
                    if (value.length !== 2)
                        throw new RangeError('inputCols must be [baseColumn, mergedColumn]')
                },
            })
        )
    }

    protected async apply(_input: unknown, row: Row): Promise<Document> {
        const [baseCol, mergedCol] = this.params.inputCols as [string, string]
        const merged = row[mergedCol] as Document | undefined
        if (!merged || !Array.isArray(merged.bboxes)) {
            throw new ImageError(`Expected a Document in "${mergedCol}"`, this.name)
        }
        if (merged.exception) {
            throw upstreamError(merged.exception, this.name, (message) => new ImageError(message, this.name))
        }
        // A base that failed or is missing read nothing, so everything is new.
        return documentDelta(row[baseCol] as Document | undefined, merged)
    }

    protected onError(message: string, row: Row): Document {
        return createDocument({ path: String(row[this.params.pathCol] ?? 'memory'), exception: message })
    }
}
