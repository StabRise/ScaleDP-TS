/**
 * Port of `scaledp/schemas/Box.py`.
 *
 * A Box is NOT xyxy and NOT a polygon. `x`/`y` is the top-left of the
 * *axis-aligned* box of the same size centred on the rotated rect's centre,
 * and `angle` is degrees about that same centre. `width` is always the longer
 * side. Getting this wrong silently shifts every downstream consumer, so the
 * conversions below mirror the Python implementation exactly.
 */

import { boxPoints, minAreaRect, type Point, type RotatedRect } from '../core/geometry.js'

export interface Box {
    text: string
    score: number
    /** Top-left x of the axis-aligned box of size width x height centred on the rect centre. */
    x: number
    y: number
    /** Always the longer side. */
    width: number
    height: number
    /** Degrees about the box centre, normalised to (-90, 270]. */
    angle: number
}

/** Two-corner shape: [[x0, y0], [x1, y1]]. */
export type BoxShape = [[number, number], [number, number]]

/** Axis-aligned bounds: [x0, y0, x1, y1]. */
export type BBox = [number, number, number, number]

export type { Point }

/** `abs(angle) >= 3` — matches Python's `is_rotated`, which tolerates OCR jitter. */
export const ROTATION_EPSILON_DEGREES = 3

export function createBox(init: Partial<Box> = {}): Box {
    return {
        text: init.text ?? '',
        score: init.score ?? 0,
        x: init.x ?? 0,
        y: init.y ?? 0,
        width: init.width ?? 0,
        height: init.height ?? 0,
        angle: init.angle ?? 0,
    }
}

export function isRotated(box: Box): boolean {
    return Math.abs(box.angle) >= ROTATION_EPSILON_DEGREES
}

export function bbox(box: Box, padding = 0): BBox {
    return [box.x - padding, box.y - padding, box.x + box.width + padding, box.y + box.height + padding]
}

export function shape(box: Box, padding = 0): BoxShape {
    const [x0, y0, x1, y1] = bbox(box, padding)
    return [
        [x0, y0],
        [x1, y1],
    ]
}

/**
 * Scale a box, then apply padding.
 *
 * Note the padding is asymmetric, and deliberately so: Python subtracts it from
 * the origin and adds it to the size, so the box grows by `padding` on its left
 * and top while its right and bottom edges stay put. Growing all four sides
 * would need `padding * 2` on the size.
 */
export function scaleBox(box: Box, factor: number, padding = 0): Box {
    return {
        ...box,
        x: Math.round(box.x * factor - padding),
        y: Math.round(box.y * factor - padding),
        width: Math.round(box.width * factor + padding),
        height: Math.round(box.height * factor + padding),
    }
}

export function boxFromBBox(box: BBox, opts: { angle?: number; text?: string; score?: number } = {}): Box {
    const [x0, y0, x1, y1] = box
    return {
        text: opts.text ?? '',
        score: opts.score ?? 0,
        x: Math.round(x0),
        y: Math.round(y0),
        width: Math.round(x1 - x0),
        height: Math.round(y1 - y0),
        angle: opts.angle ?? 0,
    }
}

/**
 * Build a Box from exactly 4 polygon points — port of Python `Box.from_polygon`.
 *
 * `width` is forced to be the longer side (subtracting 90 degrees from the angle
 * to compensate), then the angle is normalised to (-90, 270]. `x`/`y` are derived
 * from the centre, NOT from the polygon's bounding box.
 */
export function boxFromPolygon(
    points: readonly Point[],
    opts: { text?: string; score?: number; padding?: number } = {}
): Box {
    if (points.length !== 4) {
        throw new Error(`boxFromPolygon expects exactly 4 points, received ${points.length}`)
    }
    return boxFromRect(minAreaRect(points), opts)
}

