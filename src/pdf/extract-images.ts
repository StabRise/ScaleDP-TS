/**
 * The raster images a PDF page paints, at their own pixel size, and where they
 * sit on the page.
 *
 * A page's text layer covers only its *vector* text. Anything scanned or pasted
 * in as a bitmap -- an invoice table, an ID photo page, a receipt -- is invisible
 * to `getTextContent`. Reading it means finding those bitmaps, OCR-ing them, and
 * putting the results back in page coordinates.
 *
 * pdf.js exposes no "list the images" API, so the placements are recovered by
 * walking the page's operator list and tracking the transform the way the canvas
 * renderer does. Three things about that walk are not guessable from the docs and
 * were read off the pdf.js source (6.2.108) and checked against real files:
 *
 * 1. `paintInlineImageXObject` does `ctx.scale(1/width, -1/height)` and draws at
 *    `(0, -height, width, height)`. So an image pixel `(u, v)`, v measured from
 *    the image *top*, lands at `(u / width, 1 - v / height)` in the current
 *    transform's space -- the unit square, y flipped. Everything here is
 *    expressed in that unit square, which is also why the image's pixel size is
 *    not needed until the object has actually been decoded.
 * 2. `argsArray[i]` holds the raw operator arguments. The `opIdx` the renderer's
 *    methods take is injected at dispatch and is *not* in the array.
 * 3. `paintFormXObjectBegin` is a save plus a transform, and `paintFormXObjectEnd`
 *    is the matching restore. Missing them puts every image inside a form XObject
 *    -- which is most stamped content -- in the wrong place.
 * 4. `beginGroup` opens with a bare `save()` and takes the fast path out before
 *    `group.matrix` is ever applied; the worker emits a `paintFormXObjectBegin`
 *    carrying that matrix immediately afterwards. So a group is a save/restore
 *    pair and nothing more -- applying its matrix here would apply it twice.
 *    Skipping the pair entirely is not equivalent either: a transform inside the
 *    group would leak out of it.
 * 5. `beginAnnotation` *discards* the running transform -- it sets the base
 *    transform, then composes `transform` and `matrix` -- which is how a stamp or
 *    signature annotation is positioned. Images inside one are reachable, and
 *    common, because `PdfToImage` renders with annotations on.
 *
 * The matrix maths is hand-ported rather than taken from `pdfjs.Util`, so the
 * walk is a pure function that unit tests can drive with a stub operator list
 * and no pdf.js at all.
 */

import { boxPoints, type Point } from '../core/geometry.js'
import { context2d, createCanvas, resize } from '../core/image.js'
import type { Box } from '../schemas/box.js'
import { boxFromBBox, boxFromPolygon, ROTATION_EPSILON_DEGREES } from '../schemas/box.js'
import { POINTS_PER_INCH } from './pdf-to-image.js'
import { loadPdfjs } from './pdfjs.js'

/** An affine transform in pdf.js order: `[a, b, c, d, e, f]`. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/**
 * The operator codes this module needs, passed in rather than imported.
 *
 * `pdfjs.OPS` is a plain number map whose values are an implementation detail of
 * the version installed. Taking it as an argument keeps `collectImagePlacements`
 * pure and lets a unit test supply its own numbering.
 */
export interface ImageOpCodes {
    save: number
    restore: number
    transform: number
    paintFormXObjectBegin: number
    paintFormXObjectEnd: number
    beginGroup: number
    endGroup: number
    beginAnnotation: number
    endAnnotation: number
    paintImageXObject: number
    paintInlineImageXObject: number
    paintInlineImageXObjectGroup: number
    paintImageXObjectRepeat: number
}

/** Pick the codes this module uses out of a full `pdfjs.OPS`. */
export function imageOpCodes(ops: Record<string, number>): ImageOpCodes {
    return {
        save: ops.save as number,
        restore: ops.restore as number,
        transform: ops.transform as number,
        paintFormXObjectBegin: ops.paintFormXObjectBegin as number,
        paintFormXObjectEnd: ops.paintFormXObjectEnd as number,
        beginGroup: ops.beginGroup as number,
        endGroup: ops.endGroup as number,
        beginAnnotation: ops.beginAnnotation as number,
        endAnnotation: ops.endAnnotation as number,
        paintImageXObject: ops.paintImageXObject as number,
        paintInlineImageXObject: ops.paintInlineImageXObject as number,
        paintInlineImageXObjectGroup: ops.paintInlineImageXObjectGroup as number,
        paintImageXObjectRepeat: ops.paintImageXObjectRepeat as number,
    }
}

