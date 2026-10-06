/**
 * Lengthen detected text regions along their lines before they are read.
 *
 * A text detector finds the dense core of a line and misses what is thin and
 * isolated at its ends: the looping capital of handwriting, a swash, a final
 * flourish. Those strokes score low on the probability map, so the region
 * starts after them -- and a crop that does not contain the `F` reads `reya`,
 * which is not a name NER can find. A fixed pixel `padding` cannot fix it,
 * because a capital's overhang scales with the writing, not with the page.
 *
 * So each region is extended at both ends by a fraction of its own height. The
 * extension stops short of any other detected region on the same line, which
 * is the guard that matters: the free space a missed capital sits in is taken,
 * a neighbouring table cell is never entered and read twice.
 *
 * Width is the side along the text even for a rotated box, and growing it about
 * the centre keeps a turned line turned. Only upright boxes are clipped against
 * their neighbours; the rarer rotated ones extend in full.
 */

import { type Box, bbox, boxCoverage, isRotated } from '../schemas/box.js'

export function extendAlongText(boxes: readonly Box[], ratio: number): Box[] {
    if (ratio <= 0) return [...boxes]
    return boxes.map((box, index) => {
        const amount = ratio * box.height
        if (amount <= 0) return box

        if (isRotated(box)) {
            return { ...box, x: box.x - amount, width: box.width + 2 * amount }
        }

        const [x0, y0, x1, y1] = bbox(box)
        const centre = (x0 + x1) / 2
        let left = amount
        let right = amount
        for (const [other, neighbour] of boxes.entries()) {
            if (other === index || isRotated(neighbour)) continue
            const [nx0, ny0, nx1, ny1] = bbox(neighbour)
            // Same line: overlapping by at least half the shorter height.
            const overlap = Math.min(y1, ny1) - Math.max(y0, ny0)
            if (overlap < Math.min(y1 - y0, ny1 - ny0) * 0.5) continue
            if ((nx0 + nx1) / 2 < centre) left = Math.min(left, Math.max(0, x0 - nx1))
            else right = Math.min(right, Math.max(0, nx0 - x1))
        }
        return { ...box, x: box.x - left, width: box.width + left + right }
    })
}

/**
 * Drop regions that lie mostly inside a larger one.
 *
 * On handwriting a detector returns, besides each word, small regions for loose
 * pieces of it -- the separate strokes of a looping capital. Once regions are
 * grown to take in what the detector missed, the word's region contains those
 * pieces, and reading them as well only adds overlapping junk: a `T` and a `t`
 * stacked on the `F` of `Freya`. A region covered at least `threshold` by a
 * larger one is read as part of it instead.
 *
 * Index order is kept. Only upright pairs are compared: coverage is measured on
 * axis-aligned bounds, which for a rotated box are not its own.
 */
export function dropNestedRegions(boxes: readonly Box[], threshold = 0.6): Box[] {
    const area = (box: Box) => box.width * box.height
    return boxes.filter(
        (box, index) =>
            isRotated(box) ||
            !boxes.some(
                (other, j) =>
                    j !== index &&
                    !isRotated(other) &&
                    // Strictly larger, or the earlier of two equal ones, so of
                    // two identical regions exactly one survives.
                    (area(other) > area(box) || (area(other) === area(box) && j < index)) &&
                    boxCoverage(box, other) >= threshold
            )
    )
}
