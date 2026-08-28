/** Port of `scaledp/schemas/Document.py`. */

import type { Box } from './box.js'

export interface Document {
    path: string
    text: string
    /** Producer of this document: 'text' | 'ocr' | 'pdf' | an engine name. */
    type: string
    bboxes: Box[]
    exception: string
}

export function createDocument(init: Partial<Document> = {}): Document {
    return {
        path: init.path ?? 'memory',
        text: init.text ?? '',
        type: init.type ?? 'text',
        bboxes: init.bboxes ?? [],
        exception: init.exception ?? '',
    }
}

/** Python's `Document.merge` puts the *argument* first and joins with a newline. */
export function mergeDocuments(self: Document, other: Document): Document {
    return {
        path: self.path,
        text: `${other.text}\n${self.text}`,
        type: self.type,
        bboxes: [...other.bboxes, ...self.bboxes],
        exception: self.exception || other.exception,
    }
}
