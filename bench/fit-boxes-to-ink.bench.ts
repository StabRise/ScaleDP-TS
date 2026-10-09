/**
 * FitBoxesToInk on a synthetic A4 page at 300 DPI.
 *
 * Words are drawn as dark strokes on white with boxes a little short of their
 * ink, as a text layer or a detector reports them, so every box actually grows.
 * Two densities: a typical page, and a dense one (small print, two columns).
 *
 *   npx vitest bench --project unit bench/fit-boxes-to-ink.bench.ts
 */
import { bench, describe } from 'vitest'
import type { Box } from '../src/schemas/box.js'
import { fitBoxesToInk, type Luma, toLuma } from '../src/stages/fit-boxes-to-ink.js'

const WIDTH = 2480
const HEIGHT = 3508

function page(lines: number, wordsPerLine: number): { luma: Luma; rgba: ImageData; boxes: Box[] } {
    const data = new Uint8Array(WIDTH * HEIGHT).fill(250)
    const boxes: Box[] = []
    const lineHeight = Math.floor((HEIGHT - 200) / lines)
    const glyph = Math.floor(lineHeight * 0.6)
    const wordWidth = Math.floor((WIDTH - 200) / wordsPerLine) - Math.floor(glyph * 0.6)

    for (let line = 0; line < lines; line++) {
        const top = 100 + line * lineHeight
        for (let word = 0; word < wordsPerLine; word++) {
            const left = 100 + word * (wordWidth + Math.floor(glyph * 0.6))
            // Letters: vertical strokes with gaps, plus a capital standing a little apart.
            for (let x = left; x < left + wordWidth; x++) {
                const inLetter = (x - left) % 9 < 5
                if (!inLetter) continue
                for (let y = top; y < top + glyph; y++) data[y * WIDTH + x] = 30
            }
            // The box misses two pixels of ink at every side.
            boxes.push({
                text: 'word',
                score: 1,
                x: left + 2,
                y: top + 2,
                width: wordWidth - 4,
                height: glyph - 4,
                angle: 0,
            })
        }
    }

    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4)
    for (let p = 0, i = 0; p < data.length; p++, i += 4) {
        const v = data[p] as number
        rgba[i] = v
        rgba[i + 1] = v
        rgba[i + 2] = v
        rgba[i + 3] = 255
    }
    const image = { data: rgba, width: WIDTH, height: HEIGHT, colorSpace: 'srgb' } as unknown as ImageData
    return { luma: { data, width: WIDTH, height: HEIGHT }, rgba: image, boxes }
}

const typical = page(45, 11) // ~500 words
const dense = page(90, 22) // ~2000 words

describe('FitBoxesToInk', () => {
    bench('toLuma, A4 at 300 DPI', () => {
        toLuma(typical.rgba)
    })
    bench('fitBoxesToInk, ~500 boxes', () => {
        fitBoxesToInk(typical.luma, typical.boxes)
    })
    bench('fitBoxesToInk, ~2000 boxes', () => {
        fitBoxesToInk(dense.luma, dense.boxes)
    })
})
