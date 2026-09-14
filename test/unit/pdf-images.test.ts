import { describe, expect, it } from 'vitest'
import {
    applyMatrix,
    boxToPage,
    collectImagePlacements,
    type ImageOpCodes,
    type Matrix,
    multiplyMatrix,
    placementMap,
    type RawImagePlacement,
    toImagePlacement,
} from '../../src/pdf/extract-images.js'
import { pageIndexes } from '../../src/pdf/pdf-to-image.js'

/**
 * A stand-in for `pdfjs.OPS`. The real numbers are an implementation detail of
 * the installed version, which is exactly why the walk takes them as an argument.
 */
const OPS: ImageOpCodes = {
    save: 10,
    restore: 11,
    transform: 12,
    paintFormXObjectBegin: 74,
    paintFormXObjectEnd: 75,
    beginGroup: 76,
    endGroup: 77,
    beginAnnotation: 80,
    endAnnotation: 81,
    paintImageXObject: 85,
    paintInlineImageXObject: 86,
    paintInlineImageXObjectGroup: 87,
    paintImageXObjectRepeat: 88,
}

/**
 * A pdf.js viewport transform at scale 1 for an 800pt-tall page: the usual
 * y-flip, since PDF user space has y increasing upward.
 */
const flip = (height = 800): Matrix => [1, 0, 0, -1, 0, height]

/** The single placement a one-image operator list produces. */
function only(entries: [number, unknown[] | null][], viewport: Matrix = flip()): RawImagePlacement {
    const found = collectImagePlacements(ops(entries), OPS, viewport)
    if (found.length !== 1) throw new Error(`expected one placement, got ${found.length}`)
    return found[0] as RawImagePlacement
}

function ops(entries: [number, unknown[] | null][]) {
    return {
        fnArray: entries.map(([fn]) => fn),
        argsArray: entries.map(([, args]) => args),
    }
}

describe('multiplyMatrix', () => {
    it('applies the second matrix first, as ctx.transform does', () => {
        const scale: Matrix = [2, 0, 0, 2, 0, 0]
        const move: Matrix = [1, 0, 0, 1, 10, 0]

        // Translate then scale: the translation is scaled too.
        expect(applyMatrix(multiplyMatrix(scale, move), 0, 0)).toEqual([20, 0])
        // Scale then translate: it is not.
        expect(applyMatrix(multiplyMatrix(move, scale), 0, 0)).toEqual([10, 0])
    })
})

