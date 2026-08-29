/**
 * Split a pdf.js text run into word-level boxes.
 *
 * pdf.js emits runs at line granularity ("Client: Raja Raman"), but detection
 * boxes and NER offsets both want words. Each word is measured with Canvas 2D
 * `measureText` using a font reconstructed from the pdf.js font name, then the
 * measured widths are scaled so they sum to the run's actual width -- the
 * substitute font is never metrically identical to the embedded one, so the
 * measurements are only useful as *proportions*.
 *
 * Walking along `readDirX`/`readDirY` rather than assuming left-to-right is what
 * makes rotated, bottom-to-top and right-to-left runs come out correctly.
 */

import { context2d, createCanvas } from '../core/image.js'
import type { Box } from '../schemas/box.js'
import type { TextBox } from './extract-text.js'

/** Widen each word slightly so glyph overhang is not clipped. */
const WORD_PADDING_RATIO = 0.1

let measureCtx: OffscreenCanvasRenderingContext2D | null = null

function measurementContext(): OffscreenCanvasRenderingContext2D | null {
    if (measureCtx) return measureCtx
    try {
        measureCtx = context2d(createCanvas(1, 1))
        return measureCtx
    } catch {
        // No canvas (e.g. a non-browser test run): fall back to glyph heuristics.
        return null
    }
}

/**
 * Rebuild a CSS font string from a pdf.js font name.
 *
 * Names look like `AAAAAA+Helvetica-BoldOblique`: a six-letter subset prefix,
 * then the real family and style suffixes.
 */
export function cssFontFromPdfName(fontName: string, size: number): string {
    const name = fontName.replace(/^[A-Z]{6}\+/, '')
    const lower = name.toLowerCase()
    const weight = /bold|black|heavy|semibold/.test(lower) ? 'bold' : 'normal'
    const style = /italic|oblique/.test(lower) ? 'italic' : 'normal'
    const family = /serif|times|georgia|garamond|roman/.test(lower)
        ? 'serif'
        : /mono|courier|consol/.test(lower)
          ? 'monospace'
          : 'sans-serif'
    return `${style} ${weight} ${Math.max(1, Math.round(size))}px ${family}`
}

/**
 * Relative advance width per character, used when no canvas is available.
 * Buckets rather than real metrics -- enough to keep proportions sane.
 */
export function relativeCharWidth(char: string): number {
    if ("iljI|.,:;'`!".includes(char)) return 0.6
    if ('ftr()[]{}-'.includes(char)) return 0.8
    if ('MWmw@%'.includes(char)) return 1.6
    if (char === ' ') return 0.6
    if (char >= 'A' && char <= 'Z') return 1.3
    return 1.0
}

function measureWord(word: string, font: string): number {
    const ctx = measurementContext()
    if (ctx) {
        ctx.font = font
        return ctx.measureText(word).width
    }
    let total = 0
    for (const char of word) total += relativeCharWidth(char)
    return total
}

/**
 * Split one run into word boxes.
 *
 * Returns the run itself when it holds a single word, so the common case costs
 * nothing.
 */
export function splitRunIntoWords(run: TextBox): Box[] {
    const trimmed = run.text.trim()
    if (trimmed.length === 0) return []

    const tokens = trimmed.split(/(\s+)/).filter((t) => t.length > 0)
    const words = tokens.filter((t) => !/^\s+$/.test(t))
    if (words.length <= 1) {
        return [{ ...run, text: trimmed }]
    }

    const font = cssFontFromPdfName(run.fontName, run.height)
    const measured = tokens.map((token) => measureWord(token, font))
    const totalMeasured = measured.reduce((sum, w) => sum + w, 0) || 1

    // The substitute font's absolute metrics are meaningless; only the ratios
    // matter, so normalise them onto the run's real extent.
    const runLength = Math.hypot(run.width * run.readDirX, run.height * run.readDirY) || run.width
    const scale = runLength / totalMeasured

    // Walking starts at whichever corner the reading direction comes *from*, so
    // a right-to-left or bottom-to-top run starts at the opposite edge.
    let cursorX = run.readDirX >= 0 ? run.x : run.x + run.width
    let cursorY = run.readDirY >= 0 ? run.y : run.y + run.height

    const out: Box[] = []
    for (const [i, token] of tokens.entries()) {
        const advance = (measured[i] as number) * scale
        if (!/^\s+$/.test(token)) {
            const pad = run.height * WORD_PADDING_RATIO
            const spanX = Math.abs(run.readDirX) > Math.abs(run.readDirY) ? advance : run.width
            const spanY = Math.abs(run.readDirY) > Math.abs(run.readDirX) ? advance : run.height

            const left = run.readDirX >= 0 ? cursorX : cursorX - spanX
            const top = run.readDirY >= 0 ? cursorY : cursorY - spanY

            out.push({
                text: token,
                score: run.score,
                x: Math.floor(left - pad),
                y: Math.floor(top - pad),
                width: Math.max(1, Math.ceil(spanX + pad * 2)),
                height: Math.max(1, Math.ceil(spanY + pad * 2)),
                angle: run.angle,
            })
        }
        cursorX += run.readDirX * advance
        cursorY += run.readDirY * advance
    }
    return out
}

/** Split every run on a page into word boxes. */
export function splitRunsIntoWords(runs: readonly TextBox[]): Box[] {
    return runs.flatMap(splitRunIntoWords)
}

/** Reset the cached measurement canvas. Tests only. */
export function resetMeasurementContext(): void {
    measureCtx = null
}
