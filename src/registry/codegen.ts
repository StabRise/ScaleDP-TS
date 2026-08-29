/**
 * A pipeline, written back out as the TypeScript that builds it.
 *
 * The registry already knows which subpath each stage is imported from and what
 * its defaults are, which is everything the source needs. Emitting only the
 * options that differ from the defaults keeps the result readable as the set of
 * decisions someone actually made -- the same reason the JSON form stores only
 * those.
 */

import type { StageDescriptor } from '../core/pipeline.js'
import { STAGE_SPECS } from './catalog.js'

export interface PipelineCodeOptions {
    /** Name bound to the pipeline. */
    variable?: string
    /** Emit the import block above it. */
    imports?: boolean
    /** Spaces per indent level. */
    indent?: number
}

/** Structural equality, deep enough for param values: scalars and string lists. */
function same(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => value === b[index])
    }
    return a === b
}

/** A value as TypeScript source, in the quote style the library is written in. */
function literal(value: unknown): string {
    if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
    if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
    return JSON.stringify(value) ?? 'undefined'
}

/** The options that differ from the stage's defaults, as `key: value` source. */
function changedOptions(descriptor: StageDescriptor): string[] {
    const spec = STAGE_SPECS.find((candidate) => candidate.type === descriptor.type)
    const options = descriptor.options ?? {}

    return Object.keys(options)
        .filter((key) => !spec || !same(spec.defaults[key], options[key]))
        .map((key) => `${key}: ${literal(options[key])}`)
}

/**
 * Import lines, grouped by subpath.
 *
 * The root comes first because `Pipeline` lives there and every pipeline needs
 * it; the engine subpaths follow in alphabetical order, which is what biome's
 * import sorting would produce anyway.
 */
function importLines(descriptors: readonly StageDescriptor[], root: string): string[] {
    const bySubpath = new Map<string, Set<string>>()
    bySubpath.set(root, new Set(['Pipeline']))

    for (const descriptor of descriptors) {
        const spec = STAGE_SPECS.find((candidate) => candidate.type === descriptor.type)
        if (!spec) continue
        const names = bySubpath.get(spec.subpath) ?? new Set<string>()
        names.add(descriptor.type)
        bySubpath.set(spec.subpath, names)
    }

    return [...bySubpath.entries()]
        .sort(([a], [b]) => (a === root ? -1 : b === root ? 1 : a.localeCompare(b)))
        .map(([subpath, names]) => `import { ${[...names].sort().join(', ')} } from '${subpath}'`)
}

export function pipelineCode(
    descriptors: readonly StageDescriptor[],
    options: PipelineCodeOptions = {}
): string {
    const variable = options.variable ?? 'pipeline'
    const pad = ' '.repeat(options.indent ?? 4)
    const root = STAGE_SPECS.find((spec) => spec.subpath.endsWith('/scaledp'))?.subpath ?? '@stabrise/scaledp'

    const stages = descriptors.map((descriptor) => {
        const entries = changedOptions(descriptor)
        if (entries.length === 0) return `${pad}new ${descriptor.type}(),`

        const inline = `${pad}new ${descriptor.type}({ ${entries.join(', ')} }),`
        if (inline.length <= 100) return inline

        // One option per line once the call outgrows a sensible line length,
        // which is what a formatter would do to it anyway.
        return [
            `${pad}new ${descriptor.type}({`,
            ...entries.map((entry) => `${pad}${pad}${entry},`),
            `${pad}}),`,
        ].join('\n')
    })

    const body = [`const ${variable} = new Pipeline([`, ...stages, '])']
    if (options.imports === false) return body.join('\n')

    return [...importLines(descriptors, root), '', ...body].join('\n')
}