describe('collectImagePlacements', () => {
    it('composes the viewport transform with the running one', () => {
        const found = collectImagePlacements(
            ops([
                [OPS.save, null],
                [OPS.transform, [100, 0, 0, 200, 50, 600]],
                [OPS.paintImageXObject, ['img_p0_3']],
                [OPS.restore, null],
            ]),
            OPS,
            flip()
        )

        expect(found).toHaveLength(1)
        expect(found[0]?.id).toBe('img_p0_3')
        // Unit (0,0) is the image's bottom-left: user (50, 600) -> viewport y 200.
        expect(applyMatrix(found[0]?.unitMatrix as Matrix, 0, 0)).toEqual([50, 200])
        // Unit (1,1) is its top-right: user (150, 800) -> viewport y 0.
        expect(applyMatrix(found[0]?.unitMatrix as Matrix, 1, 1)).toEqual([150, 0])
    })

    it('restores the transform after a save/restore pair', () => {
        const found = collectImagePlacements(
            ops([
                [OPS.save, null],
                [OPS.transform, [1, 0, 0, 1, 500, 500]],
                [OPS.restore, null],
                [OPS.transform, [10, 0, 0, 10, 0, 0]],
                [OPS.paintImageXObject, ['a']],
            ]),
            OPS,
            flip()
        )
        expect(applyMatrix(found[0]?.unitMatrix as Matrix, 0, 0)).toEqual([0, 800])
    })

    it('treats paintFormXObjectBegin as a save plus a transform', () => {
        // Most stamped content lives inside a form XObject. Ignoring its matrix
        // puts every image it paints somewhere else on the page entirely.
        const found = collectImagePlacements(
            ops([
                [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 200, 300], null]],
                [OPS.transform, [10, 0, 0, 10, 0, 0]],
                [OPS.paintImageXObject, ['inside']],
                [OPS.paintFormXObjectEnd, null],
                [OPS.paintImageXObject, ['outside']],
            ]),
            OPS,
            flip()
        )

        expect(found.map((f) => f.id)).toEqual(['inside', 'outside'])
        expect(applyMatrix(found[0]?.unitMatrix as Matrix, 0, 0)).toEqual([200, 500])
        expect(applyMatrix(found[1]?.unitMatrix as Matrix, 0, 0)).toEqual([0, 800])
    })

    it('emits one placement per tile of a repeated image', () => {
        const found = collectImagePlacements(
            ops([[OPS.paintImageXObjectRepeat, ['tile', 4, 4, [0, 0, 10, 20]]]]),
            OPS,
            flip()
        )
        expect(found).toHaveLength(2)
        expect(found.every((f) => f.id === 'tile')).toBe(true)
        expect(applyMatrix(found[1]?.unitMatrix as Matrix, 0, 0)).toEqual([10, 780])
    })

    it('carries an inline image’s own data and leaves its id empty', () => {
        const data = { width: 2, height: 2, kind: 3, data: new Uint8ClampedArray(16) }
        const found = collectImagePlacements(ops([[OPS.paintInlineImageXObject, [data]]]), OPS, flip())
        expect(found[0]?.id).toBe('')
        expect(found[0]?.inlineData).toBe(data)
    })

    it('ignores operators it does not know, image masks included', () => {
        const found = collectImagePlacements(ops([[99, ['mask']]]), OPS, flip())
        expect(found).toEqual([])
    })

    it('treats a transparency group as a bare save and restore', () => {
        // beginGroup opens with save() and returns before group.matrix is
        // applied -- the matrix arrives as the next paintFormXObjectBegin. Both
        // applying it here and ignoring the pair entirely are wrong: the first
        // doubles it, the second lets an inner transform leak past endGroup.
        const found = collectImagePlacements(
            ops([
                [OPS.beginGroup, [{ matrix: [5, 0, 0, 5, 0, 0] }]],
                [OPS.transform, [1, 0, 0, 1, 100, 100]],
                [OPS.endGroup, [{}]],
                [OPS.paintImageXObject, ['after']],
            ]),
            OPS,
            flip()
        )
        expect(applyMatrix(found[0]?.unitMatrix as Matrix, 0, 0)).toEqual([0, 800])
    })

    it('discards the running transform at an annotation, as pdf.js does', () => {
        const found = collectImagePlacements(
            ops([
                [OPS.transform, [9, 0, 0, 9, 700, 700]],
                [OPS.beginAnnotation, ['id', [0, 0, 10, 10], [1, 0, 0, 1, 20, 30], [2, 0, 0, 2, 0, 0]]],
                [OPS.paintImageXObject, ['stamp']],
                [OPS.endAnnotation, null],
                [OPS.paintImageXObject, ['page']],
            ]),
            OPS,
            flip()
        )

        // transform then matrix, from the page base -- not from the 9x scale.
        expect(applyMatrix(found[0]?.unitMatrix as Matrix, 1, 0)).toEqual([22, 770])
        // and the page's own transform is back afterwards.
        expect(applyMatrix(found[1]?.unitMatrix as Matrix, 0, 0)).toEqual([700, 100])
    })

    it('emits one placement per entry of a grouped inline image', () => {
        const data = { width: 8, height: 8, kind: 3, data: new Uint8ClampedArray(256) }
        const found = collectImagePlacements(
            ops([
                [
                    OPS.paintInlineImageXObjectGroup,
                    [data, [{ transform: [4, 0, 0, 4, 0, 0], x: 0, y: 0, w: 8, h: 8 }]],
                ],
            ]),
            OPS,
            flip()
        )
        expect(found).toHaveLength(1)
        expect(found[0]?.sub).toEqual({ x: 0, y: 0, width: 8, height: 8 })
        expect(found[0]?.inlineData).toBe(data)
    })
})