/**
 * `m1` after `m2` -- the same product `ctx.transform` applies, so composing in
 * this order reproduces the renderer's own transform stack exactly.
 */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]
}

export function applyMatrix(m: Matrix, x: number, y: number): Point {
    return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]
}

/** The part of an image a single paint draws, in the image's own pixels. */
export interface SubRect {
    x: number
    y: number
    width: number
    height: number
}

/** One image-painting operator, before its pixels have been decoded. */
export interface RawImagePlacement {
    /** pdf.js object id, e.g. `img_p0_3`. Empty for an inline image. */
    id: string
    /** Unit square -> page pixel, with the image's y already flipped. */
    unitMatrix: Matrix
    /**
     * The sub-rectangle this paint draws, or null for the whole image.
     *
     * Only grouped inline images set one. It is carried rather than ignored
     * because the unit square covers the *drawn* rectangle, not the source.
     */
    sub: SubRect | null
    /** The image itself, for `paintInlineImageXObject`, which carries its own. */
    inlineData?: unknown
}

interface OperatorList {
    fnArray: ArrayLike<number>
    argsArray: ArrayLike<unknown>
}

/**
 * Walk a page's operator list and return every raster image it paints.
 *
 * `viewportTransform` is `page.getViewport({ scale }).transform`, which folds in
 * the render scale and any page `/Rotate`. Composing it here means the results
 * come out in the same pixel space `PdfToImage` renders at.
 *
 * Image *masks* are deliberately skipped: they are 1bpp stencils used to tint a
 * shape, so they carry no readable pixels and OCR-ing one is pure cost.
 */
export function collectImagePlacements(
    operatorList: OperatorList,
    ops: ImageOpCodes,
    viewportTransform: readonly number[]
): RawImagePlacement[] {
    const base = viewportTransform as unknown as Matrix
    const found: RawImagePlacement[] = []
    const stack: Matrix[] = []
    let ctm: Matrix = IDENTITY

    /** Compose the running transform with the viewport's, for one image. */
    const place = (id: string, local: Matrix, sub: SubRect | null, inlineData?: unknown): void => {
        const entry: RawImagePlacement = {
            id,
            unitMatrix: multiplyMatrix(base, local),
            sub,
        }
        if (inlineData !== undefined) entry.inlineData = inlineData
        found.push(entry)
    }

    /** The `{ transform, x, y, w, h }` entries a grouped paint carries. */
    const placeGroup = (id: string, entries: unknown, inlineData?: unknown): void => {
        if (!Array.isArray(entries)) return
        for (const entry of entries as { transform: Matrix; x: number; y: number; w: number; h: number }[]) {
            if (!entry?.transform) continue
            place(
                id,
                multiplyMatrix(ctm, entry.transform),
                { x: entry.x, y: entry.y, width: entry.w, height: entry.h },
                inlineData
            )
        }
    }

    for (let i = 0; i < operatorList.fnArray.length; i++) {
        const fn = operatorList.fnArray[i]
        const args = operatorList.argsArray[i] as unknown[] | null

        if (fn === ops.save) {
            stack.push(ctm)
        } else if (fn === ops.restore) {
            ctm = stack.pop() ?? IDENTITY
        } else if (fn === ops.transform) {
            ctm = multiplyMatrix(ctm, args as unknown as Matrix)
        } else if (fn === ops.paintFormXObjectBegin) {
            // save + transform, exactly as the renderer does it.
            stack.push(ctm)
            const matrix = args?.[0] as Matrix | null | undefined
            if (matrix) ctm = multiplyMatrix(ctm, matrix)
        } else if (fn === ops.paintFormXObjectEnd) {
            ctm = stack.pop() ?? IDENTITY
        } else if (fn === ops.beginGroup) {
            // A bare save. The group's own matrix arrives as the very next
            // paintFormXObjectBegin, so applying it here would double it.
            stack.push(ctm)
        } else if (fn === ops.endGroup) {
            ctm = stack.pop() ?? IDENTITY
        } else if (fn === ops.beginAnnotation) {
            // beginAnnotation(id, rect, transform, matrix, ...): the running
            // transform is discarded for the page's base, not composed onto.
            stack.push(ctm)
            const [, , annotTransform, annotMatrix] = (args ?? []) as [unknown, unknown, Matrix, Matrix]
            ctm = IDENTITY
            if (annotTransform) ctm = multiplyMatrix(ctm, annotTransform)
            if (annotMatrix) ctm = multiplyMatrix(ctm, annotMatrix)
        } else if (fn === ops.endAnnotation) {
            ctm = stack.pop() ?? IDENTITY
        } else if (fn === ops.paintImageXObject) {
            place(String(args?.[0] ?? ''), ctm, null)
        } else if (fn === ops.paintInlineImageXObject) {
            place('', ctm, null, args?.[0])
        } else if (fn === ops.paintInlineImageXObjectGroup) {
            placeGroup('', args?.[1], args?.[0])
        } else if (fn === ops.paintImageXObjectRepeat) {
            // One tile per position. Every tile draws the whole image, so there
            // is no sub-rectangle -- only the placement differs.
            const [id, scaleX, scaleY, positions] = (args ?? []) as [string, number, number, number[]]
            for (let p = 0; p + 1 < (positions?.length ?? 0); p += 2) {
                const tile: Matrix = [
                    scaleX,
                    0,
                    0,
                    scaleY,
                    positions[p] as number,
                    positions[p + 1] as number,
                ]
                place(String(id), multiplyMatrix(ctm, tile), null)
            }
        }
    }
    return found
}

