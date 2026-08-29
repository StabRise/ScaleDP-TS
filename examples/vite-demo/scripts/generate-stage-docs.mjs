/**
 * Write the parameter tables on every stage page from the stage catalogue.
 *
 * `src/registry/catalog.ts` already carries what a stage takes, what each
 * parameter means and what it defaults to -- the builder renders its controls
 * from it and `pipelineCode` decides what to emit from it. Restating the same
 * table by hand in prose is how the old `docs/stages.md` drifted.
 *
 * So the prose stays hand-written and only the region between the markers is
 * generated:
 *
 *     {@ generated:params @}  ...  {@ /generated:params @}   (as MDX comments)
 *
 * Run with `--check` to fail instead of writing, which is what `typecheck`
 * does. Same discipline as the Python parity goldens: the generator is the
 * source, the file in the tree is the artefact, and CI proves they agree.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const STAGES_DIR = join(root, 'content/docs/stages')

const OPEN = '{/* generated:params */}'
const CLOSE = '{/* /generated:params */}'
const CATALOGUE_OPEN = '{/* generated:catalogue */}'
const CATALOGUE_CLOSE = '{/* /generated:catalogue */}'

const check = process.argv.includes('--check')

const { STAGE_SPECS } = await import(resolve(root, '../../dist/registry/index.js'))

/** `DbnetOnnxDetector` -> `dbnet-onnx-detector`, the page's filename. */
const slugFor = (type) =>
    type
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase()

/* ── Rendering ───────────────────────────────────────────────────────────── */

/** The six every stage has; documented once in Concepts, not fifteen times. */
const BASE_KEYS = new Set(['inputCol', 'outputCol', 'pathCol', 'pageCol', 'keepInputData', 'propagateError'])

/**
 * Make a catalogue string safe inside an MDX table cell.
 *
 * `|` would end the cell; `<` starts a JSX tag (`class_<n>` in the YOLO help
 * is a real example) and `{` starts an expression. The help text is prose
 * written for a form control, not markup, so all three are escaped rather than
 * interpreted.
 */
const escapeCell = (value) =>
    String(value)
        .replace(/\|/g, '\\|')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\{/g, '&#123;')
        .replace(/\}/g, '&#125;')

/** A default, as it would be written in TypeScript. */
function renderDefault(value) {
    if (value === undefined) return '—'
    if (typeof value === 'string') return `\`'${value}'\``
    if (Array.isArray(value)) {
        if (value.length === 0) return '`[]`'
        return `\`[${value.map((item) => (typeof item === 'string' ? `'${item}'` : item)).join(', ')}]\``
    }
    return `\`${JSON.stringify(value)}\``
}

/** The type column: the kind, narrowed by whatever the spec knows. */
function renderType(param) {
    switch (param.kind) {
        case 'enum': {
            const values = (param.options ?? []).map((option) => `\`'${option.value}'\``)
            // Fourteen Paddle presets in one cell is a wall; point at the list.
            if (values.length > 6) return `${values.slice(0, 4).join(' \\| ')} \\| … (${values.length} total)`
            return values.join(' \\| ') || '`string`'
        }
        case 'stringList':
            return '`string[]`'
        case 'columns':
            return `\`string[]\`${param.arity ? ` (${param.arity})` : param.minArity ? ` (${param.minArity}+)` : ''}`
        case 'column':
        case 'color':
            return '`string`'
        case 'number':
            return param.min !== undefined && param.max !== undefined
                ? `\`number\` ${param.min}–${param.max}`
                : '`number`'
        default:
            return `\`${param.kind}\``
    }
}

function renderTable(params, defaults) {
    const rows = params.map(
        (param) =>
            `| \`${param.key}\` | ${renderType(param)} | ${renderDefault(defaults[param.key])} | ${escapeCell(param.help ?? param.label)} |`
    )
    return ['| Parameter | Type | Default | Meaning |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

function renderParams(spec) {
    const own = spec.params.filter((param) => !param.advanced && !BASE_KEYS.has(param.key))
    const base = spec.params.filter((param) => param.advanced || BASE_KEYS.has(param.key))

    const parts = ['## Parameters', '', renderTable(own, spec.defaults)]

    if (base.length > 0) {
        parts.push(
            '',
            '<Accordions>',
            '<Accordion title="Column wiring and error handling">',
            '',
            renderTable(base, spec.defaults),
            '',
            '</Accordion>',
            '</Accordions>'
        )
    }

    return parts.join('\n')
}

function renderCatalogue() {
    const groups = ['Read', 'Detect', 'Recognise', 'Transform', 'Understand']
    const lines = []

    for (const group of groups) {
        const specs = STAGE_SPECS.filter((spec) => spec.group === group)
        if (specs.length === 0) continue

        lines.push(`### ${group}`, '')
        lines.push('| Stage | Reads | Writes | Needs |', '| --- | --- | --- | --- |')
        for (const spec of specs) {
            const dir = group.toLowerCase()
            const needs = spec.peer ? `\`${spec.peer}\`` : '—'
            lines.push(
                `| [${spec.type}](/docs/stages/${dir}/${slugFor(spec.type)}) | ${
                    spec.consumes.join(', ') || '—'
                } | ${spec.produces} | ${needs} |`
            )
        }
        lines.push('')
    }

    return lines.join('\n').trimEnd()
}

/* ── Splicing ────────────────────────────────────────────────────────────── */

function splice(source, open, close, body, label) {
    const start = source.indexOf(open)
    const end = source.indexOf(close)
    if (start === -1 || end === -1) throw new Error(`${label}: missing ${open} … ${close} markers`)
    if (end < start) throw new Error(`${label}: ${close} appears before ${open}`)

    return `${source.slice(0, start + open.length)}\n\n${body}\n\n${source.slice(end)}`
}

async function* mdxFiles(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) yield* mdxFiles(path)
        else if (entry.name.endsWith('.mdx')) yield path
    }
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

const stale = []
const seen = new Set()

for await (const path of mdxFiles(STAGES_DIR)) {
    const source = await readFile(path, 'utf8')
    const relative = path.slice(root.length + 1)

    let next
    if (source.includes(CATALOGUE_OPEN)) {
        next = splice(source, CATALOGUE_OPEN, CATALOGUE_CLOSE, renderCatalogue(), relative)
    } else if (source.includes(OPEN)) {
        const slug = path
            .split('/')
            .pop()
            .replace(/\.mdx$/, '')
        const spec = STAGE_SPECS.find((candidate) => slugFor(candidate.type) === slug)
        if (!spec) throw new Error(`${relative}: no stage in the catalogue is named "${slug}"`)
        seen.add(spec.type)
        next = splice(source, OPEN, CLOSE, renderParams(spec), relative)
    } else {
        continue
    }

    if (next === source) continue
    if (check) stale.push(relative)
    else await writeFile(path, next)
}

// A stage nobody documented is the failure this catches; the registry test
// already covers a parameter nobody catalogued.
const undocumented = STAGE_SPECS.filter((spec) => !seen.has(spec.type)).map((spec) => spec.type)
if (undocumented.length > 0) {
    console.error(`No page found for: ${undocumented.join(', ')}`)
    console.error(`Expected content/docs/stages/<group>/<slug>.mdx with a ${OPEN} region.`)
    process.exit(1)
}

if (stale.length > 0) {
    console.error('Stage parameter tables are out of date:')
    for (const path of stale) console.error(`  ${path}`)
    console.error('\nRun `npm run docs:generate`.')
    process.exit(1)
}

if (!check) console.log(`Stage parameter tables written for ${seen.size} stages.`)