describe('toImagePlacement', () => {
    const raw = only([
        [OPS.transform, [100, 0, 0, 200, 50, 600]],
        [OPS.paintImageXObject, ['img']],
    ])

    it('flips the image’s y against the unit square', () => {
        const placement = toImagePlacement(raw, 10, 20, 72)
        const map = placementMap(placement)

        // Image pixel (0,0) is its top-left, which is the unit square's (0,1).
        expect(map(0, 0)).toEqual([50, 0])
        expect(map(10, 20)).toEqual([150, 200])
    })

    it('derives an axis-aligned box from the mapped corners', () => {
        const { box } = toImagePlacement(raw, 10, 20, 72)
        expect(box).toMatchObject({ x: 50, y: 0, width: 100, height: 200, angle: 0 })
    })

    it('reports the DPI the image is placed at, not the page’s', () => {
        // 10 native pixels spread over 100 page pixels rendered at 72 DPI: the
        // image contributes a tenth of the page's detail.
        const placement = toImagePlacement(raw, 10, 20, 72)
        expect(placement.effectiveResolution).toBeCloseTo(7.2, 6)
    })

    it('keeps a genuinely skewed placement rotated', () => {
        // A quarter turn is not a rotation as far as a Box is concerned -- a
        // rectangle turned 90 degrees is still axis-aligned -- so this uses 30.
        const cos = Math.cos(Math.PI / 6)
        const sin = Math.sin(Math.PI / 6)
        const rotated = only([
            [OPS.transform, [200 * cos, 200 * sin, -100 * sin, 100 * cos, 300, 300]],
            [OPS.paintImageXObject, ['img']],
        ])
        const { box } = toImagePlacement(rotated, 10, 20, 72)
        expect(Math.abs(box.angle)).toBeGreaterThan(3)
    })

    it('reports a quarter turn as axis-aligned, because it is', () => {
        const turned = only([
            [OPS.transform, [0, 100, -200, 0, 400, 400]],
            [OPS.paintImageXObject, ['img']],
        ])
        expect(toImagePlacement(turned, 10, 20, 72).box.angle).toBe(0)
    })
})

describe('boxToPage', () => {
    const raw = only([
        [OPS.transform, [100, 0, 0, 200, 50, 600]],
        [OPS.paintImageXObject, ['img']],
    ])

    it('maps a word box out of image pixels and onto the page', () => {
        const placement = toImagePlacement(raw, 10, 20, 72)
        const page = boxToPage(
            { text: 'hi', score: 0.8, x: 0, y: 0, width: 5, height: 10, angle: 0 },
            placement
        )

        expect(page).toMatchObject({ text: 'hi', score: 0.8, x: 50, y: 0, width: 50, height: 100 })
    })

    it('keeps a word a recognizer read on the slant slanted', () => {
        // A Box is a rotated rect, so reading x/y/width/height as a rectangle
        // discards the angle and every skewed word comes back level.
        const placement = toImagePlacement(raw, 10, 20, 72)
        const slanted = boxToPage(
            { text: 'skew', score: 1, x: 2, y: 4, width: 4, height: 2, angle: 30 },
            placement
        )
        expect(Math.abs(slanted.angle)).toBeGreaterThan(3)
    })

    it('leaves an upright word upright', () => {
        const placement = toImagePlacement(raw, 10, 20, 72)
        const upright = boxToPage(
            { text: 'flat', score: 1, x: 2, y: 4, width: 4, height: 2, angle: 0 },
            placement
        )
        expect(upright.angle).toBe(0)
    })

    it('divides out an upscale applied before recognition', () => {
        // The image was doubled to give a recognizer more to work with, so its
        // boxes are in doubled pixels and must come back down.
        const placement = toImagePlacement(raw, 10, 20, 72, 2)
        const page = boxToPage({ text: '', score: 1, x: 0, y: 0, width: 20, height: 40, angle: 0 }, placement)

        expect(page).toMatchObject({ x: 50, y: 0, width: 100, height: 200 })
    })
})

describe('pageIndexes', () => {
    it('reads the whole document when the row names no page', () => {
        expect(pageIndexes(undefined, 3, 0)).toEqual([0, 1, 2])
        expect(pageIndexes(undefined, 5, 2)).toEqual([0, 1])
    })

    it('reads only the page the row already names', () => {
        // Two expanding PDF stages over one file would otherwise square the row
        // count -- five pages through two of them becoming twenty-five rows.
        expect(pageIndexes(2, 5, 0)).toEqual([2])
        // The page limit is the first stage's business, not the second's.
        expect(pageIndexes(4, 5, 2)).toEqual([4])
    })

    it('drops a page index the document does not have', () => {
        expect(pageIndexes(9, 3, 0)).toEqual([])
    })

    it('ignores a page column holding something that is not an index', () => {
        expect(pageIndexes('cover', 2, 0)).toEqual([0, 1])
        expect(pageIndexes(-1, 2, 0)).toEqual([0, 1])
        expect(pageIndexes(1.5, 2, 0)).toEqual([0, 1])
    })
})