/**
 * Where an embedded image sits on the page, and how to map into and out of it.
 *
 * `matrix` maps an image pixel straight to a page pixel, so it survives
 * `structuredClone` across the worker boundary where a closure would not. Build
 * the function form with `placementMap`; `box` is derived from the same matrix,
 * which is what stops the forward and inverse mappings drifting apart -- the
 * same discipline `cropGeometry` follows in `src/core/image.ts`.
 */
export interface ImagePlacement {
    /** pdf.js object id, e.g. `img_p0_3`. Empty for an inline image. */
    id: string
    /** Native pixel size of the decoded image. */
    width: number
    height: number
    /** Axis-aligned placement on the page, in render pixels. */
    box: Box
    /** Image pixel -> page pixel. */
    matrix: Matrix
    /**
     * DPI of the image as placed, which is not the page's render DPI. An image
     * 1524px wide spread over 6.6in of page is 231 DPI however finely the page
     * itself is rendered.
     */
    effectiveResolution: number
    /** Factor the pixels were upscaled by before OCR; 1 when untouched. */
    scaleFactor: number
}

/** Image pixel -> page pixel, rebuilt from the cloneable matrix. */
export function placementMap(placement: ImagePlacement): (u: number, v: number) => Point {
    const { matrix, scaleFactor } = placement
    return (u, v) => applyMatrix(matrix, u / scaleFactor, v / scaleFactor)
}

/**
 * Turn a raw placement into a full one, now that the pixel size is known.
 *
 * The unit square's y is flipped relative to the image's, so the composed
 * matrix sends `(u, v)` to `(u / width, 1 - v / height)` before the page
 * transform -- see the note at the top of this file.
 */
export function toImagePlacement(
    raw: RawImagePlacement,
    width: number,
    height: number,
    resolution: number,
    scaleFactor = 1
): ImagePlacement {
    // The unit square covers whatever the operator actually drew. For a
    // sub-rectangle that is not the whole source, so the caller hands on the
    // cropped pixels and the matrix is expressed in the crop's own coordinates.
    const sub = raw.sub ?? { x: 0, y: 0, width, height }
    const drawnWidth = Math.max(1, sub.width)
    const drawnHeight = Math.max(1, sub.height)

    const pixelToUnit: Matrix = [1 / drawnWidth, 0, 0, -1 / drawnHeight, 0, 1]
    const matrix = multiplyMatrix(raw.unitMatrix, pixelToUnit)

    const corners: Point[] = [
        applyMatrix(matrix, 0, 0),
        applyMatrix(matrix, drawnWidth, 0),
        applyMatrix(matrix, drawnWidth, drawnHeight),
        applyMatrix(matrix, 0, drawnHeight),
    ]
    const box = boxFromCorners(corners)

    // Measure the placed width along the image's own top edge rather than the
    // axis-aligned box, so a rotated placement reports its real scale.
    const [x0, y0] = corners[0] as Point
    const [x1, y1] = corners[1] as Point
    const placedWidth = Math.hypot(x1 - x0, y1 - y0)
    const placedInches = placedWidth / resolution

    return {
        id: raw.id,
        width: drawnWidth,
        height: drawnHeight,
        box,
        matrix,
        effectiveResolution: placedInches > 0 ? drawnWidth / placedInches : 0,
        scaleFactor,
    }
}

