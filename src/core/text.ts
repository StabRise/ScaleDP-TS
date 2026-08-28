/**
 * Layout-preserving text reconstruction from OCR boxes.
 *
 * Port of `BaseOcr.box_to_formatted_text` / `to_formatted_text` /
 * `get_character_width` plus `cluster` and `get_size` from
 * `scaledp/utils/__init__.py`. Pure geometry -- no engine involved.
 *
 * Python truncates with `int()` throughout rather than rounding, and the
 * results feed NER character offsets, so every `Math.trunc` below is
 * deliberate. Verified against the Python implementation in
 * test/unit/text-parity.test.ts.
 */

import type { Box } from '../schemas/box.js'

/**
 * Arrange items into groups whose successive elements differ by no more than
 * `maxGap`. Unlike Python's `cluster`, this does not sort the caller's array
 * in place.
 */
export function cluster<T>(
    items: readonly T[],
    maxGap: number,
    key: (item: T) => number = (x) => x as unknown as number
): T[][] {
    if (items.length === 0) return []
    const sorted = [...items].sort((a, b) => key(a) - key(b))

    const groups: T[][] = [[sorted[0] as T]]
    for (const item of sorted.slice(1)) {
        const group = groups[groups.length - 1] as T[]
        const previous = group[group.length - 1] as T
        if (Math.abs(key(item) - key(previous)) <= maxGap) group.push(item)
        else groups.push([item])
    }
    return groups
}

/**
 * A robust central value: drop the first and last quartile, then take the mode.
 *
 * Trimming the tails is what makes this survive OCR outliers -- a single giant
 * heading would otherwise skew a plain mean. Always returns a truncated
 * integer, matching Python's `int(...)` wrapper.
 */
export function getSize<T>(
    items: readonly T[],
    key: (item: T) => number = (x) => x as unknown as number
): number {
    if (items.length === 0) return 0

    const values = items.map(key)
    if (values.length === 1) return values[0] as number

    values.sort((a, b) => a - b)
    if (values.length <= 4) {
        return Math.trunc(values.reduce((sum, v) => sum + v, 0) / values.length)
    }

    const trim = Math.trunc(values.length / 4)
    const middle = values.slice(trim, values.length - trim)

    // statistics.mode returns the first most-common value, so `>` (not `>=`)
    // keeps the earliest winner on ties.
    const counts = new Map<number, number>()
    for (const value of middle) counts.set(value, (counts.get(value) ?? 0) + 1)
    let best = middle[0] as number
    let bestCount = 0
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value
            bestCount = count
        }
    }
    return Math.trunc(best)
}

/**
 * Median-ish width of a single character, used to size inter-word gaps.
 * Takes grouped lines, matching Python's signature.
 */
export function getCharacterWidth(lines: readonly (readonly Box[])[]): number {
    const widths: number[] = []
    for (const line of lines) {
        for (const box of line) {
            if (box.text.length > 0) widths.push(Math.trunc(box.width / box.text.length))
        }
    }
    return getSize(widths)
}

/**
 * Group boxes into text lines, each sorted left to right.
 *
 * `lineTolerance` of 0 means "derive it": a third of the typical character
 * height -- tight enough to keep adjacent lines apart, loose enough to tolerate
 * baseline jitter.
 */
export function groupBoxesIntoLines(boxes: readonly Box[], lineTolerance = 0): Box[][] {
    if (boxes.length === 0) return []
    const characterHeight = getSize(boxes, (b) => b.height)
    const tolerance = lineTolerance === 0 ? characterHeight / 3 : lineTolerance
    return cluster(boxes, tolerance, (b) => Math.trunc(b.y)).map((line) =>
        [...line].sort((a, b) => Math.trunc(a.x) - Math.trunc(b.x))
    )
}

/**
 * Render grouped lines back to text, preserving horizontal spacing and blank
 * lines.
 *
 * Each line is indented from x = 0, so the left margin is preserved rather than
 * every line being flushed left. Vertical gaps wider than two character heights
 * become blank lines. The running `y` starts at 0, which means the first line is
 * measured against the top of the page -- that is Python's behaviour and it is
 * what makes a top margin survive.
 */
export function linesToFormattedText(lines: readonly (readonly Box[])[], characterHeight: number): string {
    const output: string[] = []
    const spaceWidth = getCharacterWidth(lines) || 1
    let y = 0

    for (const line of lines) {
        const first = line[0]
        if (!first) continue

        const lineDiffs = characterHeight > 0 ? Math.trunc((first.y - y) / (characterHeight * 2)) : 0
        y = first.y
        for (let i = 0; i < lineDiffs - 1; i++) output.push('')

        let text = ''
        let previousRight = 0
        for (const box of line) {
            const spaces = Math.max(Math.trunc((box.x - previousRight) / spaceWidth), 1)
            text += ' '.repeat(spaces) + box.text
            previousRight = box.x + box.width
        }
        output.push(text)
    }
    return output.join('\n')
}

/** Rebuild layout-preserving text straight from a flat box list. */
export function boxesToFormattedText(boxes: readonly Box[], lineTolerance = 0): string {
    if (boxes.length === 0) return ''
    const characterHeight = getSize(boxes, (b) => b.height)
    return linesToFormattedText(groupBoxesIntoLines(boxes, lineTolerance), characterHeight)
}

/** Plain reading-order join, the default when `keepFormatting` is off. */
export function boxesToText(boxes: readonly Box[], separator = ' '): string {
    return boxes.map((b) => b.text).join(separator)
}
