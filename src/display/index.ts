/**
 * Result rendering, mirroring ScaleDP's notebook display helpers.
 *
 * Python monkey-patches `show_image`, `show_text`, `show_ner` and
 * `visualize_ner` onto the Spark DataFrame and renders Jinja templates into
 * IPython. The browser equivalent is to build DOM elements, so these return an
 * `HTMLElement` the caller places wherever it likes -- and `renderInto` is the
 * one-liner for the common case.
 *
 * Everything is built with text nodes rather than interpolated markup:
 * recognized text and entity words come straight from the document, and a page
 * containing `<` would otherwise corrupt the DOM.
 */

import type { Box } from '../schemas/box.js'
import type { DetectorOutput } from '../schemas/detector-output.js'
import type { Document } from '../schemas/document.js'
import type { Entity, NerOutput } from '../schemas/entity.js'
import type { ScaleDpImage } from '../schemas/image.js'

/**
 * A stable colour per entity group.
 *
 * Python picks a random colour each run, so two renders of the same document
 * never match. Hashing the group name keeps 'PERSON' one colour everywhere.
 */
export function colorForGroup(name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
    return `hsl(${Math.abs(hash) % 360}, 70%, 45%)`
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { text?: string; className?: string; style?: Partial<CSSStyleDeclaration> } = {}
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (props.text !== undefined) node.textContent = props.text
    if (props.className) node.className = props.className
    if (props.style) Object.assign(node.style, props.style)
    return node
}

/** Replace a container's contents with `node`. Accepts a selector or element. */
export function renderInto(target: string | HTMLElement, node: Node): HTMLElement {
    const host = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
    if (!host) throw new Error(`No element matches ${String(target)}`)
    host.replaceChildren(node)
    return host
}

export interface ShowImageOptions {
    /** CSS width, e.g. '600px' or '100%'. */
    width?: string
    alt?: string
}

/**
 * An `<img>` for a ScaleDP image. Mirrors `show_image`.
 *
 * The object URL is revoked once the image has decoded -- holding one per page
 * leaks the whole blob for the lifetime of the document.
 */
export function showImage(image: ScaleDpImage, options: ShowImageOptions = {}): HTMLElement {
    if (image.exception) return errorBlock(image.exception)

    const bytes = new Uint8Array(image.data.byteLength)
    bytes.set(image.data)
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: `image/${image.imageType}` }))

    const img = element('img', { style: { maxWidth: options.width ?? '100%', height: 'auto' } })
    img.alt = options.alt ?? image.path
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true })
    img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true })
    img.src = url
    return img
}

export interface ShowTextOptions {
    /**
     * Preserve the document's own layout. Correct when the OCR stage ran with
     * `keepFormatting`, which encodes the layout in spaces and blank lines.
     */
    preserveLayout?: boolean
    maxHeight?: string
}

/** A `<pre>` of the recognized text. Mirrors `show_text`. */
export function showText(document_: Document, options: ShowTextOptions = {}): HTMLElement {
    if (document_.exception) return errorBlock(document_.exception)

    return element('pre', {
        text: document_.text,
        className: 'scaledp-text',
        style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '12px',
            whiteSpace: options.preserveLayout === false ? 'pre-wrap' : 'pre',
            overflowX: 'auto',
            maxHeight: options.maxHeight ?? '30rem',
            margin: '0',
        },
    })
}

/** Pretty-printed JSON. Mirrors `show_json`. */
export function showJson(value: unknown, indent = 2): HTMLElement {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, indent)
    return element('pre', {
        text,
        className: 'scaledp-json',
        style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', overflowX: 'auto' },
    })
}

export interface ShowNerOptions {
    /** Maximum rows; 0 shows all. Python defaults to 20. */
    limit?: number
    /** Only these groups. */
    whiteList?: readonly string[]
}