/**
 * An axis-aligned `Box` for a placement whose corners are axis-aligned, and a
 * rotated one otherwise.
 *
 * `boxFromPolygon` runs `minAreaRect`, which forces `width` to be the longer
 * side and would report a wide, short banner as a 90-degree-rotated tall one.
 * `spanBox` in `src/ocr/paddle-words.ts` sidesteps it for the same reason.
 */
function boxFromCorners(corners: readonly Point[]): Box {
    const xs = corners.map((p) => p[0])
    const ys = corners.map((p) => p[1])
    const bbox: [number, number, number, number] = [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
    ]

    const [x0, y0] = corners[0] as Point
    const [x1, y1] = corners[1] as Point
    const skew = Math.abs((Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI)
    const aligned = Math.min(skew, Math.abs(skew - 180)) < ROTATION_EPSILON_DEGREES
    if (aligned) return boxFromBBox(bbox)

    return boxFromPolygon(corners.slice(0, 4))
}

/**
 * Map a box out of an image's pixels and onto the page.
 *
 * The corners come from `boxPoints`, not from `x, y, width, height`. A `Box` is
 * a *rotated* rect -- `x`/`y` is the top-left of the axis-aligned box of the same
 * size centred on it, and `angle` turns it about that centre -- so reading the
 * four fields as a rectangle silently discards the rotation, and every word a
 * recognizer read on the slant comes back level. The same reasoning is spelled
 * out in `spanBox` (`src/ocr/paddle-words.ts`), which maps back the same way.
 */
export function boxToPage(box: Box, placement: ImagePlacement): Box {
    const map = placementMap(placement)
    const width = Math.max(1, box.width)
    const height = Math.max(1, box.height)
    const centre: Point = [box.x + width / 2, box.y + height / 2]

    // cv2.boxPoints order is BL, TL, TR, BR.
    const [bl, tl, tr, br] = boxPoints({ center: centre, size: [width, height], angle: box.angle })
    const corners = [tl, tr, br, bl].map(([x, y]) => map(x, y))

    return { ...boxFromCorners(corners), text: box.text, score: box.score }
}

/* ── Decoding ──────────────────────────────────────────────────────────── */

/** pdf.js `ImageKind`. Inlined rather than imported: three stable constants. */
const GRAYSCALE_1BPP = 1
const RGB_24BPP = 2
const RGBA_32BPP = 3

interface BitmapImageData {
    bitmap: ImageBitmap
    width: number
    height: number
}

interface BinaryImageData {
    data: Uint8ClampedArray | Uint8Array
    width: number
    height: number
    kind: number
}

/**
 * Copy pdf.js image data into a canvas we own, on a white ground.
 *
 * The copy is not optional. `page.cleanup()` calls `objs.clear()`, which closes
 * every `ImageBitmap` it handed out, so holding pdf.js's own object past the end
 * of the page leaves a detached bitmap.
 *
 * Neither is the white. PDF images routinely carry an alpha channel and are
 * *painted onto the page* -- a text overlay is stored as opaque glyphs on a
 * fully transparent ground with its RGB left at zero. Lift one out on its own
 * and the transparency is gone: a recognizer sees black ink on black paper and
 * reads nothing at all, while a detector still finds the regions, which makes
 * the failure look like a recognition problem rather than a compositing one.
 * The page behind is white, so that is the ground restored here.
 *
 * Two shapes arrive in practice: `{ bitmap }` where `createImageBitmap` is
 * available, and raw `{ data, kind }` otherwise -- Node returns the latter even
 * for ordinary photographs, so both paths are load-bearing.
 */
export function imageDataToOwnedCanvas(imgData: unknown): OffscreenCanvas {
    if (typeof imgData !== 'object' || imgData === null) {
        throw new TypeError('Expected pdf.js image data')
    }

    const withBitmap = imgData as Partial<BitmapImageData>
    if (withBitmap.bitmap) {
        const canvas = createCanvas(withBitmap.bitmap.width, withBitmap.bitmap.height)
        const ctx = context2d(canvas)
        // drawImage composites, so filling first is all the white ground needs.
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(withBitmap.bitmap, 0, 0)
        return canvas
    }

    const binary = imgData as Partial<BinaryImageData>
    if (!binary.data || !binary.width || !binary.height) {
        throw new TypeError('pdf.js image data carried neither a bitmap nor pixels')
    }

    const canvas = createCanvas(binary.width, binary.height)
    // putImageData *replaces* pixels rather than compositing them, alpha
    // included, so the white has to be mixed into the array instead.
    const rgba = toRgba(binary as BinaryImageData)
    context2d(canvas).putImageData(new ImageData(rgba, binary.width, binary.height), 0, 0)
    return canvas
}

/**
 * Expand any `ImageKind` into opaque RGBA over white.
 *
 * Always a fresh buffer, never a view over pdf.js's: the source may be backed by
 * a `SharedArrayBuffer` under cross-origin isolation, which `ImageData` refuses.
 *
 * Only `RGBA_32BPP` can carry transparency; the other two kinds are opaque by
 * definition, so their alpha is simply set.
 */
function toRgba(image: BinaryImageData): Uint8ClampedArray<ArrayBuffer> {
    const { data, width, height, kind } = image
    const pixels = width * height
    const out = new Uint8ClampedArray(new ArrayBuffer(pixels * 4))

    if (kind === RGBA_32BPP) {
        // Source-over white, done on the array because putImageData will not
        // composite. A fully transparent pixel becomes white, not black.
        for (let i = 0; i < pixels; i++) {
            const at = i * 4
            const alpha = (data[at + 3] as number) / 255
            const ground = 255 * (1 - alpha)
            out[at] = (data[at] as number) * alpha + ground
            out[at + 1] = (data[at + 1] as number) * alpha + ground
            out[at + 2] = (data[at + 2] as number) * alpha + ground
            out[at + 3] = 255
        }
        return out
    }

    if (kind === RGB_24BPP) {
        for (let i = 0; i < pixels; i++) {
            out[i * 4] = data[i * 3] as number
            out[i * 4 + 1] = data[i * 3 + 1] as number
            out[i * 4 + 2] = data[i * 3 + 2] as number
            out[i * 4 + 3] = 255
        }
        return out
    }

    if (kind === GRAYSCALE_1BPP) {
        // Rows are byte-aligned and bits run most-significant first; a set bit
        // is white. Matches pdf.js's own convertBlackAndWhiteToRGBA.
        const bytesPerRow = (width + 7) >> 3
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const byte = data[y * bytesPerRow + (x >> 3)] ?? 255
                const value = (byte >> (7 - (x & 7))) & 1 ? 255 : 0
                const at = (y * width + x) * 4
                out[at] = value
                out[at + 1] = value
                out[at + 2] = value
                out[at + 3] = 255
            }
        }
        return out
    }

    throw new TypeError(`Unsupported pdf.js ImageKind ${kind}`)
}

