/**
 * Word-level text extraction from a PDF's embedded text layer.
 *
 * Ported from the pdftools prototype's `extractTextFromPage`, whose rotation
 * handling is the hard-won part and is reproduced here with its reasoning.
 *
 * A pdf.js text item carries a full transform matrix [a, b, c, d, e, f]. Naively
 * reading `a` as a width scale breaks on rotated text, so the reading direction
 * and the "up" direction are recovered as *unit* vectors -- otherwise the font
 * size gets counted twice. The four corners are then pushed through
 * `convertToViewportPoint` and reduced to an axis-aligned box.
 *
 * No semantic `angle` is emitted, deliberately. A rotated glyph matrix is
 * indistinguishable from page-level /Rotate compensation or an embedded
 * FontMatrix, so composing the corners geometrically and taking their bounding
 * box is correct regardless of which caused it. `readDirX`/`readDirY` carry the
 * direction that word-splitting needs.
 */

import type { Box } from '../schemas/box.js'

/** A box plus the reading direction, which splitting needs but ScaleDP's Box lacks. */
export interface TextBox extends Box {
    /** Unit vector, in viewport space, along which reading progresses. */
    readDirX: number
    readDirY: number
    /** pdf.js font identifier, e.g. 'g_d0_f1'. */
    fontName: string
}

/** Glyphs sit above the baseline by roughly three quarters of the line height. */
const ASCENT_RATIO = 0.75

/** Confidence assigned to text read from a PDF's own text layer. */
export const TEXT_LAYER_SCORE = 0.99

interface TextItemLike {
    str: string
    transform: number[]
    width: number
    height: number
    fontName?: string
}

interface ViewportLike {
    convertToViewportPoint(x: number, y: number): number[]
}

export function isTextItem(item: unknown): item is TextItemLike {
    return (
        typeof item === 'object' &&
        item !== null &&
        'str' in item &&
        'transform' in item &&
        Array.isArray((item as TextItemLike).transform)
    )
}

/** Convert one pdf.js text item into a viewport-space box. */
export function textItemToBox(item: TextItemLike, viewport: ViewportLike): TextBox | null {
    if (item.str.length === 0) return null

    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform

    // Unit direction vectors. Dividing out the magnitudes is what stops the
    // font size being applied twice, since item.width/height already include it.
    const abMag = Math.hypot(a, b) || 1
    const cdMag = Math.hypot(c, d) || 1
    const dirX = a / abMag
    const dirY = b / abMag
    const upX = c / cdMag
    const upY = d / cdMag

    // The transform's origin is the baseline; shift up to the glyph tops.
    const ascent = item.height * ASCENT_RATIO
    const startX = e + upX * ascent
    const startY = f + upY * ascent

    const corners = [
        viewport.convertToViewportPoint(startX, startY),
        viewport.convertToViewportPoint(startX + dirX * item.width, startY + dirY * item.width),
        viewport.convertToViewportPoint(startX - upX * item.height, startY - upY * item.height),
        viewport.convertToViewportPoint(
            startX + dirX * item.width - upX * item.height,
            startY + dirY * item.width - upY * item.height
        ),
    ]

    const xs = corners.map((p) => p[0] as number)
    const ys = corners.map((p) => p[1] as number)
    const x = Math.min(...xs)
    const y = Math.min(...ys)

    // Reading direction in viewport space, taken from the start and end points
    // rather than from the matrix, so the viewport's own flip is accounted for.
    const [startScreenX = 0, startScreenY = 0] = corners[0] ?? []
    const [endScreenX = 0, endScreenY = 0] = corners[1] ?? []
    const readMag = Math.hypot(endScreenX - startScreenX, endScreenY - startScreenY) || 1

    return {
        text: item.str,
        score: TEXT_LAYER_SCORE,
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.max(1, Math.ceil(Math.max(...xs) - x)),
        height: Math.max(1, Math.ceil(Math.max(...ys) - y)),
        angle: 0,
        readDirX: (endScreenX - startScreenX) / readMag,
        readDirY: (endScreenY - startScreenY) / readMag,
        fontName: item.fontName ?? '',
    }
}

/** Extract every text item on a page as a viewport-space box. */
export async function extractTextBoxes(
    page: { getTextContent(): Promise<{ items: unknown[] }> },
    viewport: ViewportLike
): Promise<TextBox[]> {
    const content = await page.getTextContent()
    const boxes: TextBox[] = []
    for (const item of content.items) {
        if (!isTextItem(item)) continue
        const box = textItemToBox(item, viewport)
        if (box) boxes.push(box)
    }
    return boxes
}