/**
 * Normalise a `RotatedRect` (from `minAreaRect`) into a `Box`: width forced to
 * the longer side, angle folded to (-90, 270], centre carried through as
 * `x`/`y`. Shared by `boxFromPolygon` and `mergeBoxes`, which both start from a
 * `minAreaRect` and must not drift in how they turn it into a `Box`.
 */
function boxFromRect(rect: RotatedRect, opts: { text?: string; score?: number; padding?: number } = {}): Box {
    const padding = opts.padding ?? 0
    const [cx, cy] = rect.center

    let [width, height] = rect.size
    let angle = rect.angle
    if (width < height) {
        ;[width, height] = [height, width]
        angle -= 90
    }

    // Normalise to (-90, 270]. Note a rectangle is invariant under a 180-degree
    // rotation, so `angle` and `angle + 180` are interchangeable; which one you
    // get depends on the orientation minAreaRect happened to report.
    angle = ((angle % 360) + 360) % 360
    if (angle > 270) angle -= 360

    // Python clamps both dimensions to at least 1px so degenerate detections
    // stay usable as crop regions.
    width = Math.max(1, Math.round(width) + padding * 2)
    height = Math.max(1, Math.round(height) + padding * 2)

    return {
        text: opts.text ?? '',
        score: opts.score ?? 1,
        x: Math.round(cx - width / 2),
        y: Math.round(cy - height / 2),
        width,
        height,
        angle,
    }
}

/** A box's own corners, as `minAreaRect` would report them back. */
function boxRect(box: Box): RotatedRect {
    return {
        center: [box.x + box.width / 2, box.y + box.height / 2],
        size: [box.width, box.height],
        angle: box.angle,
    }
}

/** Axis-aligned intersection-over-union. Ignores `angle`, exactly as Python does. */
export function boxIou(a: Box, b: Box): number {
    const [ax0, ay0, ax1, ay1] = bbox(a)
    const [bx0, by0, bx1, by1] = bbox(b)

    const ix = Math.min(ax1, bx1) - Math.max(ax0, bx0)
    const iy = Math.min(ay1, by1) - Math.max(ay0, by0)
    if (ix <= 0 || iy <= 0) return 0

    const intersection = ix * iy
    const union = a.width * a.height + b.width * b.height - intersection
    return union <= 0 ? 0 : intersection / union
}

/**
 * How much of `inner` lies inside `outer`, from 0 to 1.
 *
 * The asymmetric companion to `boxIou`, and the right question when comparing
 * boxes from two different producers. A word read by OCR sits entirely inside
 * the line-level box a PDF's text layer reports for the same words, but their
 * IoU is small — so an IoU test would keep both and the text would come out
 * doubled. Axis-aligned, like `boxIou`.
 */
export function boxCoverage(inner: Box, outer: Box): number {
    const [ix0, iy0, ix1, iy1] = bbox(inner)
    const [ox0, oy0, ox1, oy1] = bbox(outer)

    const w = Math.min(ix1, ox1) - Math.max(ix0, ox0)
    const h = Math.min(iy1, oy1) - Math.max(iy0, oy0)
    if (w <= 0 || h <= 0) return 0

    const area = inner.width * inner.height
    return area <= 0 ? 0 : (w * h) / area
}

/**
 * Union of two boxes.
 *
 * `mergeOverlappingBoxes` only ever calls this on boxes `isOnSameLine` has
 * already agreed are within `angleThresh` of each other, so when either is
 * rotated the pair shares one real orientation — flattening to an axis-aligned
 * box here would silently discard it. `bbox()` reads `x`/`y`/`width`/`height`
 * as if they already were that axis-aligned box, which is only true at
 * `angle: 0`; for a rotated box those fields describe a same-size box centred
 * on the *rotated* rect (see the `Box` docstring), so unioning them directly
 * would union the wrong rectangles. Going through both boxes' true corners and
 * `minAreaRect` is what recovers the merged box's own angle instead.
 *
 * Falls back to the cheap axis-aligned union when neither box is rotated,
 * since `minAreaRect` over 8 collinear-ish corners is more work than the
 * question needs, and it is the overwhelmingly common case.
 */