/** Native pixel size of pdf.js image data, whichever shape it arrived in. */
export function imageDataSize(imgData: unknown): { width: number; height: number } {
    const image = imgData as Partial<BitmapImageData & BinaryImageData> | null
    const width = image?.bitmap?.width ?? image?.width ?? 0
    const height = image?.bitmap?.height ?? image?.height ?? 0
    return { width, height }
}

/** DPI an image is placed at, given its pixel width and its width in points. */
export function effectiveResolution(pixelWidth: number, widthInPoints: number): number {
    return widthInPoints > 0 ? (pixelWidth * POINTS_PER_INCH) / widthInPoints : 0
}

/* ── Extraction ────────────────────────────────────────────────────────── */

export interface ExtractImagesOptions {
    /** Pixel space the placement boxes come out in. Match `PdfToImage`. */
    resolution: number
    /** Ignore images with fewer than this many native pixels. */
    minPixels?: number
    /** Most images to return, largest placement first; 0 returns all. */
    limit?: number
    /** Upscale an image placed below this DPI before it is read. 0 disables. */
    minEffectiveResolution?: number
    /** How long to wait for pdf.js to decode one image object. */
    objectTimeoutMs?: number
    signal?: AbortSignal
}

/** A decoded embedded image, at its own pixel size, and where it sits. */
export interface EmbeddedImage {
    placement: ImagePlacement
    /** Native-resolution pixels we own, safe to use after `page.cleanup()`. */
    canvas: OffscreenCanvas
}

