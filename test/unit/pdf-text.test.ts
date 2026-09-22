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
        expect(box.angle).toBeCloseTo(0, 3)
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

    it('produces a tight box for a 90-degree rotation, reporting the rotation itself', () => {
        // 90-degree rotation: [a,b,c,d] = [0, 12, -12, 0]
        const box = textItemToBox(item({ transform: [0, 12, -12, 0, 100, 700] }), viewport()) as TextBox
        // Box.width is always the longer side by convention, so it stays 60x12
        // regardless of rotation -- only `angle` records that the run is now
        // vertical rather than horizontal.
        expect(box.width).toBeCloseTo(60, 0)
        expect(box.height).toBeCloseTo(12, 0)
        expect(Math.abs(box.angle) === 90 || Math.abs(box.angle - 90) < 3).toBe(true)
        expect(Math.abs(box.readDirY)).toBeCloseTo(1, 6)
        expect(Math.abs(box.readDirX)).toBeCloseTo(0, 6)
    })

    it('reports a genuine angle and a tight box for text rotated 45 degrees', () => {
        // 45-degree rotation: a=b=c=-d scaled to font size 12.
        const s = 12 / Math.SQRT2
        const box = textItemToBox(item({ transform: [s, s, -s, s, 100, 700] }), viewport()) as TextBox

        // The box must not be flattened to angle 0, and its footprint must be
        // the tight 60x12 rect (Box.width/height are the rect's own side
        // lengths, unaffected by rotation) -- not the much larger axis-aligned
        // bounding box that the old min/max-of-corners code produced instead,
        // whose side would have been roughly (60+12)/sqrt(2) ~= 51.
        expect(Math.abs(box.angle)).toBeGreaterThan(3)
        expect(box.width).toBeCloseTo(60, 0)
        expect(box.height).toBeCloseTo(12, 0)

        // Reading direction sits diagonally, not along either axis.
        expect(Math.abs(box.readDirX)).toBeGreaterThan(0.3)
        expect(Math.abs(box.readDirY)).toBeGreaterThan(0.3)
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
    // `run()` describes a horizontal 180x12 line starting at its real (viewport
    // space) top-left corner, i.e. anchor == (x, y) and the height vector runs
    // straight down -- the geometry `extract-text.ts` would produce for
    // upright text.
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
        anchorX: 100,
        anchorY: 50,
        heightX: 0,
        heightY: 12,
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
        // Anchor sits at the run's real start corner: the right edge, since
        // reading runs from there towards x=100.
        const words = splitRunIntoWords(run({ readDirX: -1, anchorX: 280, anchorY: 50 }))
        expect(words.map((w) => w.text)).toEqual(['Client:', 'Raja', 'Raman'])
        const xs = words.map((w) => w.x)
        // Reading direction is reversed, so successive words move leftward.
        expect(xs).toEqual([...xs].sort((a, b) => b - a))
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(100 - 3)
    })

    it('produces a vertical stack for bottom-to-top text', () => {
        // Anchor sits at the bottom of a 12-wide, 180-tall column; the height
        // vector (cross-reading extent) now runs horizontally.
        const words = splitRunIntoWords(
            run({
                readDirX: 0,
                readDirY: -1,
                width: 12,
                height: 180,
                anchorX: 100,
                anchorY: 230,
                heightX: 12,
                heightY: 0,
            })
        )
        expect(words).toHaveLength(3)
        const ys = words.map((w) => w.y)
        expect(ys).toEqual([...ys].sort((a, b) => b - a))
    })

    it('splits a 45-degree run into words that progress diagonally', () => {
        // Reading direction and height vector both at 45 degrees, viewport y-down.
        const d = Math.SQRT1_2
        const words = splitRunIntoWords(
            run({
                readDirX: d,
                readDirY: d,
                anchorX: 100,
                anchorY: 50,
                heightX: -12 * d,
                heightY: 12 * d,
                width: 180,
                height: 12,
                angle: 45,
            })
        )
        expect(words.map((w) => w.text)).toEqual(['Client:', 'Raja', 'Raman'])
        // Each successive word's centre must move further along the diagonal.
        const centres = words.map((w) => w.x + w.y)
        expect(centres).toEqual([...centres].sort((a, b) => a - b))
        for (const w of words) {
            expect(w.width).toBeGreaterThan(0)
            expect(w.height).toBeGreaterThan(0)
        }
    })
})

describe('documentOptions', () => {
    it('sets useWorkerFetch itself rather than letting pdf.js derive it', async () => {
        // pdf.js derives it with `isValidFetchUrl(url, document.baseURI)` — a
        // bare `document`, which is a ReferenceError inside a Worker. It only
        // reaches that expression when every asset URL is set, which is exactly
        // the configured case, so `getDocument` threw before touching a page and
        // every PDF stage died in a worker.
        const { configure, resetConfig } = await import('../../src/core/config.js')
        const { documentOptions } = await import('../../src/pdf/pdfjs.js')
        try {
            configure({
                pdf: {
                    cMapUrl: '/pdfjs/cmaps/',
                    standardFontDataUrl: '/pdfjs/standard_fonts/',
                    wasmUrl: '/pdfjs/wasm/',
                },
            })
            const options = documentOptions(new Uint8Array([1, 2, 3]))
            expect(options.useWorkerFetch).toBe(true)

            // A class, not an instance: pdf.js constructs it itself, and the
            // lowercase `canvasFactory` key is ignored on `getDocument`. Only
            // offered where OffscreenCanvas exists, which this node environment
            // is not — so the guard, not the class, is what is asserted here.
            expect(options.CanvasFactory).toBe(
                typeof OffscreenCanvas === 'undefined' ? undefined : expect.any(Function)
            )
        } finally {
            resetConfig()
        }
    })

    it('still answers when no asset URLs are configured', async () => {
        const { resetConfig } = await import('../../src/core/config.js')
        const { documentOptions } = await import('../../src/pdf/pdfjs.js')
        resetConfig()
        // Nothing for pdf.js to validate, so the worker cannot fetch them.
        expect(documentOptions(new Uint8Array([1])).useWorkerFetch).toBe(false)
    })
})
