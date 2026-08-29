/**
 * Work out what is in a finished row.
 *
 * The old demo knew its output columns by name -- row.text, row.annotated,
 * row.ner. A pipeline someone assembled can write any column it likes, so the
 * panels have to be derived from the values instead. Every schema in the library
 * is a plain object with a distinguishing field, which is enough to tell them
 * apart.
 */

import type { Row } from '@stabrise/scaledp'
import type { DetectorOutput, Document, NerOutput, ScaleDpImage } from '@stabrise/scaledp/display'

export type OutputKind = 'image' | 'document' | 'detector' | 'ner' | 'orientations'

export interface OutputColumn {
    name: string
    kind: OutputKind
    value: unknown
    /** Non-empty when the stage that wrote it failed. */
    exception: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

function classify(value: unknown): OutputKind | null {
    if (Array.isArray(value)) {
        return value.every((item) => item === '0_degree' || item === '180_degree') && value.length > 0
            ? 'orientations'
            : null
    }
    if (!isObject(value)) return null
    if ('entities' in value) return 'ner'
    if ('data' in value && 'width' in value) return 'image'
    if ('bboxes' in value) return 'text' in value ? 'document' : 'detector'
    return null
}

/** Every renderable column in a row, in the order the pipeline wrote them. */
export function outputsOf(row: Row | null): OutputColumn[] {
    if (!row) return []
    const columns: OutputColumn[] = []

    for (const [name, value] of Object.entries(row)) {
        if (name === 'execution_time') continue
        const kind = classify(value)
        if (!kind) continue
        const exception = isObject(value) && typeof value.exception === 'string' ? value.exception : ''
        columns.push({ name, kind, value, exception })
    }
    return columns
}

export const asImage = (column: OutputColumn): ScaleDpImage => column.value as ScaleDpImage
export const asDocument = (column: OutputColumn): Document => column.value as Document
export const asDetector = (column: OutputColumn): DetectorOutput => column.value as DetectorOutput
export const asNer = (column: OutputColumn): NerOutput => column.value as NerOutput
export const asOrientations = (column: OutputColumn): string[] => column.value as string[]