/** Nothing sensible can come of upscaling a thumbnail into a poster. */
const MAX_UPSCALE = 4

interface PageLike {
    getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>
    objs: ObjectStore
    commonObjs: ObjectStore
}

interface ObjectStore {
    has(objId: string): boolean
    get(objId: string, callback?: (data: unknown) => void): unknown
}

/**
 * Resolve a pdf.js object id, without throwing and without hanging.
 *
 * The bare `get(objId)` *throws* when the worker has not sent the object yet,
 * and right after `getOperatorList()` that is the normal state -- every image in
 * every sample PDF here came back unresolved on the synchronous path. The
 * callback form is the only non-throwing wait, and it never settles if the
 * object is one the worker decided not to send, hence the timeout.
 */
export function awaitObject(page: PageLike, objId: string, timeoutMs: number): Promise<unknown> {
    // pdf.js's own rule: a `g_` prefix means the object is shared between pages.
    const store = objId.startsWith('g_') ? page.commonObjs : page.objs
    if (store.has(objId)) return Promise.resolve(store.get(objId))

    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs)
        store.get(objId, (data) => {
            clearTimeout(timer)
            resolve(data)
        })
    })
}

/**
 * Every raster image a page paints, decoded and placed.
 *
 * Must be called before `page.cleanup()`, which closes the bitmaps pdf.js
 * handed out. The canvases returned here are copies, so they outlive it.
 */
export async function extractEmbeddedImages(
    page: PageLike,
    viewport: { transform: number[] },
    options: ExtractImagesOptions
): Promise<EmbeddedImage[]> {
    const {
        resolution,
        minPixels = 0,
        limit = 0,
        minEffectiveResolution = 0,
        objectTimeoutMs = 10_000,
        signal,
    } = options

    const pdfjs = await loadPdfjs()
    const ops = imageOpCodes(pdfjs.OPS as unknown as Record<string, number>)
    const raws = collectImagePlacements(await page.getOperatorList(), ops, viewport.transform)

    // One decode per object however many times the page paints it -- a repeated
    // logo is one image and forty placements.
    const decoded = new Map<string, OffscreenCanvas>()
    const found: EmbeddedImage[] = []

    for (const raw of raws) {
        signal?.throwIfAborted()

        const imgData = raw.inlineData ?? (raw.id ? await awaitObject(page, raw.id, objectTimeoutMs) : null)
        if (!imgData) continue

        const { width, height } = imageDataSize(imgData)
        if (width < 1 || height < 1) continue
        if (width * height < minPixels) continue

        let source = raw.id ? decoded.get(raw.id) : undefined
        if (!source) {
            source = imageDataToOwnedCanvas(imgData)
            if (raw.id) decoded.set(raw.id, source)
        }

        const placement = toImagePlacement(raw, width, height, resolution)
        // The operator may paint only part of the source; from here on the crop
        // *is* the image, which is the coordinate space `matrix` speaks in.
        let canvas = raw.sub ? cropSub(source, raw.sub) : source

        const factor = upscaleFactor(placement.effectiveResolution, minEffectiveResolution)
        if (factor > 1) canvas = resize(canvas, factor)

        found.push({
            placement: factor > 1 ? { ...placement, scaleFactor: factor } : placement,
            canvas,
        })
    }

    if (limit <= 0 || found.length <= limit) return found

    // Biggest first: on a page of many images the large one is the document.
    return [...found]
        .sort(
            (a, b) =>
                b.placement.box.width * b.placement.box.height -
                a.placement.box.width * a.placement.box.height
        )
        .slice(0, limit)
}

/** How much to enlarge an image placed below the DPI a recognizer wants. */
export function upscaleFactor(effective: number, minimum: number): number {
    if (minimum <= 0 || effective <= 0 || effective >= minimum) return 1
    return Math.min(MAX_UPSCALE, minimum / effective)
}

function cropSub(source: OffscreenCanvas, sub: SubRect): OffscreenCanvas {
    const canvas = createCanvas(Math.max(1, sub.width), Math.max(1, sub.height))
    context2d(canvas).drawImage(source, -sub.x, -sub.y)
    return canvas
}
