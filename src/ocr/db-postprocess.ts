/**
 * Differentiable Binarization post-processing.
 *
 * Port of `scaledp/models/detectors/paddle_onnx/db_postprocess.py`. Takes the
 * model's probability map and turns it into text quads, with the same
 * thresholds, ordering and filtering as Python so box output matches.
 */

import { boxPoints, minAreaRect, type Point, polygonArea, polygonPerimeter } from '../core/geometry.js'

export interface DbPostProcessOptions {
    /** Probability above which a pixel counts as text. */
    thresh: number
    /** Mean in-box probability a candidate must reach to survive. */
    boxThresh: number
    /** Cap on contours considered, guarding against pathological maps. */
    maxCandidates: number
    /** How far to grow each box; DB shrinks regions during training. */
    unclipRatio: number
    /** Minimum short side, in model pixels. */
    minSize: number
}

/**
 * ScaleDP's own values, from `predict_det.py`. Note `boxThresh` is 0.3 there
 * and the stage-level `scoreThreshold` never reaches this code -- a Python bug
 * that is not reproduced: here `boxThresh` is what the stage actually sets.
 */
export const DB_POSTPROCESS_DEFAULTS: DbPostProcessOptions = Object.freeze({
    thresh: 0.5,
    boxThresh: 0.3,
    maxCandidates: 1000,
    unclipRatio: 2.5,
    minSize: 3,
})

export interface ProbabilityMap {
    data: Float32Array
    width: number
    height: number
}

export interface DetectedQuad {
    /** Four corners, ordered top-left, top-right, bottom-right, bottom-left. */
    points: [Point, Point, Point, Point]
    score: number
}

/**
 * Boundary pixels of each 8-connected foreground component.
 *
 * cv2.findContours traces outlines; we collect boundary pixels instead. For the
 * only consumers here -- minAreaRect and its convex hull -- the two are
 * equivalent, and this avoids porting Suzuki-Abe border following.
 */
export function findComponentBoundaries(
    map: ProbabilityMap,
    thresh: number,
    maxCandidates: number
): Point[][] {
    const { data, width, height } = map
    const visited = new Uint8Array(width * height)
    const components: Point[][] = []

    const isForeground = (x: number, y: number): boolean =>
        x >= 0 && y >= 0 && x < width && y < height && (data[y * width + x] as number) > thresh

    const stack: number[] = []
    for (let start = 0; start < visited.length && components.length < maxCandidates; start++) {
        if (visited[start] || !((data[start] as number) > thresh)) continue

        const boundary: Point[] = []
        stack.length = 0
        stack.push(start)
        visited[start] = 1

        while (stack.length > 0) {
            const index = stack.pop() as number
            const x = index % width
            const y = (index - x) / width

            let onBoundary = false
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue
                    const nx = x + dx
                    const ny = y + dy
                    if (!isForeground(nx, ny)) {
                        onBoundary = true
                        continue
                    }
                    const neighbour = ny * width + nx
                    if (!visited[neighbour]) {
                        visited[neighbour] = 1
                        stack.push(neighbour)
                    }
                }
            }
            if (onBoundary) boundary.push([x, y])
        }
        if (boundary.length >= 3) components.push(boundary)
    }
    return components
}

/**
 * Corners of the minimum-area rect, ordered top-left, top-right, bottom-right,
 * bottom-left, together with the rect's shorter side.
 *
 * Port of `get_mini_boxes`: sort the four corners by x, then decide within each
 * pair which is the upper one.
 */
export function miniBox(points: readonly Point[]): { points: [Point, Point, Point, Point]; sside: number } {
    const rect = minAreaRect(points)
    const corners = [...boxPoints(rect)].sort((a, b) => a[0] - b[0])

    const [p0, p1, p2, p3] = corners as [Point, Point, Point, Point]
    const [topLeft, bottomLeft] = p0[1] <= p1[1] ? [p0, p1] : [p1, p0]
    const [topRight, bottomRight] = p2[1] <= p3[1] ? [p2, p3] : [p3, p2]

    return {
        points: [topLeft, topRight, bottomRight, bottomLeft],
        sside: Math.min(rect.size[0], rect.size[1]),
    }
}

/**
 * Mean probability inside a quad -- port of `box_score_fast`.
 *
 * Python builds an integer mask with `cv2.fillPoly` and averages the
 * probability map under it, so this reproduces OpenCV's fill convention:
 * vertices are truncated to integers and treated as pixel *centres*, scanlines
 * run at integer y, and both ends of each span are inclusive. Sampling at
 * pixel centres instead (the more usual rasterisation rule) drops the boundary
 * row and column, which shifts the score by around 1% and changes which
 * candidates clear `boxThresh`.
 */