/** A table of entities. Mirrors `show_ner`. */
export function showNer(ner: NerOutput, options: ShowNerOptions = {}): HTMLElement {
    if (ner.exception) return errorBlock(ner.exception)

    const allowed = new Set(options.whiteList ?? [])
    let entities = allowed.size > 0 ? ner.entities.filter((e) => allowed.has(e.entity_group)) : ner.entities

    const limit = options.limit ?? 20
    const total = entities.length
    if (limit > 0) entities = entities.slice(0, limit)

    if (total === 0) return element('p', { text: 'No entities found.' })

    const table = element('table', { className: 'scaledp-ner' })
    table.style.borderCollapse = 'collapse'

    const header = table.insertRow()
    for (const label of ['Type', 'Text', 'Score', 'Start', 'End', 'Boxes']) {
        const th = document.createElement('th')
        th.textContent = label
        th.style.cssText = 'border:1px solid #ddd;padding:4px 8px;text-align:left'
        header.append(th)
    }

    for (const entity of entities) {
        const tr = table.insertRow()
        const swatch = element('span', {
            style: {
                display: 'inline-block',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                marginRight: '6px',
                background: colorForGroup(entity.entity_group),
            },
        })
        const cells: (string | Node)[] = [
            entity.entity_group,
            entity.word,
            entity.score.toFixed(3),
            String(entity.start),
            String(entity.end),
            String(entity.boxes.length),
        ]
        cells.forEach((value, index) => {
            const cell = tr.insertCell()
            cell.style.cssText = 'border:1px solid #ddd;padding:4px 8px'
            if (index === 0) cell.append(swatch)
            cell.append(typeof value === 'string' ? document.createTextNode(value) : value)
        })
    }

    const wrapper = element('div')
    wrapper.append(table)
    if (limit > 0 && total > limit) {
        wrapper.append(element('p', { text: `Showing ${limit} of ${total} entities.` }))
    }
    return wrapper
}

export interface VisualizeNerOptions {
    /** Only highlight these groups. */
    labelsList?: readonly string[]
    /** Render the group name beside each highlight. */
    showLabels?: boolean
}

/**
 * The document text with entities highlighted inline. Mirrors `visualize_ner`.
 *
 * Splices spans by character offset, which is exactly what `Entity.start`/`end`
 * index. Overlapping entities are dropped rather than nested: the highest-
 * scoring one wins, because two spans cannot occupy the same characters in a
 * flat text run.
 */
export function visualizeNer(
    document_: Document,
    ner: NerOutput,
    options: VisualizeNerOptions = {}
): HTMLElement {
    if (document_.exception) return errorBlock(document_.exception)
    if (ner.exception) return errorBlock(ner.exception)

    const allowed = new Set(options.labelsList ?? [])
    const entities = (
        allowed.size > 0 ? ner.entities.filter((e) => allowed.has(e.entity_group)) : ner.entities
    )
        .filter((e) => e.start >= 0 && e.end > e.start && e.end <= document_.text.length)
        .sort((a, b) => a.start - b.start || b.score - a.score)

    const container = element('div', {
        className: 'scaledp-ner-text',
        style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '12px',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.9',
        },
    })

    let cursor = 0
    for (const entity of entities) {
        if (entity.start < cursor) continue // overlaps an already-rendered span

        if (entity.start > cursor) {
            container.append(document.createTextNode(document_.text.slice(cursor, entity.start)))
        }

        const color = colorForGroup(entity.entity_group)
        const mark = element('span', {
            text: document_.text.slice(entity.start, entity.end),
            style: {
                background: color,
                color: '#fff',
                borderRadius: '3px',
                padding: '1px 3px',
            },
        })
        mark.title = `${entity.entity_group} (${entity.score.toFixed(3)})`
        container.append(mark)

        if (options.showLabels) {
            container.append(
                element('sup', {
                    text: entity.entity_group,
                    style: { color, fontSize: '9px', marginLeft: '2px' },
                })
            )
        }
        cursor = entity.end
    }
    container.append(document.createTextNode(document_.text.slice(cursor)))
    return container
}

/** A summary table of detected boxes. */
export function showBoxes(output: DetectorOutput | Document, limit = 20): HTMLElement {
    if (output.exception) return errorBlock(output.exception)

    const boxes: Box[] = output.bboxes
    const table = element('table')
    table.style.borderCollapse = 'collapse'

    const header = table.insertRow()
    for (const label of ['Text', 'Score', 'x', 'y', 'w', 'h', 'angle']) {
        const th = document.createElement('th')
        th.textContent = label
        th.style.cssText = 'border:1px solid #ddd;padding:4px 8px;text-align:left'
        header.append(th)
    }

    for (const box of limit > 0 ? boxes.slice(0, limit) : boxes) {
        const tr = table.insertRow()
        for (const value of [
            box.text,
            box.score.toFixed(3),
            String(box.x),
            String(box.y),
            String(box.width),
            String(box.height),
            box.angle.toFixed(1),
        ]) {
            const cell = tr.insertCell()
            cell.style.cssText = 'border:1px solid #ddd;padding:4px 8px'
            cell.textContent = value
        }
    }

    const wrapper = element('div')
    wrapper.append(table)
    if (limit > 0 && boxes.length > limit) {
        wrapper.append(element('p', { text: `Showing ${limit} of ${boxes.length} boxes.` }))
    }
    return wrapper
}

function errorBlock(message: string): HTMLElement {
    return element('pre', {
        text: message,
        style: {
            color: '#b00020',
            whiteSpace: 'pre-wrap',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
        },
    })
}

export type { DetectorOutput, Document, Entity, NerOutput, ScaleDpImage }
