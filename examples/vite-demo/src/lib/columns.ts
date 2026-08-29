import { type ColumnKind, getStageSpec, type StageSpec } from '@stabrise/scaledp/registry'
import type { StageNode } from '../store/pipeline'

/** A row field, and what the stage that wrote it puts there. */
export interface Column {
    name: string
    kind: ColumnKind
    /** Index of the stage that writes it; -1 for the pipeline's own input. */
    from: number
    /** Written to be looked at, not fed onward. See StageSpec.terminal. */
    terminal: boolean
}

/**
 * `toRows()` puts the file's bytes in `content` and its name in `path` before
 * the first stage runs, so those two exist without anyone writing them.
 */
const SEED: Column[] = [
    { name: 'content', kind: 'bytes', from: -1, terminal: false },
    { name: 'path', kind: 'bytes', from: -1, terminal: false },
]

const paramValue = (node: StageNode, spec: StageSpec, key: string): unknown =>
    key in node.options ? node.options[key] : spec.defaults[key]

/** Read a param that names a column, whatever the stage calls it. */
export function columnParam(node: StageNode, key: string): string | undefined {
    const spec = getStageSpec(node.type)
    if (!spec) return undefined
    const value = paramValue(node, spec, key)
    return typeof value === 'string' ? value : undefined
}

/** Read a param that names several columns. */
export function columnsParam(node: StageNode, key: string): string[] {
    const spec = getStageSpec(node.type)
    if (!spec) return []
    const value = paramValue(node, spec, key)
    return Array.isArray(value) ? value.map(String) : []
}

/** Every column a stage writes, in the order the pipeline sees them. */
export function writes(node: StageNode, index: number): Column[] {
    const spec = getStageSpec(node.type)
    if (!spec) return []

    const out: Column[] = []
    const terminal = spec.terminal === true
    const outputCol = columnParam(node, 'outputCol')
    if (outputCol) out.push({ name: outputCol, kind: spec.produces, from: index, terminal })

    for (const extra of spec.alsoProduces ?? []) {
        const name = columnParam(node, extra.param)
        if (name) out.push({ name, kind: extra.kind, from: index, terminal })
    }
    return out
}

/**
 * Columns readable by the stage at `index`, most recently written first.
 *
 * Two things the pipeline does have to be modelled here or the suggestions lie.
 *
 * A stage that writes a column another already wrote shadows it -- the chained
 * `ImageDrawBoxes` idiom reads and writes `annotated` over and over -- so later
 * writers win, and each name appears once.
 *
 * And a stage with `keepInputData` off *removes* its input column
 * (`Stage.transform` deletes it). PdfToImage does this by default, so `content`
 * is gone by the second stage -- and a PdfToDocument added after it reads
 * nothing. That is a genuinely confusing failure to hit at run time, and it is
 * knowable here.
 */
export function columnsBefore(stages: readonly StageNode[], index: number): Column[] {
    const byName = new Map<string, Column>()
    for (const column of SEED) byName.set(column.name, column)

    for (let i = 0; i < index && i < stages.length; i++) {
        const node = stages[i]
        if (!node) continue
        for (const column of writes(node, i)) byName.set(column.name, column)
        for (const dropped of drops(node)) byName.delete(dropped)
    }
    return [...byName.values()].sort((a, b) => b.from - a.from)
}

/** The input column a stage deletes on its way through, if any. */
export function drops(node: StageNode): string[] {
    const spec = getStageSpec(node.type)
    if (!spec) return []
    const keep = 'keepInputData' in node.options ? node.options.keepInputData : spec.defaults.keepInputData
    if (keep) return []

    const inputCol = columnParam(node, 'inputCol')
    const outputCol = columnParam(node, 'outputCol')
    return inputCol && inputCol !== outputCol ? [inputCol] : []
}

/**
 * The most recent upstream column of a given kind, for pre-wiring a new stage.
 *
 * A terminal column -- an annotated page -- is skipped unless the stage being
 * wired is itself terminal. Otherwise adding a detector after a draw pass would
 * point it at the overlay and it would read text through the boxes drawn on top
 * of it. Chaining draw passes still lands on `annotated`, which is the idiom.
 */
export function latestOfKind(
    stages: readonly StageNode[],
    index: number,
    kind: ColumnKind,
    allowTerminal = false
): string | undefined {
    const candidates = columnsBefore(stages, index).filter((column) => column.kind === kind)
    return (
        (allowTerminal ? candidates[0] : candidates.find((column) => !column.terminal))?.name ??
        candidates[0]?.name
    )
}

/**
 * Input columns a stage reads: `inputCols` where it has one, `inputCol` otherwise.
 *
 * Multi-input stages inherit `inputCol` and ignore it, so reporting it as an
 * input would produce a warning about a column nobody reads.
 */
export function reads(node: StageNode): { name: string; kind?: ColumnKind }[] {
    const spec = getStageSpec(node.type)
    if (!spec) return []

    const multi = spec.params.find((param) => param.kind === 'columns')
    if (multi) {
        return columnsParam(node, multi.key).map((name, position) => ({
            name,
            kind: multi.accepts?.[Math.min(position, multi.accepts.length - 1)],
        }))
    }
    const single = columnParam(node, 'inputCol')
    return single ? [{ name: single, kind: spec.consumes[0] }] : []
}

/**
 * The earlier stage this one multiplies rows against, if any.
 *
 * A stage that `expands` turns one row into several -- a page each, a crop
 * each. Two of them in a row is fine when the second reads what the first
 * produced: it subdivides those rows. It is *not* fine when the second reads a
 * column that already existed before the first ran, because then every row the
 * first made gets expanded again: a `PdfToImage` and a `PdfToDocument` both
 * reading `content` turn a five-page file into twenty-five rows.
 */
export function multipliesRows(stages: readonly StageNode[], index: number): string | null {
    const node = stages[index]
    const spec = node && getStageSpec(node.type)
    if (!node || !spec?.expands) return null

    const earlier = stages.findIndex(
        (candidate, i) => i < index && getStageSpec(candidate.type)?.expands === true
    )
    if (earlier === -1) return null

    const available = columnsBefore(stages, index)
    const readsFresh = reads(node).some((input) => {
        const column = available.find((candidate) => candidate.name === input.name)
        return column !== undefined && column.from >= earlier
    })
    if (readsFresh) return null

    return getStageSpec(stages[earlier]?.type ?? '')?.label ?? stages[earlier]?.type ?? null
}

/** Inputs the stage reads that nothing upstream writes. Reported, never blocking. */
export function danglingInputs(stages: readonly StageNode[], index: number): string[] {
    const node = stages[index]
    if (!node) return []
    const available = new Set(columnsBefore(stages, index).map((column) => column.name))
    return reads(node)
        .map((input) => input.name)
        .filter((name) => name && !available.has(name))
}
