import { describe, expect, it } from 'vitest'
import { isTextItem, type TextBox, textItemToBox } from '../../src/pdf/extract-text.js'
import { cssFontFromPdfName, relativeCharWidth, splitRunIntoWords } from '../../src/pdf/split-words.js'

/**
 * A pdf.js viewport at scale 1 with the usual y-flip: PDF user space has y
 * increasing upward, viewport space has it increasing downward.
 */
function viewport(height = 800) {
    return { convertToViewportPoint: (x: number, y: number) => [x, height - y] }
}

function item(overrides: Partial<Parameters<typeof textItemToBox>[0]> = {}) {
    return {
        str: 'Hello',
        transform: [12, 0, 0, 12, 100, 700],
        width: 60,
        height: 12,
        fontName: 'g_d0_f1',
        ...overrides,
    }
}

describe('isTextItem', () => {
    it('rejects marked-content items, which carry no transform', () => {
        expect(isTextItem({ type: 'beginMarkedContent' })).toBe(false)
        expect(isTextItem(item())).toBe(true)
    })
})

describe('textItemToBox', () => {
    it('places upright text and flips y into viewport space', () => {
        const box = textItemToBox(item(), viewport()) as TextBox
        expect(box.text).toBe('Hello')
        expect(box.x).toBe(100)
        expect(box.width).toBe(60)
        expect(box.height).toBe(12)
        // Baseline at y=700, glyph tops 9pt above it, flipped into a 800-tall page.
        expect(box.y).toBe(800 - 709)
        expect(box.readDirX).toBeCloseTo(1, 6)
        expect(box.readDirY).toBeCloseTo(0, 6)
    })

    it('drops empty strings', () => {
        expect(textItemToBox(item({ str: '' }), viewport())).toBeNull()
    })

    it('does not double-count font size when the matrix is scaled', () => {
        // A 48pt font has a matrix 4x larger, but width/height already account
        // for it -- reading the matrix as a scale would quadruple the box.
        const small = textItemToBox(item(), viewport()) as TextBox
        const large = textItemToBox(item({ transform: [48, 0, 0, 48, 100, 700] }), viewport()) as TextBox
        expect(large.width).toBe(small.width)
    })

    it('produces an axis-aligned box for rotated text and reports the reading direction', () => {
        // 90-degree rotation: [a,b,c,d] = [0, 12, -12, 0]
        const box = textItemToBox(item({ transform: [0, 12, -12, 0, 100, 700] }), viewport()) as TextBox
        expect(box.angle).toBe(0)
        // Text now runs vertically, so the box is tall and narrow.
        expect(box.height).toBeGreaterThan(box.width)
        expect(Math.abs(box.readDirY)).toBeCloseTo(1, 6)
        expect(Math.abs(box.readDirX)).toBeCloseTo(0, 6)
    })
})

describe('cssFontFromPdfName', () => {
    it('strips the subset prefix and detects style', () => {
        expect(cssFontFromPdfName('AAAAAA+Helvetica-BoldOblique', 12)).toBe('italic bold 12px sans-serif')
        expect(cssFontFromPdfName('BCDEFG+Times-Roman', 10)).toBe('normal normal 10px serif')
        expect(cssFontFromPdfName('Courier', 9)).toBe('normal normal 9px monospace')
    })
})

describe('relativeCharWidth', () => {
    it('ranks narrow, normal and wide glyphs', () => {
        expect(relativeCharWidth('i')).toBeLessThan(relativeCharWidth('n'))
        expect(relativeCharWidth('n')).toBeLessThan(relativeCharWidth('M'))
    })
})

describe('splitRunIntoWords', () => {
    const run = (overrides: Partial<TextBox> = {}): TextBox => ({
        text: 'Client: Raja Raman',
        score: 0.99,
        x: 100,
        y: 50,
        width: 180,
        height: 12,
        angle: 0,
        readDirX: 1,
        readDirY: 0,
        fontName: 'Helvetica',
        ...overrides,
    })

    it('returns the run unchanged when it holds a single word', () => {
        const words = splitRunIntoWords(run({ text: 'Client', width: 60 }))
        expect(words).toHaveLength(1)
        expect(words[0]?.text).toBe('Client')
    })

    it('drops whitespace-only runs', () => {
        expect(splitRunIntoWords(run({ text: '   ' }))).toHaveLength(0)
    })

    it('splits into words that advance left to right and stay inside the run', () => {
        const words = splitRunIntoWords(run())
        expect(words.map((w) => w.text)).toEqual(['Client:', 'Raja', 'Raman'])

        const xs = words.map((w) => w.x)
        expect(xs).toEqual([...xs].sort((a, b) => a - b))
        // Padding lets words bleed slightly past the run; allow the full pad.
        const pad = Math.ceil(12 * 0.1) + 1
        expect(words[0]?.x).toBeGreaterThanOrEqual(100 - pad)
        const last = words[words.length - 1] as { x: number; width: number }
        expect(last.x + last.width).toBeLessThanOrEqual(100 + 180 + pad * 2)
    })

    it('walks from the opposite edge when reading right to left', () => {
        const words = splitRunIntoWords(run({ readDirX: -1, x: 100, width: 180 }))
        expect(words.map((w) => w.text)).toEqual(['Client:', 'Raja', 'Raman'])
        const xs = words.map((w) => w.x)
        // Reading direction is reversed, so successive words move leftward.
        expect(xs).toEqual([...xs].sort((a, b) => b - a))
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(100 - 3)
    })

    it('produces a vertical stack for bottom-to-top text', () => {
        const words = splitRunIntoWords(run({ readDirX: 0, readDirY: -1, width: 12, height: 180 }))
        expect(words).toHaveLength(3)
        const ys = words.map((w) => w.y)
        expect(ys).toEqual([...ys].sort((a, b) => b - a))
    })
})
