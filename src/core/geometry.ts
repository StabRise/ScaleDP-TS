/**
 * OpenCV-compatible planar geometry, hand-ported so the browser build needs no
 * opencv.js. Conventions match cv2 exactly — `Box.from_polygon` and the DBNet
 * post-processor both depend on that, and a divergence here shifts every box.
 */

export type Point = [number, number]

export interface RotatedRect {
    /** Centre of the rectangle. */
    center: Point
    /** Side lengths along the rect's own axes. */
    size: [number, number]
    /**
     * Degrees in (0, 90], with `size[0]` (the width) lying along that direction.
     *
     * Verified against cv2 4.11 across 18 orientations. One caveat: for a
     * perfectly axis-aligned rect cv2 itself is inconsistent, returning either
     * `-0.0` or `90` depending on which hull edge its scan lands on. Those two
     * describe the same rectangle (a rectangle is invariant under a 180-degree
     * rotation once the sides are swapped), so we always report the `90` form.
     * Nothing downstream can distinguish them -- ImageDrawBoxes renders angle
     * and angle+180 identically.
     */
    angle: number
}

const EPSILON = 1e-9

/** Cross product of (o->a) and (o->b). > 0 means counter-clockwise. */
function cross(o: Point, a: Point, b: Point): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/**
 * Monotone-chain convex hull. Returns hull points counter-clockwise in a
 * y-down image coordinate system, without the duplicated closing point.
 */
export function convexHull(points: readonly Point[]): Point[] {
    const pts = [...points].sort((p, q) => (p[0] === q[0] ? p[1] - q[1] : p[0] - q[0]))
    // Drop exact duplicates; collinear runs are handled by the cross-product test.
    const uniq: Point[] = []
    for (const p of pts) {
        const last = uniq[uniq.length - 1]
        if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p)
    }
    if (uniq.length < 3) return uniq

    const build = (source: Point[]): Point[] => {
        const chain: Point[] = []
        for (const p of source) {
            while (
                chain.length >= 2 &&
                cross(chain[chain.length - 2] as Point, chain[chain.length - 1] as Point, p) <= 0
            ) {
                chain.pop()
            }
            chain.push(p)
        }
        chain.pop()
        return chain
    }
    return [...build(uniq), ...build([...uniq].reverse())]
}

/**
 * Minimum-area enclosing rectangle via rotating calipers.
 *
 * The minimum-area rectangle always has a side flush with a convex-hull edge,
 * so testing one orientation per hull edge is exhaustive.
 */
export function minAreaRect(points: readonly Point[]): RotatedRect {
    if (points.length === 0) return { center: [0, 0], size: [0, 0], angle: 0 }

    const hull = convexHull(points)
    if (hull.length < 2) {
        const p = (hull[0] ?? points[0]) as Point
        return { center: [p[0], p[1]], size: [0, 0], angle: 0 }
    }

    let best: { area: number; center: Point; w: number; h: number; angle: number } | null = null

    for (let i = 0; i < hull.length; i++) {
        const a = hull[i] as Point
        const b = hull[(i + 1) % hull.length] as Point
        const len = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (len < EPSILON) continue

        // Orthonormal frame with u along this hull edge.
        const ux = (b[0] - a[0]) / len
        const uy = (b[1] - a[1]) / len
        const vx = -uy
        const vy = ux

        let minU = Infinity
        let maxU = -Infinity
        let minV = Infinity
        let maxV = -Infinity
        for (const p of hull) {
            const pu = p[0] * ux + p[1] * uy
            const pv = p[0] * vx + p[1] * vy
            if (pu < minU) minU = pu
            if (pu > maxU) maxU = pu
            if (pv < minV) minV = pv
            if (pv > maxV) maxV = pv
        }

        const w = maxU - minU
        const h = maxV - minV
        const area = w * h
        if (best === null || area < best.area) {
            const cu = (minU + maxU) / 2
            const cv = (minV + maxV) / 2
            best = {
                area,
                center: [cu * ux + cv * vx, cu * uy + cv * vy],
                w,
                h,
                angle: (Math.atan2(uy, ux) * 180) / Math.PI,
            }
        }
    }

    if (best === null) return { center: [0, 0], size: [0, 0], angle: 0 }

    // cv2 reports the angle in (0, 90] -- half-open at zero, so a perfectly
    // axis-aligned rect is reported as 90 degrees with the sides swapped rather
    // than as 0. Each 90 degrees folded away swaps which side is "width",
    // because the frame's u and v axes trade places.
    let { angle, w, h } = best
    while (angle <= 0) {
        angle += 90
        ;[w, h] = [h, w]
    }
    while (angle > 90) {
        angle -= 90
        ;[w, h] = [h, w]
    }

    return { center: best.center, size: [w, h], angle }
}

/**
 * The 4 corners of a rotated rect, in cv2.boxPoints order.
 * For an upright rect in image coordinates that is: BL, TL, TR, BR.
 */
export function boxPoints(rect: RotatedRect): [Point, Point, Point, Point] {
    const [cx, cy] = rect.center
    const [w, h] = rect.size
    const rad = (rect.angle * Math.PI) / 180
    const b = Math.cos(rad) * 0.5
    const a = Math.sin(rad) * 0.5

    const p0: Point = [cx - a * h - b * w, cy + b * h - a * w]
    const p1: Point = [cx + a * h - b * w, cy - b * h - a * w]
    const p2: Point = [2 * cx - p0[0], 2 * cy - p0[1]]
    const p3: Point = [2 * cx - p1[0], 2 * cy - p1[1]]
    return [p0, p1, p2, p3]
}

/** Shoelace area of a simple polygon; always non-negative. */
export function polygonArea(points: readonly Point[]): number {
    let sum = 0
    for (let i = 0; i < points.length; i++) {
        const a = points[i] as Point
        const b = points[(i + 1) % points.length] as Point
        sum += a[0] * b[1] - b[0] * a[1]
    }
    return Math.abs(sum) / 2
}

/** Perimeter of a closed polygon. */
export function polygonPerimeter(points: readonly Point[]): number {
    let sum = 0
    for (let i = 0; i < points.length; i++) {
        const a = points[i] as Point
        const b = points[(i + 1) % points.length] as Point
        sum += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    return sum
}
