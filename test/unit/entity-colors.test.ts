/**
 * Colouring by entity group is only useful if the groups get different colours.
 *
 * A hash of the name does not guarantee that: over the label sets these models
 * actually emit it gave `phone_number` and `date` the same hue and put `person`
 * one degree from `ip_address`. That is the birthday problem, so the fix is a
 * hand-assigned table, and these are the assertions that keep it honest as
 * labels are added.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PII_LABELS, GLINER2_PII_LABELS } from '../../src/ner/registry.js'
import { colorForGroup } from '../../src/stages/image-draw-boxes.js'

/** Every group the library's own models can emit. */
const LABELS = [...new Set([...DEFAULT_PII_LABELS, ...GLINER2_PII_LABELS])]

/** Names for one concept, which share a colour on purpose. */
const ALIASES = [
    ['person', 'person_name'],
    ['phone', 'phone_number'],
    ['account', 'account_number'],
    ['ip', 'ip_address'],
]

const hueOf = (name: string): number => Number(/hsl\((\d+)/.exec(colorForGroup(name))?.[1])

describe('colorForGroup', () => {
    it('is stable for a given name, so two renders match', () => {
        expect(colorForGroup('person')).toBe(colorForGroup('person'))
    })

    it('gives every group a colour', () => {
        for (const label of LABELS) expect(colorForGroup(label)).toMatch(/^hsl\(\d+, 70%, 45%\)$/)
    })

    it('gives distinct groups distinct colours', () => {
        const aliasOf = new Map(ALIASES.flatMap(([a, b]) => [[b as string, a as string]]))
        const seen = new Map<string, string>()
        for (const label of LABELS) {
            const canonical = aliasOf.get(label) ?? label
            const color = colorForGroup(label)
            const owner = seen.get(color)
            if (owner) expect(owner).toBe(canonical)
            else seen.set(color, canonical)
        }
    })

    it.each(ALIASES)('treats %s and %s as one concept', (a, b) => {
        expect(colorForGroup(a as string)).toBe(colorForGroup(b as string))
    })

    it('keeps distinct groups far enough apart to tell apart', () => {
        const hues = [...new Set(LABELS.map(hueOf))].sort((a, b) => a - b)
        for (let i = 1; i < hues.length; i++) {
            expect((hues[i] as number) - (hues[i - 1] as number)).toBeGreaterThanOrEqual(18)
        }
        // The wheel wraps, so the last and the first are neighbours too.
        expect(360 - (hues[hues.length - 1] as number) + (hues[0] as number)).toBeGreaterThanOrEqual(18)
    })

    it('folds case and separators, so PERSON-NAME is person_name', () => {
        expect(colorForGroup('PERSON-NAME')).toBe(colorForGroup('person_name'))
        expect(colorForGroup('Person Name')).toBe(colorForGroup('person_name'))
    })

    it('still colours a group nobody anticipated', () => {
        expect(colorForGroup('spaceship_registration')).toMatch(/^hsl\(\d+, 70%, 45%\)$/)
        expect(colorForGroup('spaceship_registration')).toBe(colorForGroup('spaceship_registration'))
    })
})