export function mergeBoxes(a: Box, b: Box): Box {
    if (!isRotated(a) && !isRotated(b)) {
        const [ax0, ay0, ax1, ay1] = bbox(a)
        const [bx0, by0, bx1, by1] = bbox(b)
        const x = Math.min(ax0, bx0)
        const y = Math.min(ay0, by0)

        return {
            text: `${a.text} ${b.text}`.trim(),
            score: Math.min(a.score, b.score),
            x,
            y,
            width: Math.max(ax1, bx1) - x,
            height: Math.max(ay1, by1) - y,
            angle: 0,
        }
    }

    const corners = [...boxPoints(boxRect(a)), ...boxPoints(boxRect(b))]
    return {
        ...boxFromRect(minAreaRect(corners)),
        text: `${a.text} ${b.text}`.trim(),
        score: Math.min(a.score, b.score),
    }
}

/**
 * Whether two boxes sit on the same text line.
 *
 * For near-horizontal boxes this compares vertical centres against the average
 * height. For rotated boxes it projects the centre offset onto the line's normal
 * (dx = -sin, dy = cos), so the test follows the text's own baseline.
 */
export function isOnSameLine(a: Box, b: Box, angleThresh = 10, lineThresh = 0.5): boolean {
    if (Math.abs(a.angle - b.angle) > angleThresh) return false

    const avgHeight = (a.height + b.height) / 2
    if (avgHeight <= 0) return false

    const acx = a.x + a.width / 2
    const acy = a.y + a.height / 2
    const bcx = b.x + b.width / 2
    const bcy = b.y + b.height / 2

    // Python branches on the caller's `angleThresh`, not on the much smaller
    // rotation epsilon: a box a few degrees off is still treated as horizontal
    // here, and compared by raw vertical distance. Using the epsilon instead
    // sends slightly skewed boxes down the projection path, where a large
    // horizontal gap cancels most of the vertical one and unrelated lines start
    // reading as the same line.
    if (Math.abs(a.angle) < angleThresh) {
        return Math.abs(acy - bcy) < avgHeight * lineThresh
    }

    const rad = (a.angle * Math.PI) / 180
    const nx = -Math.sin(rad)
    const ny = Math.cos(rad)
    const distance = Math.abs((bcx - acx) * nx + (bcy - acy) * ny)
    return distance < avgHeight * lineThresh
}

/**
 * Greedily merge boxes that overlap and share a line. Port of Python
 * `Box.merge_overlapping_boxes`.
 *
 * Restarts the scan after each merge so a chain of boxes collapses fully in one
 * call, matching Python's behaviour.
 */
export function mergeOverlappingBoxes(
    boxes: readonly Box[],
    iouThreshold = 0.3,
    angleThresh = 10,
    lineThresh = 0.5
): Box[] {
    // One greedy pass, exactly as Python does it: each box either starts a
    // group or is absorbed into an earlier one, and a group that has been
    // emitted is never revisited. Iterating to a fixed point instead merges
    // transitively -- a chain of boxes that each overlap their neighbour
    // collapses into one -- which quietly turns detections into whole lines.
    const merged: Box[] = []
    const used = new Array<boolean>(boxes.length).fill(false)

    for (let i = 0; i < boxes.length; i++) {
        if (used[i]) continue
        let current = boxes[i] as Box

        // Compares against the *growing* box, so a group can still extend as it
        // absorbs -- but only forwards, never back into what is already emitted.
        for (let j = i + 1; j < boxes.length; j++) {
            if (used[j]) continue
            const other = boxes[j] as Box
            if (
                boxIou(current, other) > iouThreshold &&
                isOnSameLine(current, other, angleThresh, lineThresh)
            ) {
                current = mergeBoxes(current, other)
                used[j] = true
            }
        }
        merged.push(current)
        used[i] = true
    }
    return merged
}
