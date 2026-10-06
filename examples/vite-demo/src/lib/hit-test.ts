/**
 * Which boxes lie under a point on the page.
 *
 * The inverse of the outline the page draws: `boxOverlay` turns a box by
 * `angle` degrees about its centre, so a point is tested by turning it back by
 * the same angle about that centre and checking the upright rectangle.
 */
import type { Box } from '@stabrise/scaledp/display'

/** A point on the page, in the image's own pixels. */
export interface PagePoint {
    x: number
    y: number
    /** Image pixels of slack, so a hairline box can still be hit. */
    tolerance: number
    /** Bumped on every click, so the same spot clicked twice is two clicks. */
    seq: number
}

export function boxContains(box: Box, x: number, y: number, tolerance = 0): boolean {
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const rad = (box.angle * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = x - cx
    const dy = y - cy
    // SVG's rotate(a) maps (x, y) to (x cos a - y sin a, x sin a + y cos a); this is its inverse.
    const rx = dx * cos + dy * sin
    const ry = -dx * sin + dy * cos
    return Math.abs(rx) <= box.width / 2 + tolerance && Math.abs(ry) <= box.height / 2 + tolerance
}

/**
 * Indices of every box under the point, smallest first.
 *
 * Smallest first because boxes nest -- a word inside its line, a line inside a
 * detected region -- and the innermost is almost always the one meant.
 */
export function boxesAt(boxes: readonly Box[], point: PagePoint): number[] {
    const hits: number[] = []
    for (const [index, box] of boxes.entries()) {
        if (boxContains(box, point.x, point.y, point.tolerance)) hits.push(index)
    }
    const area = (i: number) => (boxes[i] as Box).width * (boxes[i] as Box).height
    return hits.sort((a, b) => area(a) - area(b))
}
