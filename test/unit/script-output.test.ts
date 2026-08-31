/**
 * The OSD output schema and the script→preset map it carries.
 *
 * Both are pure data, so they belong here rather than in the browser project
 * that exercises the stage.
 */
import { describe, expect, it } from 'vitest'
import {
    DEFAULT_OCR_PRESET,
    isKnownPreset,
    PADDLE_OCR_PRESETS,
    presetForRow,
    presetsForScript,
} from '../../src/ocr/presets.js'
import { createScriptOutput } from '../../src/schemas/script.js'

describe('createScriptOutput', () => {
    it('fills every field, so a consumer never meets undefined', () => {
        expect(createScriptOutput()).toEqual({
            path: 'memory',
            type: 'tesseract-osd',
            script: '',
            script_confidence: 0,
            orientation_degrees: 0,
            orientation_confidence: 0,
            presets: [],
            exception: '',
        })
    })

    it('keeps a zero confidence rather than defaulting it away', () => {
        const output = createScriptOutput({ script: 'Latin', script_confidence: 0 })
        expect(output.script).toBe('Latin')
        expect(output.script_confidence).toBe(0)
    })
})

describe('presetsForScript', () => {
    it('names presets that exist, best-first', () => {
        const cyrillic = presetsForScript('Cyrillic').map((preset) => preset.value)

        expect(cyrillic).toContain('v5-cyrillic-mobile')
        expect(cyrillic).toContain('v5-eslav-mobile')
        expect(cyrillic).not.toContain('v5-latin-mobile')
        for (const value of cyrillic) expect(isKnownPreset(value)).toBe(true)
        // The list is ordered, and OSD's answer must not reorder it.
        expect(cyrillic).toEqual(
            PADDLE_OCR_PRESETS.filter((preset) => preset.scripts.includes('Cyrillic')).map(
                (preset) => preset.value
            )
        )
    })

    it('returns nothing for a script no preset covers', () => {
        // Tesseract's OSD reports scripts no PP-OCR model here can read.
        expect(presetsForScript('Hebrew')).toEqual([])
        expect(presetsForScript('')).toEqual([])
    })
})

describe('presetForRow', () => {
    const cyrillic = createScriptOutput({
        script: 'Cyrillic',
        presets: ['v5-eslav-mobile', 'v5-cyrillic-mobile'],
    })

    it('takes the head of a script detection, which is the best match', () => {
        expect(presetForRow({ script: cyrillic }, 'script', 'v6-small')).toBe('v5-eslav-mobile')
    })

    it('pins the model when no column is named', () => {
        expect(presetForRow({ script: cyrillic }, '', 'v6-small')).toBe('v6-small')
    })

    it('accepts a preset id written straight into the column', () => {
        expect(presetForRow({ pick: 'v5-greek-mobile' }, 'pick', 'v6-small')).toBe('v5-greek-mobile')
    })

    it.each([
        ['a missing column', {}],
        ['an unidentified script', { script: createScriptOutput() }],
        ['a failed detection', { script: createScriptOutput({ exception: 'boom' }) }],
        ['a script no preset covers', { script: createScriptOutput({ script: 'Hebrew' }) }],
        ['a preset id this build does not know', { script: 'v9-imaginary' }],
        ['a value of the wrong shape', { script: 42 }],
    ])('falls back on %s rather than throwing', (_case, row) => {
        expect(presetForRow(row, 'script', 'v6-small')).toBe('v6-small')
    })

    it('defaults the fallback to the library default', () => {
        expect(presetForRow({}, 'script')).toBe(DEFAULT_OCR_PRESET)
    })
})
