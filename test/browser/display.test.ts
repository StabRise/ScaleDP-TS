/**
 * Display helpers build DOM, so they need a real document.
 *
 * The security-relevant case: recognized text and entity words come straight
 * from the document, so a page containing markup must never reach the DOM as
 * markup.
 */
import { describe, expect, it } from 'vitest'
import {
    colorForGroup,
    renderInto,
    showBoxes,
    showJson,
    showNer,
    showText,
    visualizeNer,
} from '../../src/display/index.js'
import { createBox } from '../../src/schemas/box.js'
import { createDocument } from '../../src/schemas/document.js'
import { createNerOutput, type Entity } from '../../src/schemas/entity.js'

const entity = (init: Partial<Entity>): Entity => ({
    entity_group: 'person',
    score: 0.9,
    word: 'Raja',
    start: 0,
    end: 4,
    boxes: [],
    ...init,
})

describe('colorForGroup', () => {
    it('is stable for a given name, so two renders match', () => {
        expect(colorForGroup('person')).toBe(colorForGroup('person'))
    })

    it('separates different groups', () => {
        expect(colorForGroup('person')).not.toBe(colorForGroup('organization'))
    })
})

describe('showText', () => {
    it('renders the text and preserves layout by default', () => {
        const node = showText(createDocument({ text: 'a    b\n\nc' }))
        expect(node.tagName).toBe('PRE')
        expect(node.textContent).toBe('a    b\n\nc')
        expect(node.style.whiteSpace).toBe('pre')
    })

    it('never interprets document text as markup', () => {
        const node = showText(createDocument({ text: '<img src=x onerror=alert(1)>' }))
        expect(node.querySelector('img')).toBeNull()
        expect(node.textContent).toContain('<img')
    })

    it('shows the exception instead when the stage failed', () => {
        const node = showText(createDocument({ exception: 'OCR blew up' }))
        expect(node.textContent).toContain('OCR blew up')
    })
})

describe('showJson', () => {
    it('pretty-prints an object and passes strings through', () => {
        expect(showJson({ a: 1 }).textContent).toBe('{\n  "a": 1\n}')
        expect(showJson('{"a":1}').textContent).toBe('{"a":1}')
    })
})

describe('showNer', () => {
    const ner = createNerOutput({
        entities: [entity({}), entity({ entity_group: 'email', word: 'a@b.com', start: 5, end: 12 })],
    })

    it('builds a row per entity plus a header', () => {
        const table = showNer(ner).querySelector('table')
        expect(table?.rows).toHaveLength(3)
        expect(table?.rows[1]?.cells[1]?.textContent).toBe('Raja')
    })

    it('honours the limit and says what was hidden', () => {
        const node = showNer(ner, { limit: 1 })
        expect(node.querySelector('table')?.rows).toHaveLength(2)
        expect(node.textContent).toContain('Showing 1 of 2')
    })

    it('filters by whiteList', () => {
        const node = showNer(ner, { whiteList: ['email'] })
        expect(node.querySelector('table')?.rows).toHaveLength(2)
        expect(node.textContent).toContain('a@b.com')
    })

    it('reports an empty result rather than an empty table', () => {
        expect(showNer(createNerOutput({})).textContent).toContain('No entities')
    })

    it('never interprets an entity word as markup', () => {
        const hostile = createNerOutput({ entities: [entity({ word: '<b>bold</b>' })] })
        const node = showNer(hostile)
        expect(node.querySelector('b')).toBeNull()
        expect(node.textContent).toContain('<b>bold</b>')
    })
})

describe('visualizeNer', () => {
    const document_ = createDocument({ text: 'Raja works at Acme' })

    it('highlights entities inline and keeps the surrounding text', () => {
        const ner = createNerOutput({
            entities: [
                entity({ start: 0, end: 4, word: 'Raja' }),
                entity({ entity_group: 'organization', start: 14, end: 18, word: 'Acme' }),
            ],
        })
        const node = visualizeNer(document_, ner)
        expect(node.textContent).toBe('Raja works at Acme')
        expect(node.querySelectorAll('span')).toHaveLength(2)
        expect(node.querySelectorAll('span')[0]?.textContent).toBe('Raja')
    })

    it('drops an overlapping entity rather than duplicating characters', () => {
        const ner = createNerOutput({
            entities: [
                entity({ start: 0, end: 4, score: 0.9 }),
                entity({ start: 2, end: 8, score: 0.5, entity_group: 'organization' }),
            ],
        })
        // Text must still read exactly as the original.
        expect(visualizeNer(document_, ner).textContent).toBe('Raja works at Acme')
    })

    it('ignores offsets outside the text', () => {
        const ner = createNerOutput({ entities: [entity({ start: 100, end: 200 })] })
        expect(visualizeNer(document_, ner).textContent).toBe('Raja works at Acme')
    })

    it('filters by labelsList', () => {
        const ner = createNerOutput({
            entities: [
                entity({ start: 0, end: 4 }),
                entity({ entity_group: 'organization', start: 14, end: 18 }),
            ],
        })
        const node = visualizeNer(document_, ner, { labelsList: ['organization'] })
        expect(node.querySelectorAll('span')).toHaveLength(1)
        expect(node.querySelector('span')?.textContent).toBe('Acme')
    })
})

describe('showBoxes', () => {
    it('tabulates boxes and truncates with a note', () => {
        const document_ = createDocument({
            bboxes: Array.from({ length: 5 }, (_, i) =>
                createBox({ text: `w${i}`, score: 0.9, x: i, y: 0, width: 10, height: 5 })
            ),
        })
        const node = showBoxes(document_, 2)
        expect(node.querySelector('table')?.rows).toHaveLength(3)
        expect(node.textContent).toContain('Showing 2 of 5')
    })
})

describe('renderInto', () => {
    it('replaces the target contents', () => {
        const host = document.createElement('div')
        host.textContent = 'old'
        document.body.append(host)
        renderInto(host, showJson({ a: 1 }))
        expect(host.textContent).toContain('"a": 1')
        host.remove()
    })

    it('throws for a selector that matches nothing', () => {
        expect(() => renderInto('#nope', document.createTextNode('x'))).toThrow(/No element/)
    })
})