export function boxScore(map: ProbabilityMap, points: readonly Point[]): number {
    const { data, width, height } = map
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])

    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max)
    const xmin = clamp(Math.floor(Math.min(...xs)), width - 1)
    const xmax = clamp(Math.ceil(Math.max(...xs)), width - 1)
    const ymin = clamp(Math.floor(Math.min(...ys)), height - 1)
    const ymax = clamp(Math.ceil(Math.max(...ys)), height - 1)
    if (xmax < xmin || ymax < ymin) return 0

    // Translate into mask space and truncate, matching numpy's astype(int32).
    const local = points.map(([x, y]) => [Math.trunc(x - xmin), Math.trunc(y - ymin)] as Point)
    const maskWidth = xmax - xmin
    const maskHeight = ymax - ymin

    let sum = 0
    let count = 0
    for (let y = 0; y <= maskHeight; y++) {
        let left = Number.POSITIVE_INFINITY
        let right = Number.NEGATIVE_INFINITY

        for (let i = 0; i < local.length; i++) {
            const a = local[i] as Point
            const b = local[(i + 1) % local.length] as Point
            if (a[1] === b[1]) {
                // A horizontal edge contributes both endpoints on its own row.
                if (a[1] !== y) continue
                left = Math.min(left, a[0], b[0])
                right = Math.max(right, a[0], b[0])
                continue
            }
            if (y < Math.min(a[1], b[1]) || y > Math.max(a[1], b[1])) continue
            const x = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
            left = Math.min(left, x)
            right = Math.max(right, x)
        }
        if (left > right) continue

        // The quads here are always convex, so the span between the extreme
        // crossings is exactly the covered run.
        const from = Math.max(0, Math.ceil(left))
        const to = Math.min(maskWidth, Math.floor(right))
        const rowOffset = (y + ymin) * width + xmin
        for (let x = from; x <= to; x++) {
            sum += data[rowOffset + x] as number
            count++
        }
    }
    return count === 0 ? 0 : sum / count
}

/**
 * Grow a detected rect outward -- port of `unclip`.
 *
 * Python offsets the polygon with a Clipper round join and then takes the
 * minimum-area rect of the result. For a rectangle those two steps compose
 * exactly: offsetting outward by `d` produces a rounded rectangle whose
 * min-area rect is the original grown by `d` on each of the four sides. That
 * identity is what lets this avoid a Clipper dependency entirely.
 */
export function unclipRect(points: readonly Point[], unclipRatio: number): [Point, Point, Point, Point] {
    const rect = minAreaRect(points)
    const perimeter = polygonPerimeter(points)
    const distance = perimeter === 0 ? 0 : (polygonArea(points) * unclipRatio) / perimeter

    return boxPoints({
        center: rect.center,
        size: [rect.size[0] + distance * 2, rect.size[1] + distance * 2],
        angle: rect.angle,
    })
}

/**
 * Reorder four points clockwise from the top-left -- port of
 * `order_points_clockwise`. Top-left has the smallest x+y, bottom-right the
 * largest; the remaining two are separated by y-x.
 */
export function orderPointsClockwise(points: readonly Point[]): [Point, Point, Point, Point] {
    const bySum = [...points].sort((a, b) => a[0] + a[1] - (b[0] + b[1]))
    const topLeft = bySum[0] as Point
    const bottomRight = bySum[bySum.length - 1] as Point

    const rest = bySum.slice(1, -1).sort((a, b) => a[1] - a[0] - (b[1] - b[0]))
    return [topLeft, rest[0] as Point, bottomRight, rest[1] as Point]
}

/**
 * Probability map -> text quads in source-image coordinates.
 *
 * `scale` is the uniform factor the source was resized by. Coordinates restore
 * by *dividing* by it, with no offset to subtract, because the letterbox pads
 * bottom and right only.
 */
export function quadsFromProbabilityMap(
    map: ProbabilityMap,
    source: { width: number; height: number },
    scale: number,
    options: Partial<DbPostProcessOptions> = {}
): DetectedQuad[] {
    const opts = { ...DB_POSTPROCESS_DEFAULTS, ...options }
    const quads: DetectedQuad[] = []

    for (const boundary of findComponentBoundaries(map, opts.thresh, opts.maxCandidates)) {
        const candidate = miniBox(boundary)
        if (candidate.sside < opts.minSize) continue

        const score = boxScore(map, candidate.points)
        if (score < opts.boxThresh) continue

        const expanded = miniBox(unclipRect(candidate.points, opts.unclipRatio))
        // Python's second gate is `min_size + 2`, i.e. tighter than the first --
        // unclipping can only grow a box, so anything still tiny is noise.
        if (expanded.sside < opts.minSize + 2) continue

        // Python clips to [0, dest], inclusive of the far edge -- not [0, dest-1].
        const restored = expanded.points.map(
            ([x, y]) =>
                [
                    Math.min(Math.max(Math.round(x / scale), 0), source.width),
                    Math.min(Math.max(Math.round(y / scale), 0), source.height),
                ] as Point
        )

        const ordered = orderPointsClockwise(restored)
        // Drop slivers: Python filters boxes whose sides are 3px or less.
        const width = Math.hypot(ordered[0][0] - ordered[1][0], ordered[0][1] - ordered[1][1])
        const height = Math.hypot(ordered[0][0] - ordered[3][0], ordered[0][1] - ordered[3][1])
        if (width <= 3 || height <= 3) continue

        quads.push({ points: ordered, score })
    }
    return quads
}
