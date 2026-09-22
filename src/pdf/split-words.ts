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
import { type Box, boxFromPolygon, type Point } from '../schemas/box.js'
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

    // The run's real reading-axis extent, taken from the true corner-to-corner
    // distance rather than run.width -- Box forces `width` to be the longer
    // side, which for a tall/narrow run is the *height* axis, not this one.
    const scale = readingLength(run) / totalMeasured

    const heightMag = Math.hypot(run.heightX, run.heightY) || 1
    const upX = run.heightX / heightMag
    const upY = run.heightY / heightMag
    const pad = heightMag * WORD_PADDING_RATIO

    // Walking starts at the run's real anchor corner (where the glyph transform
    // places the first character) and advances along the true reading vector --
    // this works unmodified for right-to-left, bottom-to-top and rotated runs,
    // none of which are axis-aligned corner-plus-span rectangles.
    let offset = 0

    const out: Box[] = []
    for (const [i, token] of tokens.entries()) {
        const advance = (measured[i] as number) * scale
        if (!/^\s+$/.test(token)) {
            const segStart = offset - pad
            const segEnd = offset + advance + pad

            const p0: Point = [
                run.anchorX + run.readDirX * segStart - upX * pad,
                run.anchorY + run.readDirY * segStart - upY * pad,
            ]
            const p1: Point = [
                run.anchorX + run.readDirX * segEnd - upX * pad,
                run.anchorY + run.readDirY * segEnd - upY * pad,
            ]
            const p2: Point = [p0[0] + run.heightX + upX * pad * 2, p0[1] + run.heightY + upY * pad * 2]
            const p3: Point = [p1[0] + run.heightX + upX * pad * 2, p1[1] + run.heightY + upY * pad * 2]

            out.push(boxFromPolygon([p0, p1, p2, p3], { text: token, score: run.score }))
        }
        offset += advance
    }
    return out
}

/** True reading-axis extent of a run, from its real corner-to-corner distance. */
function readingLength(run: TextBox): number {
    // anchor -> anchor + readDir * L is corners[0] -> corners[1] from extraction;
    // recovering L from width/height would pick the wrong axis whenever the run
    // is taller than it is wide, since Box.width is always the longer side.
    const heightMag = Math.hypot(run.heightX, run.heightY)
    const area = run.width * run.height
    return heightMag > 0 ? area / heightMag : run.width
}

/** Split every run on a page into word boxes. */
export function splitRunsIntoWords(runs: readonly TextBox[]): Box[] {
    return runs.flatMap(splitRunIntoWords)
}

/** Reset the cached measurement canvas. Tests only. */
export function resetMeasurementContext(): void {
    measureCtx = null
}
